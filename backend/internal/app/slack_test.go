package app

import (
	"testing"
	"time"

	"hilink-sms-manager/internal/sms"
)

func TestSlackPayloadFormatsSenderCodeAndSafeLinks(t *testing.T) {
	payload := slackPayload(sms.Message{
		Sender:     "+43 660 123456",
		SenderName: "Alex",
		Text:       "Your security code is 482913. Visit https://example.test/login.",
		ReceivedAt: time.Unix(1_700_000_000, 0),
	})
	if payload["text"] != "SMS from +43 660 123456 (Alex)\nReceived 2023-11-14T22:13:20Z\nYour security code is 482913. Visit https://example.test/login." {
		t.Fatalf("unexpected fallback text: %#v", payload["text"])
	}
	blocks := payload["blocks"].([]slackObject)
	body := blocks[2]["elements"].([]slackObject)
	code := body[1]
	if code["text"] != "482913" || code["style"].(slackObject)["code"] != true {
		t.Fatalf("code was not highlighted: %#v", code)
	}
	link := body[3]
	if link["type"] != "link" || link["url"] != "https://transparencyreport.google.com/safe-browsing/search?url=https%3A%2F%2Fexample.test%2Flogin" {
		t.Fatalf("unexpected safe link: %#v", link)
	}
}

func TestSlackBodyDoesNotTreatPhoneDigitsAsCode(t *testing.T) {
	body, _, _ := slackBody("Call +43 660 123456 for help")
	for _, element := range body {
		if style, ok := element["style"].(slackObject); ok && style["code"] == true {
			t.Fatalf("phone number was highlighted: %#v", body)
		}
	}
}
