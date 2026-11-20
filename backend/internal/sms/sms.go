package sms

import (
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var otpPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(?:code|otp|verification|verify|security|login|sicherheitscode|aktivierungscode|verifizierungscode)\b\D{0,24}((?:\d[\s-]?){3,7}\d)\b`),
	regexp.MustCompile(`(?i)\b(G-\d{6})\b`),
	regexp.MustCompile(`(?i)\b(?:code|otp|verification|verify|security|login|sicherheitscode|aktivierungscode|verifizierungscode)\b\D{0,24}([A-Z0-9]{5})\b`),
	regexp.MustCompile(`\b(\d{6})\b`),
}

type Message struct {
	// ID is the stable, opaque identifier exposed by the HTTP API. ModemID and
	// Index are kept for modem mutations and deliberately never serialized.
	ID         string    `json:"id"`
	ModemID    string    `json:"-"`
	Index      int       `json:"-"`
	Sender     string    `json:"sender"`
	SenderName string    `json:"senderName,omitempty"`
	Text       string    `json:"text"`
	ReceivedAt time.Time `json:"receivedAt"`
	Read       bool      `json:"read"`
	IsOTP      bool      `json:"isOtp"`
	OTPCodes   []string  `json:"otpCodes"`
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

// PublicID returns the first 32 hexadecimal characters of a versioned SHA-512
// digest used in API paths and Slack deep links. A domain separator prevents
// this value from being confused with hashes used for another purpose.
func PublicID(modemID string) string {
	sum := sha512.Sum512([]byte("hilink-sms-message:v1\x00" + modemID))
	return hex.EncodeToString(sum[:])[:32]
}

// Normalize assigns an opaque public ID while retaining the modem identifier
// needed for operations such as delete and mark-read. Modem responses usually
// contain an ID or index; the content fallback keeps malformed responses
// addressable without exposing their raw fields.
func Normalize(m Message) Message {
	modemID := m.ModemID
	if modemID == "" {
		modemID = m.ID
	}
	if modemID == "" && m.Index > 0 {
		modemID = strconv.Itoa(m.Index)
	}
	if modemID == "" {
		modemID = fmt.Sprintf("content\x00%d\x00%s\x00%s", m.ReceivedAt.Unix(), m.Sender, m.Text)
	}
	m.ModemID = modemID
	m.ID = PublicID(modemID)
	return ClassifyOTP(m)
}

// ExtractOTPCodes returns each distinct verification code found in message
// text, preserving the order in which the matching patterns find them.
func ExtractOTPCodes(text string) []string {
	codes := []string{}
	seen := make(map[string]struct{})
	for _, pattern := range otpPatterns {
		for _, match := range pattern.FindAllStringSubmatch(text, -1) {
			if len(match) < 2 {
				continue
			}
			code := normalizeOTPCode(match[1])
			if code == "" {
				continue
			}
			if _, exists := seen[code]; exists {
				continue
			}
			seen[code] = struct{}{}
			codes = append(codes, code)
		}
	}
	return codes
}

// ClassifyOTP marks a message and stores all extracted OTP codes for API and
// downstream notification consumers.
func ClassifyOTP(m Message) Message {
	m.OTPCodes = ExtractOTPCodes(m.Text)
	m.IsOTP = len(m.OTPCodes) > 0
	return m
}

func digitsOnly(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, value)
}

func normalizeOTPCode(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && strings.EqualFold(value[:2], "g-") {
		return "G-" + digitsOnly(value[2:])
	}
	if strings.IndexFunc(value, func(r rune) bool {
		return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
	}) != -1 {
		return strings.ToUpper(value)
	}
	return digitsOnly(value)
}

// Identity deliberately excludes mutable fields such as read status.
func Identity(m Message) string {
	if m.ModemID != "" {
		return "modem-id:" + m.ModemID
	}
	if m.Index > 0 {
		return fmt.Sprintf("index:%d", m.Index)
	}
	if m.ID != "" {
		return "id:" + m.ID
	}
	return PublicID(fmt.Sprintf("%s\x00%d\x00%s\x00%s", m.ID, m.ReceivedAt.Unix(), m.Sender, m.Text))
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
	snapshot := append([]Message(nil), messages...)
	for i := range snapshot {
		snapshot[i] = ClassifyOTP(snapshot[i])
	}
	sort.Slice(snapshot, func(i, j int) bool { return snapshot[i].ReceivedAt.After(snapshot[j].ReceivedAt) })
	s.mu.Lock()
	s.messages = append([]Message{}, snapshot...)
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
