package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"hilink-sms-manager/internal/sms"
)

type fakeModem struct {
	mu              sync.Mutex
	messages        []sms.Message
	err             error
	deviceInfoCalls int
}

func (m *fakeModem) List(context.Context) ([]sms.Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]sms.Message(nil), m.messages...), m.err
}
func (*fakeModem) Delete(context.Context, string) error { return nil }
func (m *fakeModem) DeviceInfo(context.Context) (sms.DeviceInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deviceInfoCalls++
	return sms.DeviceInfo{DeviceName: "E8372"}, nil
}

func TestDeviceInformationIsLoadedOnlyDuringInitialPoll(t *testing.T) {
	modem := &fakeModem{messages: []sms.Message{{ID: "1"}}}
	service := NewService(modem, sms.NewStore(), NewForwarder(false, ""), time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	service.poll(context.Background(), true)
	service.poll(context.Background(), false)
	modem.mu.Lock()
	calls := modem.deviceInfoCalls
	modem.mu.Unlock()
	if calls != 1 {
		t.Fatalf("device information requested %d times, want 1", calls)
	}
}

func TestPollingBaselinesAfterInitialFailureAndForwardsNewOnce(t *testing.T) {
	deliveries := make(chan string, 4)
	slack := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(body, &payload)
		deliveries <- payload["text"]
		w.WriteHeader(http.StatusOK)
	}))
	defer slack.Close()

	modem := &fakeModem{err: errors.New("offline")}
	store := sms.NewStore()
	service := NewService(modem, store, NewForwarder(true, slack.URL), time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx := context.Background()
	service.poll(ctx, true)
	modem.mu.Lock()
	modem.err = nil
	modem.messages = []sms.Message{{ID: "1", Sender: "+1", Text: "old code 123456", ReceivedAt: time.Unix(10, 0)}}
	modem.mu.Unlock()
	service.poll(ctx, false)
	select {
	case got := <-deliveries:
		t.Fatalf("baseline message was forwarded: %q", got)
	case <-time.After(50 * time.Millisecond):
	}
	modem.mu.Lock()
	modem.messages = append(modem.messages, sms.Message{ID: "2", Sender: "+2", Text: "new code 654321", ReceivedAt: time.Unix(20, 0)})
	modem.mu.Unlock()
	service.poll(ctx, false)
	select {
	case got := <-deliveries:
		if got == "" || got == "new code 654321" || !contains(got, "new code 654321") {
			t.Fatalf("unexpected Slack payload: %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("new message was not forwarded")
	}
	service.poll(ctx, false)
	select {
	case got := <-deliveries:
		t.Fatalf("unchanged message forwarded again: %q", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func contains(value, fragment string) bool {
	for i := 0; i+len(fragment) <= len(value); i++ {
		if value[i:i+len(fragment)] == fragment {
			return true
		}
	}
	return false
}
