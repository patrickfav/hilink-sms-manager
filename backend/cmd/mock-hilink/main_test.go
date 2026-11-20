package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"hilink-sms-manager/internal/hilink"
	"hilink-sms-manager/internal/sms"
)

func TestMockSupportsClientLoginListInjectionAndDelete(t *testing.T) {
	server := httptest.NewServer(newModem().routes())
	defer server.Close()
	client := hilink.New(server.URL, "admin", "mock-password")
	ctx := context.Background()

	messages, err := client.List(ctx)
	if err != nil || len(messages) != 0 {
		t.Fatalf("initial List() = %v, %v; want empty list", messages, err)
	}

	payload, err := json.Marshal(map[string]any{
		"sender": "+1 555 0100", "text": "Grüß dich, code 482913", "receivedAt": time.Date(2026, 11, 14, 9, 30, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(server.URL+"/__mock/messages", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("inject status = %d; want %d", response.StatusCode, http.StatusCreated)
	}

	messages, err = client.List(ctx)
	if err != nil || len(messages) != 1 {
		t.Fatalf("List() after injection = %v, %v; want one message", messages, err)
	}
	if messages[0].ID != sms.PublicID("1") || messages[0].ModemID != "1" || messages[0].Text != "Grüß dich, code 482913" || messages[0].Read {
		t.Fatalf("unexpected mocked message: %#v", messages[0])
	}
	if err := client.Delete(ctx, messages[0].ModemID); err != nil {
		t.Fatal(err)
	}
	messages, err = client.List(ctx)
	if err != nil || len(messages) != 0 {
		t.Fatalf("List() after delete = %v, %v; want empty list", messages, err)
	}
}
