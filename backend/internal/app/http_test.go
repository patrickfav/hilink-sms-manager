package app

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"golang.org/x/crypto/bcrypt"
	"hilink-sms-manager/internal/config"
	"hilink-sms-manager/internal/sms"
)

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("correct horse"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{AuthUsername: "test", AuthPasswordHash: string(hash), SessionSecret: strings.Repeat("s", 32), SessionTTL: time.Hour}
	return NewHTTP(cfg, sms.NewStore(), nil, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
}

func TestUnauthenticatedAPIAndSecurityHeaders(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/sms", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if recorder.Header().Get("Content-Security-Policy") == "" || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("security headers were not set")
	}
}

func TestSPARoutesServeIndex(t *testing.T) {
	recorder := httptest.NewRecorder()
	testHandler(t).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/sms/123", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "ok" {
		t.Fatalf("SPA route response = %d %q, want 200 index", recorder.Code, recorder.Body.String())
	}
}

func TestLoginCSRFLogoutAndInvalidation(t *testing.T) {
	handler := testHandler(t)
	request := func(path, origin string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		return recorder
	}
	badOrigin := request("/api/auth/login", "https://attacker.invalid", []byte(`{"username":"test","password":"correct horse"}`))
	if badOrigin.Code != http.StatusForbidden {
		t.Fatalf("cross-site login status = %d, want 403", badOrigin.Code)
	}
	wrong := request("/api/auth/login", "", []byte(`{"username":"test","password":"wrong"}`))
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("invalid login status = %d, want 401", wrong.Code)
	}
	login := request("/api/auth/login", "", []byte(`{"username":"test","password":"correct horse"}`))
	if login.Code != http.StatusOK {
		t.Fatalf("login status = %d, want 200: %s", login.Code, login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("insecure session cookie: %#v", cookies)
	}
	probe := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	probe.AddCookie(cookies[0])
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, probe)
	var session struct {
		Authenticated bool `json:"authenticated"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &session)
	if !session.Authenticated {
		t.Fatal("login did not create an authenticated session")
	}
	logout := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	logout.AddCookie(cookies[0])
	logoutRec := httptest.NewRecorder()
	handler.ServeHTTP(logoutRec, logout)
	probe = httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	probe.AddCookie(cookies[0])
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, probe)
	_ = json.Unmarshal(recorder.Body.Bytes(), &session)
	if session.Authenticated {
		t.Fatal("logout did not invalidate the old session cookie")
	}
}

func TestLoginRateLimit(t *testing.T) {
	handler := testHandler(t)
	for attempt := 1; attempt <= 6; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"test","password":"wrong"}`))
		req.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		want := http.StatusUnauthorized
		if attempt == 6 {
			want = http.StatusTooManyRequests
		}
		if recorder.Code != want {
			t.Fatalf("attempt %d status = %d, want %d", attempt, recorder.Code, want)
		}
	}
}

func TestModemIndexPrefersPhysicalIndexOverPublicID(t *testing.T) {
	if got := modemIndex(sms.Message{ID: "external-id", Index: 41}); got != "41" {
		t.Fatalf("modemIndex() = %q, want 41", got)
	}
	if got := modemIndex(sms.Message{ID: "41"}); got != "41" {
		t.Fatalf("modemIndex() fallback = %q, want 41", got)
	}
}
