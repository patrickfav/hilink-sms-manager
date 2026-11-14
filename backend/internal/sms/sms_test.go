package sms

import (
	"testing"
	"time"
)

func TestReplaceSortsNewestFirstAndCopies(t *testing.T) {
	store := NewStore()
	older := Message{ID: "1", ReceivedAt: time.Unix(1, 0)}
	newer := Message{ID: "2", ReceivedAt: time.Unix(2, 0)}
	input := []Message{older, newer}
	store.Replace(input)
	input[0].ID = "changed"
	got := store.List()
	if len(got) != 2 || got[0].ID != "2" || got[1].ID != "1" {
		t.Fatalf("unexpected sorted snapshot: %#v", got)
	}
	got[0].ID = "caller mutation"
	if m, ok := store.Get("2"); !ok || m.ID != "2" {
		t.Fatal("List must not expose the store's backing slice")
	}
}

func TestListReturnsAnEmptyArrayForAnEmptySnapshot(t *testing.T) {
	store := NewStore()
	if got := store.List(); got == nil || len(got) != 0 {
		t.Fatalf("empty List() = %#v; want a non-nil empty slice", got)
	}
	store.Replace(nil)
	if got := store.List(); got == nil || len(got) != 0 {
		t.Fatalf("empty snapshot List() = %#v; want a non-nil empty slice", got)
	}
}

func TestFailurePreservesSnapshot(t *testing.T) {
	store := NewStore()
	store.Replace([]Message{{ID: "keep"}})
	store.Failure("unavailable")
	if got := store.List(); len(got) != 1 || got[0].ID != "keep" {
		t.Fatalf("failure cleared cached messages: %#v", got)
	}
	status := store.Status()
	if status.Connected || status.Error == "" || status.LastSync == nil {
		t.Fatalf("unexpected failure status: %#v", status)
	}
}
