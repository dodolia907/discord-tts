package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func post(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/synthesize", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSynthesize(t *testing.T) {
	var got string
	h := newHandler(func(_ context.Context, text string) ([]byte, error) {
		got = text
		return []byte("RIFF"), nil
	})

	rec := post(t, h, `{"text":" こんにちは\n世界 "}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if got != "こんにちは 世界" {
		t.Errorf("text = %q", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/wav" {
		t.Errorf("Content-Type = %q", ct)
	}
	if rec.Body.String() != "RIFF" {
		t.Errorf("body = %q", rec.Body)
	}
}

func TestSynthesizeRejectsBadInput(t *testing.T) {
	tests := []struct {
		name, body string
		want       int
	}{
		{"invalid JSON", `{`, http.StatusBadRequest},
		{"blank text", `{"text":"  \n "}`, http.StatusBadRequest},
		{"too long", `{"text":"` + strings.Repeat("あ", maxTextRunes+1) + `"}`, http.StatusRequestEntityTooLarge},
		{"body over limit", `{"text":"` + strings.Repeat("a", maxBodyBytes) + `"}`, http.StatusBadRequest},
	}
	h := newHandler(func(context.Context, string) ([]byte, error) {
		t.Error("synthesizer must not be called")
		return nil, nil
	})
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if rec := post(t, h, tt.body); rec.Code != tt.want {
				t.Errorf("status = %d, want %d", rec.Code, tt.want)
			}
		})
	}
}

func TestSynthesizeFailureHidesDetails(t *testing.T) {
	h := newHandler(func(context.Context, string) ([]byte, error) {
		return nil, errors.New("secret path")
	})

	rec := post(t, h, `{"text":"a"}`)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "secret path") {
		t.Errorf("body leaks details: %s", rec.Body)
	}
}

func TestHealthz(t *testing.T) {
	h := newHandler(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d", rec.Code)
	}
}
