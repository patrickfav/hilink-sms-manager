package hilink

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"hilink-sms-manager/internal/sms"
)

type Client struct {
	base               *url.URL
	username, password string
	http               *http.Client
	mu                 sync.Mutex
	token              string
	loggedIn           bool
}

func New(raw, user, password string) *Client {
	u, _ := url.Parse(strings.TrimRight(raw, "/"))
	jar, _ := cookiejar.New(nil)
	return &Client{base: u, username: user, password: password, http: &http.Client{Timeout: 8 * time.Second, Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) request(ctx context.Context, method, path string, body []byte, token string) ([]byte, http.Header, int, error) {
	u := *c.base
	u.Path = strings.TrimRight(c.base.Path, "/") + path
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, nil, 0, err
	}
	req.Header.Set("Accept", "application/xml")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	if body != nil {
		req.Header.Set("Content-Type", "text/xml; charset=UTF-8")
	}
	if token != "" {
		req.Header.Set("__RequestVerificationToken", token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, 0, err
	}
	defer resp.Body.Close()
	for _, v := range resp.Header.Values("__RequestVerificationToken") {
		if strings.TrimSpace(v) != "" {
			c.token = strings.TrimSpace(v)
		}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	return b, resp.Header, resp.StatusCode, err
}

type sessionInfo struct {
	XMLName xml.Name `xml:"response"`
	TokInfo string   `xml:"TokInfo"`
	SesInfo string   `xml:"SesInfo"`
}

func (c *Client) login(ctx context.Context) error {
	b, _, code, err := c.request(ctx, http.MethodGet, "/api/webserver/SesTokInfo", nil, "")
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("modem session init returned HTTP %d", code)
	}
	var info sessionInfo
	if err = xml.Unmarshal(b, &info); err != nil {
		return fmt.Errorf("invalid modem session response: %w", err)
	}
	if info.TokInfo == "" {
		return errors.New("modem did not provide a verification token")
	}
	c.token = info.TokInfo
	// HiLink's legacy login challenge hashes the UTF-8 password, then the challenge and digest.
	state, _, _, err := c.request(ctx, http.MethodGet, "/api/user/state-login", nil, c.token)
	if err != nil {
		return err
	}
	challenge := ""
	var s struct {
		Challenge  string `xml:"Challenge"`
		Nonce      string `xml:"nonce"`
		Salt       string `xml:"salt"`
		Iterations int    `xml:"iterations"`
	}
	_ = xml.Unmarshal(state, &s)
	challenge = s.Challenge
	if challenge == "" {
		challenge = s.Nonce
	}
	passwordDigest := sha256.Sum256([]byte(c.password))
	initial := hex.EncodeToString(passwordDigest[:])
	combined := sha256.Sum256([]byte(c.username + initial + challenge))
	encoded := base64.StdEncoding.EncodeToString(combined[:])
	payload := fmt.Sprintf("<request><Username>%s</Username><Password>%s</Password><password_type>4</password_type></request>", xmlEscape(c.username), encoded)
	_, headers, code, err := c.request(ctx, http.MethodPost, "/api/user/login", []byte(payload), c.token)
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("modem login returned HTTP %d", code)
	}
	for _, v := range headers.Values("__RequestVerificationToken") {
		if strings.TrimSpace(v) != "" {
			c.token = v
		}
	}
	if strings.Contains(string(state), "<State>0</State>") && challenge == "" {
		return errors.New("modem login challenge was empty")
	}
	c.loggedIn = true
	return nil
}
func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func (c *Client) ensure(ctx context.Context) error {
	if !c.loggedIn {
		return c.login(ctx)
	}
	return nil
}

type smsResponse struct {
	Messages []struct {
		Index   int    `xml:"Index"`
		Phone   string `xml:"Phone"`
		Content string `xml:"Content"`
		Date    string `xml:"Date"`
		Smstat  string `xml:"Smstat"`
		ID      string `xml:"ID"`
	} `xml:"Messages>Message"`
	Count     int `xml:"Count"`
	PageCount int `xml:"PageCount"`
}

func (c *Client) List(ctx context.Context) ([]sms.Message, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		if err := c.ensure(ctx); err != nil {
			c.loggedIn = false
			return nil, err
		}
		all := []sms.Message{}
		start := 1
		for page := 0; page < 100; page++ {
			req := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?><request><PageIndex>%d</PageIndex><ReadCount>20</ReadCount><BoxType>1</BoxType><SortType>0</SortType><Ascending>0</Ascending><UnreadPreferred>0</UnreadPreferred></request>", start)
			b, _, code, err := c.request(ctx, http.MethodPost, "/api/sms/sms-list", []byte(req), c.token)
			if err != nil {
				return nil, err
			}
			if code != 200 {
				c.loggedIn = false
				break
			}
			var out smsResponse
			if err = xml.Unmarshal(b, &out); err != nil {
				return nil, fmt.Errorf("invalid SMS response: %w", err)
			}
			if out.Count == 0 || len(out.Messages) == 0 {
				break
			}
			for _, m := range out.Messages {
				id := m.ID
				if id == "" {
					id = strconv.Itoa(m.Index)
				}
				t, err := parseDate(m.Date)
				if err != nil {
					t = time.Now()
				}
				all = append(all, sms.Message{ID: id, Index: m.Index, Sender: m.Phone, Text: m.Content, ReceivedAt: t, Read: m.Smstat == "1"})
			}
			start++
		}
		if c.loggedIn {
			return all, nil
		}
	}
	return nil, errors.New("modem session expired")
}
func parseDate(s string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02 15:04:05-07:00"} {
		if t, e := time.Parse(layout, s); e == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.New("unknown modem date")
}
func (c *Client) Delete(ctx context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(ctx); err != nil {
		return err
	}
	if _, err := strconv.Atoi(id); err != nil {
		return errors.New("invalid modem message id")
	}
	body := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?><request><Index>%s</Index></request>", id)
	_, _, code, err := c.request(ctx, http.MethodPost, "/api/sms/delete-sms", []byte(body), c.token)
	if err != nil {
		return err
	}
	if code != 200 {
		c.loggedIn = false
		return fmt.Errorf("modem deletion returned HTTP %d", code)
	}
	return nil
}
