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
	SenderName string    `json:"senderName,omitempty"`
	Text       string    `json:"text"`
	ReceivedAt time.Time `json:"receivedAt"`
	Read       bool      `json:"read"`
}

type DeviceInfo struct {
	PhoneNumber     string
	DeviceName      string
	IMEI            string
	IMSI            string
	HardwareVersion string
	SoftwareVersion string
	WebUIVersion    string
	LANMACAddress   string
	WANIPAddress    string
}

type StorageStatus struct {
	LocalInbox int
	Full       bool
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
	device    DeviceInfo
	storage   StorageStatus
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

func (s *Store) MarkRead(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.messages {
		if s.messages[i].ID == id {
			s.messages[i].Read = true
			return true
		}
	}
	return false
}

func (s *Store) SetDeviceInfo(info DeviceInfo) {
	s.mu.Lock()
	s.device = info
	s.mu.Unlock()
}

func (s *Store) SetStorageStatus(storage StorageStatus) {
	s.mu.Lock()
	s.storage = storage
	s.mu.Unlock()
}

type Status struct {
	Connected       bool       `json:"connected"`
	LastSync        *time.Time `json:"lastSync"`
	Error           string     `json:"error,omitempty"`
	MessageCount    int        `json:"messageCount"`
	PhoneNumber     string     `json:"phoneNumber,omitempty"`
	DeviceName      string     `json:"deviceName,omitempty"`
	IMEI            string     `json:"imei,omitempty"`
	IMSI            string     `json:"imsi,omitempty"`
	HardwareVersion string     `json:"hardwareVersion,omitempty"`
	SoftwareVersion string     `json:"softwareVersion,omitempty"`
	WebUIVersion    string     `json:"webUIVersion,omitempty"`
	LANMACAddress   string     `json:"lanMacAddress,omitempty"`
	WANIPAddress    string     `json:"wanIpAddress,omitempty"`
	StorageFull     bool       `json:"storageFull,omitempty"`
	SlackEnabled    bool       `json:"slackEnabled"`
}

func (s *Store) Status() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var synced *time.Time
	if !s.lastSync.IsZero() {
		t := s.lastSync
		synced = &t
	}
	return Status{
		Connected: s.connected, LastSync: synced, Error: s.lastError,
		MessageCount: len(s.messages), PhoneNumber: s.device.PhoneNumber,
		DeviceName: s.device.DeviceName, IMEI: s.device.IMEI, IMSI: s.device.IMSI,
		HardwareVersion: s.device.HardwareVersion, SoftwareVersion: s.device.SoftwareVersion,
		WebUIVersion: s.device.WebUIVersion, LANMACAddress: s.device.LANMACAddress,
		WANIPAddress: s.device.WANIPAddress,
		StorageFull:  s.storage.Full,
	}
}
