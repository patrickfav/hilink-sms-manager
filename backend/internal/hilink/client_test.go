package hilink

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseDate(t *testing.T) {
	got, err := parseDate("2025-02-03 04:05:06")
	if err != nil || got.Format(time.RFC3339) != "2025-02-03T04:05:06Z" {
		t.Fatalf("parseDate() = %v, %v", got, err)
	}
	if _, err := parseDate("not a date"); err == nil {
		t.Fatal("expected invalid date to fail")
	}
}

func TestListPaginatesUnicodeAndDeleteUsesModemIndex(t *testing.T) {
	var pages atomic.Int32
	var deleted atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/webserver/SesTokInfo":
			w.Header().Add("Set-Cookie", "SessionID=mock")
			io.WriteString(w, `<response><TokInfo>token-0</TokInfo><SesInfo>SessionID=mock</SesInfo></response>`)
		case "/api/user/state-login":
			io.WriteString(w, `<response><State>0</State><Challenge>nonce</Challenge></response>`)
		case "/api/user/login":
			body, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(body), "<Username>admin</Username>") || !strings.Contains(string(body), "<Password>") {
				t.Errorf("unexpected login body: %s", body)
			}
			w.Header().Set("__RequestVerificationToken", "token-1")
			io.WriteString(w, `<response>OK</response>`)
		case "/api/sms/sms-list":
			body, _ := io.ReadAll(r.Body)
			if strings.Contains(string(body), "<PageIndex>1</PageIndex>") {
				pages.Add(1)
				io.WriteString(w, `<response><Count>1</Count><Messages><Message><Index>41</Index><Smstat>0</Smstat><Phone>+431</Phone><Content>Grüß dich – code 123456</Content><Date>2025-02-03 04:05:06</Date></Message></Messages></response>`)
				return
			}
			if strings.Contains(string(body), "<PageIndex>2</PageIndex>") {
				pages.Add(1)
			}
			io.WriteString(w, `<response><Count>0</Count><Messages></Messages></response>`)
		case "/api/sms/delete-sms":
			body, _ := io.ReadAll(r.Body)
			if strings.Contains(string(body), "<Index>41</Index>") {
				deleted.Add(1)
			}
			io.WriteString(w, `<response>OK</response>`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := New(server.URL, "admin", "secret")
	messages, err := client.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Text != "Grüß dich – code 123456" || messages[0].Read {
		t.Fatalf("unexpected SMS result: %#v", messages)
	}
	if pages.Load() != 2 {
		t.Fatalf("made %d SMS-list requests, expected 2 pages", pages.Load())
	}
	if err := client.Delete(context.Background(), "41"); err != nil {
		t.Fatal(err)
	}
	if deleted.Load() != 1 {
		t.Fatal("modem delete endpoint did not receive the message index")
	}
}
