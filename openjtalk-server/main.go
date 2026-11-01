// Command openjtalk-server exposes the open_jtalk CLI over HTTP.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	maxBodyBytes     = 16 * 1024
	maxTextRunes     = 500
	maxConcurrent    = 2
	synthesisTimeout = 30 * time.Second
)

type synthesizer func(ctx context.Context, text string) ([]byte, error)

type config struct {
	Binary, Dictionary, Voice string
}

// openJTalk writes text to stdin, so the text is never parsed as a command-line argument.
func openJTalk(cfg config) synthesizer {
	return func(ctx context.Context, text string) ([]byte, error) {
		dir, err := os.MkdirTemp("", "synth-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(dir)

		out := filepath.Join(dir, "out.wav")
		cmd := exec.CommandContext(ctx, cfg.Binary, "-x", cfg.Dictionary, "-m", cfg.Voice, "-ow", out)
		cmd.Stdin = strings.NewReader(text + "\n")
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("open_jtalk: %w: %s", err, stderr.String())
		}
		return os.ReadFile(out)
	}
}

// normalize collapses all whitespace because open_jtalk treats each line as a separate utterance.
func normalize(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func newHandler(synth synthesizer) http.Handler {
	slots := make(chan struct{}, maxConcurrent)
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("POST /synthesize", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Text string `json:"text"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		text := normalize(req.Text)
		if text == "" {
			http.Error(w, "text is empty", http.StatusBadRequest)
			return
		}
		if len([]rune(text)) > maxTextRunes {
			http.Error(w, "text is too long", http.StatusRequestEntityTooLarge)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), synthesisTimeout)
		defer cancel()

		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-ctx.Done():
			http.Error(w, "synthesis queue timed out", http.StatusServiceUnavailable)
			return
		}

		wav, err := synth(ctx, text)
		if err != nil {
			log.Printf("synthesis failed: %v", err)
			http.Error(w, "synthesis failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(wav)
	})
	return mux
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg := config{
		Binary:     env("OPEN_JTALK_BIN", "open_jtalk"),
		Dictionary: env("OPEN_JTALK_DIC", "/var/lib/mecab/dic/open-jtalk/naist-jdic"),
		Voice:      env("OPEN_JTALK_VOICE", "/usr/share/hts-voice/nitech-jp-atr503-m001/nitech_jp_atr503_m001.htsvoice"),
	}
	srv := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           newHandler(openJTalk(cfg)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	log.Printf("listening on %s", srv.Addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
