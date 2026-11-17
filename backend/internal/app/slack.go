package app

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"hilink-sms-manager/internal/sms"
)

type slackObject = map[string]any

var slackLinks = regexp.MustCompile(`(?i)https?://[^\s<>"']+|www\.[^\s<>"']+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+\d[\d\s().-]{6,}\d`)
var slackCodes = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(?:code|otp|verification|verify|security|login|sicherheitscode|verifizierungscode)\D{0,24}((?:\d[ -]?){3,7}\d)\b`),
	regexp.MustCompile(`\b(\d{6})\b`),
}

func slackText(text string) slackObject {
	return slackObject{"type": "text", "text": text}
}

func formatSlackTimestamp(t time.Time) string {
	return strconv.FormatInt(t.Unix(), 10)
}

func slackPayloadForReceiver(m sms.Message, receiverNumber, publicURL string) slackObject {
	sender := m.Sender
	if m.SenderName != "" {
		sender += " (" + m.SenderName + ")"
	}
	body, fallback, _ := slackBody(m.Text)
	heading := slackText("SMS from " + sender)
	heading["style"] = slackObject{"bold": true}
	received := "unknown time"
	receivedLine := "Received " + received
	if !m.ReceivedAt.IsZero() {
		received = m.ReceivedAt.UTC().Format(time.RFC3339)
		receivedLine = "Received <!date^" + formatSlackTimestamp(m.ReceivedAt) + "^{date_short_pretty} at {time}|" + received + ">"
	}
	if receiverNumber != "" {
		receivedLine += " · " + receiverNumber
	}
	fallbackReceived := "Received " + received
	if receiverNumber != "" {
		fallbackReceived += " · " + receiverNumber
	}
	blocks := []slackObject{
		{"type": "rich_text", "elements": []slackObject{{"type": "rich_text_section", "elements": []slackObject{heading}}}},
		{"type": "context", "elements": []slackObject{{"type": "mrkdwn", "text": receivedLine}}},
	}
	if len(body) > 0 {
		blocks = append(blocks, slackObject{"type": "rich_text", "elements": []slackObject{{"type": "rich_text_quote", "elements": body}}})
	}
	if publicURL != "" && m.ID != "" {
		deepLink := strings.TrimRight(publicURL, "/") + "/sms/" + url.PathEscape(m.ID)
		blocks = append(blocks, slackObject{"type": "context", "elements": []slackObject{{"type": "mrkdwn", "text": "<" + deepLink + "|Open in HiLink SMS>"}}})
	}
	return slackObject{"text": "SMS from " + sender + "\n" + fallbackReceived + "\n" + fallback, "blocks": blocks, "unfurl_links": false, "unfurl_media": false}
}

// Tokenize links first so digits inside URLs, email addresses and phone numbers
// cannot be highlighted as verification codes.
func slackBody(text string) ([]slackObject, string, bool) {
	links := slackLinks.FindAllStringIndex(text, -1)
	masked := []byte(text)
	for _, span := range links {
		for i := span[0]; i < span[1]; i++ {
			masked[i] = 'x'
		}
	}
	codeStart, codeEnd := -1, -1
	for _, pattern := range slackCodes {
		if hit := pattern.FindStringSubmatchIndex(string(masked)); hit != nil {
			codeStart, codeEnd = hit[2], hit[3]
			break
		}
	}
	elements := []slackObject{}
	var fallback strings.Builder
	appendText := func(start, end int) {
		if start >= end {
			return
		}
		fallback.WriteString(text[start:end])
		if codeStart >= start && codeEnd <= end {
			if start < codeStart {
				elements = append(elements, slackText(text[start:codeStart]))
			}
			code := slackText(text[codeStart:codeEnd])
			code["style"] = slackObject{"code": true}
			elements = append(elements, code)
			if codeEnd < end {
				elements = append(elements, slackText(text[codeEnd:end]))
			}
		} else {
			elements = append(elements, slackText(text[start:end]))
		}
	}
	cursor, hasWebLinks := 0, false
	for _, span := range links {
		appendText(cursor, span[0])
		visible := strings.TrimRight(text[span[0]:span[1]], ".,!?;:)]}")
		lower := strings.ToLower(visible)
		var target string
		switch {
		case strings.HasPrefix(lower, "http://"), strings.HasPrefix(lower, "https://"), strings.HasPrefix(lower, "www."):
			original := visible
			if strings.HasPrefix(lower, "www.") {
				original = "https://" + original
			}
			target = "https://transparencyreport.google.com/safe-browsing/search?url=" + url.QueryEscape(original)
			hasWebLinks = true
			fallback.WriteString(visible)
		case strings.Contains(visible, "@"):
			target = "mailto:" + visible
			fallback.WriteString(visible)
		default:
			target = "tel:" + normalizePhone(visible)
			fallback.WriteString(visible)
		}
		elements = append(elements, slackObject{"type": "link", "text": visible, "url": target})
		cursor = span[0] + len(visible)
	}
	appendText(cursor, len(text))
	return elements, fallback.String(), hasWebLinks
}
