package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
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
type deviceInfoProvider interface {
	DeviceInfo(context.Context) (sms.DeviceInfo, error)
}
type storageStatusProvider interface {
	StorageStatus(context.Context) (sms.StorageStatus, error)
}

const maxSlackDeliveryHistory = 15

type SlackDelivery struct {
	SentAt     time.Time `json:"sentAt"`
	Sender     string    `json:"sender"`
	ReceivedAt time.Time `json:"receivedAt"`
}

type Forwarder struct {
	enabled        bool
	webhook        string
	client         *http.Client
	addressBook    map[string]string
	receiverNumber string
	publicURL      string
	historyMu      sync.RWMutex
	history        []SlackDelivery
}

func NewForwarder(enabled bool, webhook string) *Forwarder {
	return &Forwarder{enabled: enabled, webhook: webhook, client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (f *Forwarder) SetAddressBook(book map[string]string) { f.addressBook = book }

func (f *Forwarder) SetReceiverNumber(number string) { f.receiverNumber = number }

func (f *Forwarder) SetPublicURL(publicURL string) { f.publicURL = publicURL }

func (f *Forwarder) SlackHistory() []SlackDelivery {
	f.historyMu.RLock()
	history := append([]SlackDelivery(nil), f.history...)
	f.historyMu.RUnlock()
	for left, right := 0, len(history)-1; left < right; left, right = left+1, right-1 {
		history[left], history[right] = history[right], history[left]
	}
	if history == nil {
		return []SlackDelivery{}
	}
	return history
}

func (f *Forwarder) recordSlackDelivery(m sms.Message) {
	f.historyMu.Lock()
	defer f.historyMu.Unlock()
	f.history = append(f.history, SlackDelivery{SentAt: time.Now().UTC(), Sender: m.Sender, ReceivedAt: m.ReceivedAt})
	if len(f.history) > maxSlackDeliveryHistory {
		f.history = f.history[len(f.history)-maxSlackDeliveryHistory:]
	}
}

func (f *Forwarder) Send(ctx context.Context, m sms.Message) error {
	if !f.enabled {
		return nil
	}
	payload := slackPayloadForReceiver(withContactName(m, f.addressBook), f.receiverNumber, f.publicURL)
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
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &statusError{resp.StatusCode}
	}
	f.recordSlackDelivery(m)
	return nil
}

type statusError struct{ code int }

func (e *statusError) Error() string { return "Slack webhook returned a non-success status" }

type Service struct {
	modem           modem
	store           *sms.Store
	forwarder       *Forwarder
	interval        time.Duration
	logger          *slog.Logger
	mu              sync.Mutex
	seen            map[string]struct{}
	initialized     bool
	deviceLoaded    bool
	authRetryAfter  time.Time
	deliveryQueue   chan sms.Message
	deliveryMu      sync.RWMutex
	deliveryCancel  context.CancelFunc
	deliveryWG      sync.WaitGroup
	deliveryStarted bool
}

func NewService(m modem, s *sms.Store, f *Forwarder, d time.Duration, l *slog.Logger) *Service {
	if d <= 0 {
		d = time.Second
	}
	return &Service{modem: m, store: s, forwarder: f, interval: d, logger: l, seen: make(map[string]struct{}), deliveryQueue: make(chan sms.Message, 64)}
}

func (s *Service) Run(ctx context.Context) {
	s.startDeliveryWorkers(ctx)
	defer s.stopDeliveryWorkers()
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
	s.mu.Lock()
	if time.Now().Before(s.authRetryAfter) {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	messages, err := s.modem.List(ctx)
	if err != nil {
		var authFailure interface{ AuthFailure() }
		if errors.As(err, &authFailure) {
			s.mu.Lock()
			s.authRetryAfter = time.Now().Add(5 * time.Minute)
			s.mu.Unlock()
		}
		s.store.Failure("Modem is unavailable; showing the last successful sync.")
		s.logger.Warn("modem poll failed", "error", err)
		return
	}
	for i := range messages {
		messages[i] = sms.Normalize(messages[i])
	}
	s.mu.Lock()
	needDeviceInfo := !s.deviceLoaded
	s.mu.Unlock()
	if needDeviceInfo {
		if provider, ok := s.modem.(deviceInfoProvider); ok {
			if info, infoErr := provider.DeviceInfo(ctx); infoErr == nil {
				s.store.SetDeviceInfo(info)
				s.forwarder.SetReceiverNumber(info.PhoneNumber)
				s.mu.Lock()
				s.deviceLoaded = true
				s.mu.Unlock()
			} else {
				s.logger.Debug("modem device information unavailable", "error", infoErr)
			}
		} else {
			s.mu.Lock()
			s.deviceLoaded = true
			s.mu.Unlock()
		}
	}
	if provider, ok := s.modem.(storageStatusProvider); ok {
		if storage, storageErr := provider.StorageStatus(ctx); storageErr == nil {
			s.store.SetStorageStatus(storage)
		} else {
			s.logger.Debug("modem SMS storage status unavailable", "error", storageErr)
		}
	}
	s.mu.Lock()
	s.authRetryAfter = time.Time{}
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
		s.enqueueDelivery(ctx, m)
	}
}

func (s *Service) startDeliveryWorkers(parent context.Context) {
	s.deliveryMu.Lock()
	defer s.deliveryMu.Unlock()
	if s.deliveryStarted {
		return
	}
	workerCtx, cancel := context.WithCancel(parent)
	s.deliveryCancel = cancel
	s.deliveryStarted = true
	for i := 0; i < 4; i++ {
		s.deliveryWG.Add(1)
		go s.deliveryWorker(workerCtx)
	}
}

func (s *Service) stopDeliveryWorkers() {
	s.deliveryMu.RLock()
	cancel := s.deliveryCancel
	s.deliveryMu.RUnlock()
	if cancel == nil {
		return
	}
	cancel()
	s.deliveryWG.Wait()
}

func (s *Service) deliveryWorker(ctx context.Context) {
	defer s.deliveryWG.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case message := <-s.deliveryQueue:
			sendCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
			if err := s.forwarder.Send(sendCtx, message); err != nil {
				s.logger.Warn("Slack delivery failed", "error", err)
			}
			cancel()
		}
	}
}

func (s *Service) enqueueDelivery(ctx context.Context, message sms.Message) {
	s.deliveryMu.RLock()
	started := s.deliveryStarted
	s.deliveryMu.RUnlock()
	if !started {
		sendCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		defer cancel()
		if err := s.forwarder.Send(sendCtx, message); err != nil {
			s.logger.Warn("Slack delivery failed", "error", err)
		}
		return
	}
	select {
	case s.deliveryQueue <- message:
	default:
		s.logger.Warn("Slack delivery queue full; dropping message", "message_id", message.ID)
	}
}
