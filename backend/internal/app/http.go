package app

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"hilink-sms-manager/internal/config"
	"hilink-sms-manager/internal/sms"
)

type deleter interface {
	Delete(context.Context, string) error
}
type reader interface {
	MarkRead(context.Context, string) error
}
type rebooter interface {
	Reboot(context.Context) error
}
type HTTP struct {
	cfg      config.Config
	store    *sms.Store
	modem    deleter
	static   fs.FS
	logger   *slog.Logger
	trusted  []*net.IPNet
	mu       sync.Mutex
	attempts map[string][]time.Time
	revoked  map[string]int64
}

func NewHTTP(c config.Config, s *sms.Store, m deleter, static fs.FS, l *slog.Logger) http.Handler {
	h := &HTTP{cfg: c, store: s, modem: m, static: static, logger: l, attempts: map[string][]time.Time{}, revoked: map[string]int64{}}
	for _, part := range strings.Split(c.TrustedProxy, ",") {
		if _, n, e := net.ParseCIDR(strings.TrimSpace(part)); e == nil {
			h.trusted = append(h.trusted, n)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/api/auth/login", h.login)
	mux.HandleFunc("/api/auth/logout", h.logout)
	mux.HandleFunc("/api/auth/session", h.session)
	mux.HandleFunc("/api/sms", h.protect(h.messages))
	mux.HandleFunc("/api/sms/", h.protect(h.message))
	mux.HandleFunc("/api/device/reboot", h.protect(h.reboot))
	mux.HandleFunc("/api/status", h.protect(h.status))
	mux.Handle("/", http.FileServer(http.FS(static)))
	return h.secureHeaders(h.accessLog(mux))
}

type accessLogWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *accessLogWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *accessLogWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += n
	return n, err
}

func (h *HTTP) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		logged := &accessLogWriter{ResponseWriter: w}
		next.ServeHTTP(logged, r)
		status := logged.status
		if status == 0 {
			status = http.StatusOK
		}
		h.logger.Info("http request", "method", r.Method, "path", r.URL.Path, "status", status, "bytes", logged.bytes, "duration_ms", time.Since(started).Seconds()*1000)
	})
}
func (h *HTTP) secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if h.secureRequest(r) {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}
func (h *HTTP) secureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return h.isTrusted(r) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
func (h *HTTP) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	scheme := "http"
	if h.secureRequest(r) {
		scheme = "https"
	}
	host := r.Host
	if h.isTrusted(r) {
		if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
			host = fh
		}
	}
	return origin == scheme+"://"+host
}
func (h *HTTP) isTrusted(r *http.Request) bool {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	for _, n := range h.trusted {
		if ip != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}
func (h *HTTP) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		method(w, http.MethodPost)
		return
	}
	if !h.sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !allowedJSON(r, w) {
		return
	}
	ip := clientIP(r)
	if h.limited(ip) {
		h.jsonError(w, http.StatusTooManyRequests, "Too many attempts. Try again later.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		h.jsonError(w, http.StatusBadRequest, "Invalid request.")
		return
	}
	userOK := subtle.ConstantTimeCompare([]byte(input.Username), []byte(h.cfg.AuthUsername)) == 1
	passErr := bcrypt.CompareHashAndPassword([]byte(h.cfg.AuthPasswordHash), []byte(input.Password))
	if !userOK || passErr != nil {
		h.logger.Warn("application login failed", "remote", ip)
		h.jsonError(w, http.StatusUnauthorized, "Invalid username or password.")
		return
	}
	h.clearAttempts(ip)
	expires := time.Now().Add(h.cfg.SessionTTL)
	value, sid, err := h.sign(expires.Unix())
	if err != nil {
		h.jsonError(w, http.StatusInternalServerError, "Could not create a session.")
		return
	}
	h.mu.Lock()
	now := time.Now().Unix()
	for old, exp := range h.revoked {
		if exp < now {
			delete(h.revoked, old)
		}
	}
	h.mu.Unlock()
	_ = sid
	http.SetCookie(w, &http.Cookie{Name: "hilink_session", Value: value, Path: "/", Expires: expires, MaxAge: int(h.cfg.SessionTTL.Seconds()), HttpOnly: true, Secure: h.secureRequest(r), SameSite: http.SameSiteStrictMode})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}
func (h *HTTP) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		method(w, http.MethodPost)
		return
	}
	if !h.sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if c, err := r.Cookie("hilink_session"); err == nil {
		if sid, exp, ok := h.sessionID(c.Value); ok {
			h.mu.Lock()
			h.revoked[sid] = exp
			h.mu.Unlock()
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "hilink_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: h.secureRequest(r), SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": false})
}
func (h *HTTP) session(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		method(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"authenticated": h.valid(r)})
}
func (h *HTTP) protect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.valid(r) {
			h.jsonError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		if r.Method != "GET" && !h.sameOrigin(r) {
			h.jsonError(w, http.StatusForbidden, "Request origin rejected.")
			return
		}
		next(w, r)
	}
}
func (h *HTTP) messages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		method(w, http.MethodGet)
		return
	}
	messages := h.store.List()
	for i := range messages {
		messages[i] = h.withContactName(messages[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages, "status": h.store.Status()})
}
func (h *HTTP) withContactName(message sms.Message) sms.Message {
	if name, ok := h.cfg.AddressBook[message.Sender]; ok {
		message.SenderName = name
		return message
	}
	normalized := normalizePhone(message.Sender)
	if normalized != "" {
		for number, name := range h.cfg.AddressBook {
			if normalizePhone(number) == normalized {
				message.SenderName = name
				break
			}
		}
	}
	return message
}
func normalizePhone(value string) string {
	var normalized strings.Builder
	for _, r := range value {
		if (r >= '0' && r <= '9') || r == '+' {
			normalized.WriteRune(r)
		}
	}
	return normalized.String()
}
func (h *HTTP) message(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/sms/")
	markRead := strings.HasSuffix(id, "/read")
	if markRead {
		id = strings.TrimSuffix(id, "/read")
	}
	if id == "" || strings.Contains(id, "/") {
		http.NotFound(w, r)
		return
	}
	if markRead {
		if r.Method != http.MethodPost {
			method(w, http.MethodPost)
			return
		}
		m, ok := h.store.Get(id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		if m.Read {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		modem, ok := h.modem.(reader)
		if !ok {
			h.jsonError(w, http.StatusNotImplemented, "The modem does not support read-state updates.")
			return
		}
		if err := modem.MarkRead(r.Context(), id); err != nil {
			h.logger.Warn("SMS read-state update failed", "error", err)
			h.jsonError(w, http.StatusBadGateway, "The modem could not mark this message as read.")
			return
		}
		h.store.MarkRead(id)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodDelete {
		method(w, http.MethodGet+", "+http.MethodDelete)
		return
	}
	m, ok := h.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodDelete {
		if err := h.modem.Delete(r.Context(), id); err != nil {
			h.logger.Warn("SMS deletion failed", "error", err)
			h.jsonError(w, http.StatusBadGateway, "The modem could not delete this message.")
			return
		}
		h.store.Remove(id)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, h.withContactName(m))
}
func (h *HTTP) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		method(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, h.store.Status())
}
func (h *HTTP) reboot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		method(w, http.MethodPost)
		return
	}
	modem, ok := h.modem.(rebooter)
	if !ok {
		h.jsonError(w, http.StatusNotImplemented, "The modem does not support reboot.")
		return
	}
	if err := modem.Reboot(r.Context()); err != nil {
		h.logger.Warn("modem reboot failed", "error", err)
		h.jsonError(w, http.StatusBadGateway, "The modem could not be rebooted.")
		return
	}
	w.WriteHeader(http.StatusAccepted)
}
func (h *HTTP) valid(r *http.Request) bool {
	c, e := r.Cookie("hilink_session")
	if e != nil {
		return false
	}
	sid, exp, ok := h.sessionID(c.Value)
	if !ok || time.Now().Unix() >= exp {
		return false
	}
	h.mu.Lock()
	_, revoked := h.revoked[sid]
	h.mu.Unlock()
	return !revoked
}
func (h *HTTP) sessionID(value string) (string, int64, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return "", 0, false
	}
	payload, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return "", 0, false
	}
	mac := hmac.New(sha256.New, []byte(h.cfg.SessionSecret))
	_, _ = mac.Write(payload)
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return "", 0, false
	}
	bits := strings.SplitN(string(payload), ":", 2)
	if len(bits) != 2 {
		return "", 0, false
	}
	exp, e := strconv.ParseInt(bits[0], 10, 64)
	if e != nil || bits[1] == "" {
		return "", 0, false
	}
	return bits[1], exp, true
}
func (h *HTTP) sign(exp int64) (string, string, error) {
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", "", err
	}
	sid := base64.RawURLEncoding.EncodeToString(nonce)
	payload := []byte(strconv.FormatInt(exp, 10) + ":" + sid)
	mac := hmac.New(sha256.New, []byte(h.cfg.SessionSecret))
	_, _ = mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), sid, nil
}
func (h *HTTP) limited(ip string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	items := h.attempts[ip][:0]
	for _, t := range h.attempts[ip] {
		if now.Sub(t) < 5*time.Minute {
			items = append(items, t)
		}
	}
	h.attempts[ip] = append(items, now)
	return len(h.attempts[ip]) > 5
}
func (h *HTTP) clearAttempts(ip string) { h.mu.Lock(); delete(h.attempts, ip); h.mu.Unlock() }
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func allowedJSON(r *http.Request, w http.ResponseWriter) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
		return false
	}
	return true
}
func (h *HTTP) jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func method(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}
