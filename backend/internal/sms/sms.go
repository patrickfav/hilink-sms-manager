package sms

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"sync"
	"time"
)

type Message struct {
	ID         string    `json:"id"`
	Index      int       `json:"index,omitempty"`
	Sender     string    `json:"sender"`
	Text       string    `json:"text"`
	ReceivedAt time.Time `json:"receivedAt"`
	Read       bool      `json:"read"`
}

// Identity deliberately excludes mutable fields such as read status.
func Identity(m Message) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s\x00%s", m.ID, m.ReceivedAt.Unix(), m.Sender, m.Text)))
	return hex.EncodeToString(sum[:])
}

type Store struct {
	mu        sync.RWMutex
	messages  []Message
	lastSync  time.Time
	lastError string
	connected bool
}

func NewStore() *Store { return &Store{} }

func (s *Store) Replace(messages []Message) {
	sort.Slice(messages, func(i, j int) bool { return messages[i].ReceivedAt.After(messages[j].ReceivedAt) })
	s.mu.Lock()
	s.messages = append([]Message{}, messages...)
	s.lastSync = time.Now()
	s.lastError = ""
	s.connected = true
	s.mu.Unlock()
}

func (s *Store) Failure(err string) {
	s.mu.Lock()
	s.connected = false
	s.lastError = err
	s.mu.Unlock()
}

func (s *Store) List() []Message {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Message{}, s.messages...)
}

func (s *Store) Get(id string) (Message, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, m := range s.messages {
		if m.ID == id {
			return m, true
		}
	}
	return Message{}, false
}

func (s *Store) Remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, m := range s.messages {
		if m.ID == id {
			s.messages = append(s.messages[:i], s.messages[i+1:]...)
			return
		}
	}
}

type Status struct {
	Connected    bool       `json:"connected"`
	LastSync     *time.Time `json:"lastSync"`
	Error        string     `json:"error,omitempty"`
	MessageCount int        `json:"messageCount"`
}

func (s *Store) Status() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var synced *time.Time
	if !s.lastSync.IsZero() {
		t := s.lastSync
		synced = &t
	}
	return Status{s.connected, synced, s.lastError, len(s.messages)}
}
