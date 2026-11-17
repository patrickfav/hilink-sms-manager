package app

import (
	"testing"
	"time"

	"hilink-sms-manager/internal/sms"
)

func TestSlackPayloadFormatsSenderCodeAndSafeLinks(t *testing.T) {
	payload := slackPayloadForReceiver(sms.Message{
		ID:         "123",
		Sender:     "+43 660 123456",
		SenderName: "Alex",
		Text:       "Your security code is 482913. Visit https://example.test/login.",
		ReceivedAt: time.Unix(1_700_000_000, 0),
	}, "+43 660 999999", "https://sms.favho.me")
	if payload["text"] != "SMS from +43 660 123456 (Alex)\nReceived 2023-11-14T22:13:20Z · +43 660 999999\nYour security code is 482913. Visit https://example.test/login." {
		t.Fatalf("unexpected fallback text: %#v", payload["text"])
	}
	blocks := payload["blocks"].([]slackObject)
	deepLink := blocks[3]["elements"].([]slackObject)[0]["text"]
	if deepLink != "<https://sms.favho.me/sms/123|Open in HiLink SMS>" {
		t.Fatalf("unexpected message deep link: %q", deepLink)
	}
	body := blocks[2]["elements"].([]slackObject)
	received := blocks[1]["elements"].([]slackObject)[0]["text"].(string)
	if received != "Received <!date^1700000000^{date_short_pretty} at {time}|2023-11-14T22:13:20Z> · +43 660 999999" {
		t.Fatalf("unexpected received line: %q", received)
	}
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
