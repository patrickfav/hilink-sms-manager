package app

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"hilink-sms-manager/internal/sms"
)

type modem interface {
	List(context.Context) ([]sms.Message, error)
	Delete(context.Context, string) error
}

type Forwarder struct {
	enabled bool
	webhook string
	client  *http.Client
}

func NewForwarder(enabled bool, webhook string) *Forwarder {
	return &Forwarder{enabled, webhook, &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (f *Forwarder) Send(ctx context.Context, m sms.Message) error {
	if !f.enabled {
		return nil
	}
	payload := map[string]string{"text": "New SMS from " + m.Sender + " at " + m.ReceivedAt.Format(time.RFC3339) + "\n" + m.Text}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.webhook, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &statusError{resp.StatusCode}
	}
	return nil
}

type statusError struct{ code int }

func (e *statusError) Error() string { return "Slack webhook returned a non-success status" }

type Service struct {
	modem       modem
	store       *sms.Store
	forwarder   *Forwarder
	interval    time.Duration
	logger      *slog.Logger
	mu          sync.Mutex
	seen        map[string]struct{}
	initialized bool
}

func NewService(m modem, s *sms.Store, f *Forwarder, d time.Duration, l *slog.Logger) *Service {
	return &Service{modem: m, store: s, forwarder: f, interval: d, logger: l, seen: make(map[string]struct{})}
}

func (s *Service) Run(ctx context.Context) {
	s.poll(ctx, true)
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.poll(ctx, false)
		}
	}
}

func (s *Service) poll(ctx context.Context, initial bool) {
	messages, err := s.modem.List(ctx)
	if err != nil {
		s.store.Failure("Modem is unavailable; showing the last successful sync.")
		s.logger.Warn("modem poll failed", "error", err)
		return
	}
	s.mu.Lock()
	baseline := initial || !s.initialized
	newMessages := []sms.Message{}
	next := make(map[string]struct{}, len(messages))
	for _, m := range messages {
		identity := sms.Identity(m)
		next[identity] = struct{}{}
		if _, ok := s.seen[identity]; !ok && !baseline {
			newMessages = append(newMessages, m)
		}
	}
	s.seen = next
	s.initialized = true
	s.mu.Unlock()
	s.store.Replace(messages)
	for _, m := range newMessages {
		msg := m
		go func() {
			sendCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
			defer cancel()
			if err := s.forwarder.Send(sendCtx, msg); err != nil {
				s.logger.Warn("Slack delivery failed", "error", err)
			}
		}()
	}
}
