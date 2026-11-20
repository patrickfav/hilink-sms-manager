// Command mock-hilink provides a local, in-memory subset of the Huawei HiLink
// HTTP/XML API for development without a modem. It is not a firmware emulator.
package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const verificationToken = "local-mock-token"

type message struct {
	Index      int       `json:"index"`
	Sender     string    `json:"sender"`
	Text       string    `json:"text"`
	ReceivedAt time.Time `json:"receivedAt"`
	Read       bool      `json:"read"`
}

type modem struct {
	mu        sync.RWMutex
	nextID    int
	messages  []message
	publicKey *rsa.PrivateKey
}

func newModem() *modem {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return &modem{nextID: 1, publicKey: key}
}

func (m *modem) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /__mock/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"description": "Local HiLink API mock; inject a message with POST /__mock/messages.",
			"messages":    "GET /__mock/messages",
		})
	})
	mux.HandleFunc("GET /__mock/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /__mock/messages", m.listJSON)
	mux.HandleFunc("POST /__mock/messages", m.inject)
	mux.HandleFunc("GET /api/webserver/SesTokInfo", m.session)
	mux.HandleFunc("GET /api/webserver/publickey", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
		_, _ = fmt.Fprintf(w, "<response><encpubkeye>%x</encpubkeye><encpubkeyn>%s</encpubkeyn></response>", m.publicKey.PublicKey.E, m.publicKey.PublicKey.N.Text(16))
	})
	mux.HandleFunc("GET /api/user/state-login", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
		w.Header().Set("__RequestVerificationToken", verificationToken)
		_, _ = io.WriteString(w, `<response><State>0</State><Challenge>local-mock-challenge</Challenge></response>`)
	})
	mux.HandleFunc("POST /api/device/control", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
		w.Header().Set("__RequestVerificationToken", verificationToken)
		_, _ = io.WriteString(w, `<response>OK</response>`)
	})
	mux.HandleFunc("GET /api/sms/sms-count", func(w http.ResponseWriter, r *http.Request) {
		m.mu.RLock()
		count := len(m.messages)
		m.mu.RUnlock()
		w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
		w.Header().Set("__RequestVerificationToken", verificationToken)
		_, _ = fmt.Fprintf(w, `<response><LocalInbox>%d</LocalInbox><LocalUnread>0</LocalUnread></response>`, count)
	})
	mux.HandleFunc("GET /api/monitoring/check-notifications", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
		w.Header().Set("__RequestVerificationToken", verificationToken)
		_, _ = io.WriteString(w, `<response><SmsStorageFull>0</SmsStorageFull></response>`)
	})
	mux.HandleFunc("POST /api/user/login", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
		w.Header().Set("__RequestVerificationToken", verificationToken)
		_, _ = io.WriteString(w, `<response>OK</response>`)
	})
	mux.HandleFunc("POST /api/sms/sms-list", m.listXML)
	mux.HandleFunc("POST /api/sms/set-read", m.setRead)
	mux.HandleFunc("POST /api/sms/delete-sms", m.delete)
	return mux
}

func (m *modem) session(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "SessionID", Value: "local-mock", Path: "/", HttpOnly: true})
	w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
	w.Header().Set("__RequestVerificationToken", verificationToken)
	_, _ = io.WriteString(w, `<response><TokInfo>`+verificationToken+`</TokInfo><SesInfo>SessionID=local-mock</SesInfo></response>`)
}

func (m *modem) listJSON(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	items := append([]message(nil), m.messages...)
	m.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].ReceivedAt.After(items[j].ReceivedAt) })
	writeJSON(w, http.StatusOK, items)
}

func (m *modem) inject(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var input struct {
		Sender     string    `json:"sender"`
		Text       string    `json:"text"`
		ReceivedAt time.Time `json:"receivedAt"`
		Read       bool      `json:"read"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || strings.TrimSpace(input.Sender) == "" || strings.TrimSpace(input.Text) == "" {
		http.Error(w, `{"error":"sender and text are required"}`, http.StatusBadRequest)
		return
	}
	if input.ReceivedAt.IsZero() {
		input.ReceivedAt = time.Now()
	}
	m.mu.Lock()
	item := message{Index: m.nextID, Sender: input.Sender, Text: input.Text, ReceivedAt: input.ReceivedAt, Read: input.Read}
	m.nextID++
	m.messages = append(m.messages, item)
	m.mu.Unlock()
	writeJSON(w, http.StatusCreated, item)
}

func (m *modem) listXML(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var request struct {
		PageIndex int `xml:"PageIndex"`
		ReadCount int `xml:"ReadCount"`
	}
	if err := xml.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid XML request", http.StatusBadRequest)
		return
	}
	if request.PageIndex < 1 {
		request.PageIndex = 1
	}
	if request.ReadCount < 1 || request.ReadCount > 100 {
		request.ReadCount = 20
	}
	m.mu.RLock()
	items := append([]message(nil), m.messages...)
	m.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].ReceivedAt.After(items[j].ReceivedAt) })
	start := (request.PageIndex - 1) * request.ReadCount
	if start > len(items) {
		start = len(items)
	}
	end := start + request.ReadCount
	if end > len(items) {
		end = len(items)
	}
	type xmlMessage struct {
		Index   int    `xml:"Index"`
		Phone   string `xml:"Phone"`
		Content string `xml:"Content"`
		Date    string `xml:"Date"`
		Smstat  int    `xml:"Smstat"`
	}
	response := struct {
		XMLName   xml.Name     `xml:"response"`
		Count     int          `xml:"Count"`
		PageCount int          `xml:"PageCount"`
		Messages  []xmlMessage `xml:"Messages>Message"`
	}{Count: end - start, PageCount: (len(items) + request.ReadCount - 1) / request.ReadCount}
	for _, item := range items[start:end] {
		read := 0
		if item.Read {
			read = 1
		}
		response.Messages = append(response.Messages, xmlMessage{
			Index: item.Index, Phone: item.Sender, Content: item.Text,
			Date: item.ReceivedAt.In(time.Local).Format("2006-01-02 15:04:05"), Smstat: read,
		})
	}
	w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
	w.Header().Set("__RequestVerificationToken", verificationToken)
	_ = xml.NewEncoder(w).Encode(response)
}

func (m *modem) delete(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var request struct {
		Index int `xml:"Index"`
	}
	if err := xml.NewDecoder(r.Body).Decode(&request); err != nil || request.Index < 1 {
		http.Error(w, "invalid XML request", http.StatusBadRequest)
		return
	}
	m.mu.Lock()
	found := false
	for i, item := range m.messages {
		if item.Index == request.Index {
			m.messages = append(m.messages[:i], m.messages[i+1:]...)
			found = true
			break
		}
	}
	m.mu.Unlock()
	if !found {
		http.Error(w, "message not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
	w.Header().Set("__RequestVerificationToken", verificationToken)
	_, _ = io.WriteString(w, `<response>OK</response>`)
}

func (m *modem) setRead(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var request struct {
		Index int `xml:"Index"`
	}
	if err := xml.NewDecoder(r.Body).Decode(&request); err != nil || request.Index < 1 {
		http.Error(w, "invalid XML request", http.StatusBadRequest)
		return
	}
	m.mu.Lock()
	found := false
	for i := range m.messages {
		if m.messages[i].Index == request.Index {
			m.messages[i].Read = true
			found = true
			break
		}
	}
	m.mu.Unlock()
	if !found {
		http.Error(w, "message not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/xml; charset=UTF-8")
	w.Header().Set("__RequestVerificationToken", verificationToken)
	_, _ = io.WriteString(w, `<response>OK</response>`)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func main() {
	addr := os.Getenv("MOCK_HILINK_ADDR")
	if addr == "" {
		addr = "127.0.0.1:18080"
	}
	server := &http.Server{
		Addr: addr, Handler: newModem().routes(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	slog.Info("local HiLink mock listening", "addr", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("HiLink mock stopped", "error", fmt.Errorf("listen: %w", err))
		os.Exit(1)
	}
}
