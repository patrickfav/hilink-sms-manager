package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Config struct {
	HiLinkURL, HiLinkUsername, HiLinkPassword     string
	AuthUsername, AuthPasswordHash, SessionSecret string
	ListenAddr, SlackWebhook                      string
	AddressBook                                   map[string]string
	SlackEnabled                                  bool
	PollInterval, SessionTTL                      time.Duration
	TrustedProxy                                  string
}

func Load() (Config, error) {
	c := Config{
		HiLinkURL:      env("HILINK_URL", "http://192.168.8.1"),
		HiLinkUsername: os.Getenv("HILINK_USERNAME"), HiLinkPassword: os.Getenv("HILINK_PASSWORD"),
		AuthUsername: os.Getenv("AUTH_USERNAME"), AuthPasswordHash: os.Getenv("AUTH_PASSWORD_HASH"),
		ListenAddr: env("LISTEN_ADDR", ":8080"), SlackWebhook: os.Getenv("SLACK_WEBHOOK_URL"), TrustedProxy: os.Getenv("TRUSTED_PROXY"),
		PollInterval: 15 * time.Second, SessionTTL: 12 * time.Hour,
	}
	var err error
	c.AddressBook, err = parseAddressBook(os.Getenv("ADDRESS_BOOK"))
	if err != nil {
		return c, err
	}
	if raw := os.Getenv("POLL_INTERVAL"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d < time.Second || d > time.Hour {
			return c, errors.New("POLL_INTERVAL must be between 1s and 1h")
		}
		c.PollInterval = d
	}
	if raw := os.Getenv("SESSION_TTL"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d < time.Minute || d > 7*24*time.Hour {
			return c, errors.New("SESSION_TTL must be between 1m and 168h")
		}
		c.SessionTTL = d
	}
	if raw := os.Getenv("SLACK_ENABLED"); raw != "" {
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return c, errors.New("SLACK_ENABLED must be true or false")
		}
		c.SlackEnabled = b
	}
	secret := make([]byte, 48)
	if _, err := rand.Read(secret); err != nil {
		return c, fmt.Errorf("generate session secret: %w", err)
	}
	c.SessionSecret = base64.RawURLEncoding.EncodeToString(secret)
	for name, value := range map[string]string{"AUTH_USERNAME": c.AuthUsername, "AUTH_PASSWORD_HASH": c.AuthPasswordHash, "HILINK_USERNAME": c.HiLinkUsername, "HILINK_PASSWORD": c.HiLinkPassword} {
		if strings.TrimSpace(value) == "" {
			return c, fmt.Errorf("%s is required", name)
		}
	}
	if err := bcrypt.CompareHashAndPassword([]byte(c.AuthPasswordHash), []byte("configuration-check")); err != nil && !errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
		return c, errors.New("AUTH_PASSWORD_HASH must be a bcrypt hash")
	}
	u, err := url.Parse(c.HiLinkURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return c, errors.New("HILINK_URL must be an http(s) URL without embedded credentials")
	}
	if c.SlackEnabled {
		su, err := url.Parse(c.SlackWebhook)
		if err != nil || su.Scheme != "https" || su.Host == "" {
			return c, errors.New("SLACK_WEBHOOK_URL must be an HTTPS URL when Slack is enabled")
		}
	}
	return c, nil
}
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseAddressBook(raw string) (map[string]string, error) {
	book := map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return book, nil
	}
	for _, entry := range strings.Split(raw, "|") {
		parts := strings.SplitN(entry, ":", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			return nil, errors.New("ADDRESS_BOOK entries must use number:name format separated by |")
		}
		book[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}
	return book, nil
}
