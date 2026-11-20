package hilink

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
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
	logger             *slog.Logger
	mu                 sync.Mutex
	token              string
	sessionID          string
	loggedIn           bool
}

// AuthError identifies a modem authentication failure so callers can apply
// backoff without matching human-readable error text.
type AuthError struct{ err error }

func (e *AuthError) Error() string { return e.err.Error() }
func (e *AuthError) Unwrap() error { return e.err }
func (e *AuthError) AuthFailure()  {}

func New(raw, user, password string) *Client {
	u, _ := url.Parse(strings.TrimRight(raw, "/"))
	jar, _ := cookiejar.New(nil)
	return &Client{base: u, username: user, password: password, http: &http.Client{Timeout: 8 * time.Second, Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) SetLogger(logger *slog.Logger) { c.logger = logger }
func (c *Client) request(ctx context.Context, method, path string, body []byte, token string) ([]byte, http.Header, int, error) {
	started := time.Now()
	logRequest := func(fields ...any) {
		if c.logger != nil {
			c.logger.Info("hilink request", append([]any{"method", method, "path", path, "request_bytes", len(body), "token_bytes", len(token), "session_cookie_bytes", len(c.sessionID), "encrypted", path == "/api/user/login"}, fields...)...)
		}
	}
	logResponse := func(status, responseBytes int, fields ...any) {
		if c.logger != nil {
			c.logger.Info("hilink response", append([]any{"method", method, "path", path, "status", status, "response_bytes", responseBytes, "duration_ms", time.Since(started).Seconds() * 1000}, fields...)...)
		}
	}
	logRequest()
	u := *c.base
	u.Path = strings.TrimRight(c.base.Path, "/") + path
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, nil, 0, err
	}
	req.Header.Set("Accept", "*/*")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
	origin := c.base.Scheme + "://" + c.base.Host
	req.Header.Set("Origin", origin)
	req.Header.Set("Referer", origin+"/html/home.html")
	if body != nil {
		// The legacy Huawei UI sends its raw XML/encrypted payloads through
		// jQuery's default form content type; match that wire format exactly.
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	}
	if path == "/api/user/login" {
		req.Header.Set("encrypt_transmit", "encrypt_transmit")
	}
	if token != "" {
		req.Header.Set("__RequestVerificationToken", token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		logResponse(0, 0, "error", err.Error())
		return nil, nil, 0, err
	}
	defer resp.Body.Close()
	for _, v := range resp.Header.Values("__RequestVerificationToken") {
		if strings.TrimSpace(v) != "" {
			c.token = strings.TrimSpace(v)
		}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		logResponse(resp.StatusCode, len(b), "error", err.Error())
	} else if code := apiErrorCode(b); code != "" {
		logResponse(resp.StatusCode, len(b), "error_code", code, "response_token", resp.Header.Get("__RequestVerificationToken") != "")
	} else {
		logResponse(resp.StatusCode, len(b), "response_token", resp.Header.Get("__RequestVerificationToken") != "")
	}
	return b, resp.Header, resp.StatusCode, err
}

type sessionInfo struct {
	XMLName xml.Name `xml:"response"`
	TokInfo string   `xml:"TokInfo"`
	SesInfo string   `xml:"SesInfo"`
}

type deviceInformation struct {
	XMLName         xml.Name `xml:"response"`
	Msisdn          string   `xml:"Msisdn"`
	DeviceName      string   `xml:"DeviceName"`
	Imei            string   `xml:"Imei"`
	Imsi            string   `xml:"Imsi"`
	HardwareVersion string   `xml:"HardwareVersion"`
	SoftwareVersion string   `xml:"SoftwareVersion"`
	WebUIVersion    string   `xml:"WebUIVersion"`
	MacAddress1     string   `xml:"MacAddress1"`
	WanIPAddress    string   `xml:"WanIPAddress"`
}

func (c *Client) setSessionCookie(sesInfo string) {
	for _, part := range strings.Split(sesInfo, ";") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "SessionID=") {
			c.sessionID = strings.TrimPrefix(part, "SessionID=")
			c.http.Jar.SetCookies(c.base, []*http.Cookie{{
				Name: "SessionID", Value: c.sessionID, Path: "/",
			}})
			return
		}
	}
}

func apiErrorCode(body []byte) string {
	var response struct {
		XMLName xml.Name `xml:"error"`
		Code    string   `xml:"code"`
	}
	if err := xml.Unmarshal(body, &response); err != nil || response.XMLName.Local != "error" {
		return ""
	}
	return response.Code
}

type encryptionKey struct {
	XMLName  xml.Name `xml:"response"`
	Exponent string   `xml:"encpubkeye"`
	Modulus  string   `xml:"encpubkeyn"`
}

func encryptLoginPayload(payload []byte, key encryptionKey) ([]byte, error) {
	modulus := new(big.Int)
	if _, ok := modulus.SetString(key.Modulus, 16); !ok || modulus.Sign() <= 0 {
		return nil, errors.New("modem returned an invalid RSA modulus")
	}
	exponent := new(big.Int)
	if _, ok := exponent.SetString(key.Exponent, 16); !ok || !exponent.IsInt64() {
		return nil, errors.New("modem returned an invalid RSA exponent")
	}
	publicKey := &rsa.PublicKey{N: modulus, E: int(exponent.Int64())}
	if publicKey.E < 2 || publicKey.N.BitLen() < 512 {
		return nil, errors.New("modem returned an invalid RSA public key")
	}
	encoded := base64.StdEncoding.EncodeToString(payload)
	maxChunk := publicKey.Size() - 11
	if maxChunk <= 0 {
		return nil, errors.New("modem returned an unusable RSA public key")
	}
	var encrypted strings.Builder
	for start := 0; start < len(encoded); start += maxChunk {
		end := start + maxChunk
		if end > len(encoded) {
			end = len(encoded)
		}
		block, err := rsa.EncryptPKCS1v15(rand.Reader, publicKey, []byte(encoded[start:end]))
		if err != nil {
			return nil, fmt.Errorf("encrypt modem login payload: %w", err)
		}
		encrypted.WriteString(hex.EncodeToString(block))
	}
	return []byte(encrypted.String()), nil
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
	c.setSessionCookie(info.SesInfo)
	c.token = info.TokInfo
	// The browser loads the modem encryption key before checking login state.
	publicKeyBody, _, code, err := c.request(ctx, http.MethodGet, "/api/webserver/publickey", nil, c.token)
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("modem public-key request returned HTTP %d", code)
	}
	if code := apiErrorCode(publicKeyBody); code != "" {
		return fmt.Errorf("modem public-key request returned error %s", code)
	}
	var key encryptionKey
	if err := xml.Unmarshal(publicKeyBody, &key); err != nil || key.Exponent == "" || key.Modulus == "" {
		return errors.New("modem did not provide an encryption public key")
	}
	// The legacy UI hashes the password and the session verification token.
	state, _, _, err := c.request(ctx, http.MethodGet, "/api/user/state-login", nil, c.token)
	if err != nil {
		return err
	}
	var s struct {
		PasswordType string `xml:"password_type"`
	}
	_ = xml.Unmarshal(state, &s)
	if code := apiErrorCode(state); code != "" {
		return fmt.Errorf("modem session state returned error %s", code)
	}
	passwordType := s.PasswordType
	if passwordType == "" {
		passwordType = "4"
	}
	// The browser refreshes SesTokInfo immediately before login. This avoids
	// hashing with a token that may have been rotated by the public-key call.
	freshSessionBody, _, code, err := c.request(ctx, http.MethodGet, "/api/webserver/SesTokInfo", nil, "")
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("modem login session refresh returned HTTP %d", code)
	}
	var freshSession sessionInfo
	if err := xml.Unmarshal(freshSessionBody, &freshSession); err != nil || freshSession.TokInfo == "" {
		return errors.New("modem did not provide a fresh login token")
	}
	if code := apiErrorCode(freshSessionBody); code != "" {
		return fmt.Errorf("modem login session refresh returned error %s", code)
	}
	c.setSessionCookie(freshSession.SesInfo)
	c.token = freshSession.TokInfo
	passwordDigest := sha256.Sum256([]byte(c.password))
	initial := base64.StdEncoding.EncodeToString([]byte(hex.EncodeToString(passwordDigest[:])))
	combined := sha256.Sum256([]byte(c.username + initial + c.token))
	encoded := base64.StdEncoding.EncodeToString([]byte(hex.EncodeToString(combined[:])))
	payload := fmt.Sprintf("<request><Username>%s</Username><Password>%s</Password><password_type>%s</password_type></request>", xmlEscape(c.username), encoded, xmlEscape(passwordType))
	encryptedPayload, err := encryptLoginPayload([]byte(payload), key)
	if err != nil {
		return err
	}
	loginBody, headers, code, err := c.request(ctx, http.MethodPost, "/api/user/login", encryptedPayload, c.token)
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("modem login returned HTTP %d", code)
	}
	if code := apiErrorCode(loginBody); code != "" {
		return &AuthError{err: fmt.Errorf("modem login returned error %s", code)}
	}
	for _, v := range headers.Values("__RequestVerificationToken") {
		if strings.TrimSpace(v) != "" {
			c.token = v
		}
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
		const pageSize = 20
		const maxPages = 10000
		completed := false
		for page := 1; page <= maxPages; page++ {
			req := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?><request><PageIndex>%d</PageIndex><ReadCount>%d</ReadCount><BoxType>1</BoxType><SortType>0</SortType><Ascending>0</Ascending><UnreadPreferred>0</UnreadPreferred></request>", start, pageSize)
			b, _, code, err := c.request(ctx, http.MethodPost, "/api/sms/sms-list", []byte(req), c.token)
			if err != nil {
				return nil, err
			}
			if code != 200 {
				c.loggedIn = false
				break
			}
			if code := apiErrorCode(b); code != "" {
				c.loggedIn = false
				return nil, fmt.Errorf("modem SMS list returned error %s", code)
			}
			var out smsResponse
			if err = xml.Unmarshal(b, &out); err != nil {
				return nil, fmt.Errorf("invalid SMS response: %w", err)
			}
			if out.Count == 0 || len(out.Messages) == 0 {
				completed = true
				break
			}
			for _, m := range out.Messages {
				id := m.ID
				if id == "" {
					id = strconv.Itoa(m.Index)
				}
				t, err := parseDate(m.Date)
				if err != nil {
					t = time.Time{}
				}
				all = append(all, sms.Normalize(sms.Message{ModemID: id, Index: m.Index, Sender: m.Phone, Text: m.Content, ReceivedAt: t, Read: m.Smstat == "1"}))
			}
			if out.PageCount > 0 && page >= out.PageCount {
				completed = true
				break
			}
			start++
		}
		if c.loggedIn && !completed {
			return nil, errors.New("modem SMS list exceeded pagination safety limit")
		}
		if c.loggedIn {
			return all, nil
		}
	}
	return nil, errors.New("modem session expired")
}
func parseDate(s string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02T15:04:05-07:00",
	} {
		if t, e := time.Parse(layout, s); e == nil {
			return t, nil
		}
	}
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999999",
		"2006-01-02T15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05",
	} {
		if t, e := time.ParseInLocation(layout, s, time.Local); e == nil {
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
	index, err := strconv.Atoi(id)
	if err != nil || index < 1 {
		return errors.New("invalid modem message id")
	}
	body := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?><request><Index>%d</Index></request>", index)
	responseBody, _, code, err := c.request(ctx, http.MethodPost, "/api/sms/delete-sms", []byte(body), c.token)
	if err != nil {
		return err
	}
	if code != 200 {
		c.loggedIn = false
		return fmt.Errorf("modem deletion returned HTTP %d", code)
	}
	if code := apiErrorCode(responseBody); code != "" {
		c.loggedIn = false
		return fmt.Errorf("modem deletion returned error %s", code)
	}
	return nil
}

// MarkRead marks one received SMS as read. HiLink exposes this operation, but
// does not expose a corresponding operation to restore an SMS to unread.
func (c *Client) MarkRead(ctx context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(ctx); err != nil {
		return err
	}
	index, err := strconv.Atoi(id)
	if err != nil || index < 1 {
		return errors.New("invalid modem message id")
	}
	body := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?><request><Index>%d</Index></request>", index)
	responseBody, _, code, err := c.request(ctx, http.MethodPost, "/api/sms/set-read", []byte(body), c.token)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		c.loggedIn = false
		return fmt.Errorf("modem read-state update returned HTTP %d", code)
	}
	if code := apiErrorCode(responseBody); code != "" {
		c.loggedIn = false
		return fmt.Errorf("modem read-state update returned error %s", code)
	}
	return nil
}

func (c *Client) DeviceInfo(ctx context.Context) (sms.DeviceInfo, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(ctx); err != nil {
		return sms.DeviceInfo{}, err
	}
	body, _, code, err := c.request(ctx, http.MethodGet, "/api/device/information", nil, c.token)
	if err != nil {
		return sms.DeviceInfo{}, err
	}
	if code != http.StatusOK {
		return sms.DeviceInfo{}, fmt.Errorf("modem device information returned HTTP %d", code)
	}
	if code := apiErrorCode(body); code != "" {
		return sms.DeviceInfo{}, fmt.Errorf("modem device information returned error %s", code)
	}
	var info deviceInformation
	if err := xml.Unmarshal(body, &info); err != nil {
		return sms.DeviceInfo{}, fmt.Errorf("invalid modem device information response: %w", err)
	}
	return sms.DeviceInfo{
		PhoneNumber:     strings.TrimSpace(info.Msisdn),
		DeviceName:      strings.TrimSpace(info.DeviceName),
		IMEI:            strings.TrimSpace(info.Imei),
		IMSI:            strings.TrimSpace(info.Imsi),
		HardwareVersion: strings.TrimSpace(info.HardwareVersion),
		SoftwareVersion: strings.TrimSpace(info.SoftwareVersion),
		WebUIVersion:    strings.TrimSpace(info.WebUIVersion),
		LANMACAddress:   strings.TrimSpace(info.MacAddress1),
		WANIPAddress:    strings.TrimSpace(info.WanIPAddress),
	}, nil
}

func (c *Client) PhoneNumber(ctx context.Context) (string, error) {
	info, err := c.DeviceInfo(ctx)
	return info.PhoneNumber, err
}

func (c *Client) Reboot(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(ctx); err != nil {
		return err
	}
	body := []byte("<?xml version=\"1.0\" encoding=\"UTF-8\"?><request><Control>1</Control></request>")
	responseBody, _, code, err := c.request(ctx, http.MethodPost, "/api/device/control", body, c.token)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("modem reboot returned HTTP %d", code)
	}
	if code := apiErrorCode(responseBody); code != "" {
		return fmt.Errorf("modem reboot returned error %s", code)
	}
	c.loggedIn = false
	return nil
}

func (c *Client) StorageStatus(ctx context.Context) (sms.StorageStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(ctx); err != nil {
		return sms.StorageStatus{}, err
	}
	countBody, _, code, err := c.request(ctx, http.MethodGet, "/api/sms/sms-count", nil, c.token)
	if err != nil {
		return sms.StorageStatus{}, err
	}
	if code != http.StatusOK {
		return sms.StorageStatus{}, fmt.Errorf("modem SMS count returned HTTP %d", code)
	}
	if code := apiErrorCode(countBody); code != "" {
		return sms.StorageStatus{}, fmt.Errorf("modem SMS count returned error %s", code)
	}
	var counts struct {
		LocalInbox int `xml:"LocalInbox"`
	}
	if err := xml.Unmarshal(countBody, &counts); err != nil {
		return sms.StorageStatus{}, fmt.Errorf("invalid modem SMS count response: %w", err)
	}
	notificationBody, _, code, err := c.request(ctx, http.MethodGet, "/api/monitoring/check-notifications", nil, c.token)
	if err != nil {
		return sms.StorageStatus{}, err
	}
	if code != http.StatusOK {
		return sms.StorageStatus{}, fmt.Errorf("modem notification check returned HTTP %d", code)
	}
	if code := apiErrorCode(notificationBody); code != "" {
		return sms.StorageStatus{}, fmt.Errorf("modem notification check returned error %s", code)
	}
	var notifications struct {
		SmsStorageFull int `xml:"SmsStorageFull"`
	}
	if err := xml.Unmarshal(notificationBody, &notifications); err != nil {
		return sms.StorageStatus{}, fmt.Errorf("invalid modem notification response: %w", err)
	}
	return sms.StorageStatus{LocalInbox: counts.LocalInbox, Full: notifications.SmsStorageFull == 1}, nil
}
