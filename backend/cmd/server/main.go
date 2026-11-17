package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"hilink-sms-manager/internal/app"
	"hilink-sms-manager/internal/config"
	"hilink-sms-manager/internal/hilink"
	"hilink-sms-manager/internal/sms"
	"hilink-sms-manager/web"
)

type consoleHandler struct {
	mu    sync.Mutex
	out   *os.File
	attrs []slog.Attr
	color bool
}

func (h *consoleHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *consoleHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	copyAttrs := append(append([]slog.Attr{}, h.attrs...), attrs...)
	return &consoleHandler{out: h.out, attrs: copyAttrs, color: h.color}
}

func (h *consoleHandler) WithGroup(string) slog.Handler { return h }

func (h *consoleHandler) Handle(_ context.Context, record slog.Record) error {
	var line strings.Builder
	line.WriteString(record.Time.Format("15:04:05.000"))
	line.WriteByte(' ')
	level := record.Level.String()
	if h.color {
		color := "\033[36m"
		switch {
		case record.Level >= slog.LevelError:
			color = "\033[31m"
		case record.Level >= slog.LevelWarn:
			color = "\033[33m"
		case record.Level <= slog.LevelDebug:
			color = "\033[90m"
		}
		line.WriteString(color)
	}
	line.WriteString(level)
	if h.color {
		line.WriteString("\033[0m")
	}
	line.WriteByte(' ')
	line.WriteString(record.Message)
	for _, attr := range h.attrs {
		appendConsoleAttr(&line, attr)
	}
	record.Attrs(func(attr slog.Attr) bool {
		appendConsoleAttr(&line, attr)
		return true
	})
	line.WriteByte('\n')
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.out.WriteString(line.String())
	return err
}

func appendConsoleAttr(line *strings.Builder, attr slog.Attr) {
	if attr.Equal(slog.Attr{}) {
		return
	}
	value := attr.Value.Resolve()
	line.WriteByte(' ')
	line.WriteString(attr.Key)
	line.WriteByte('=')
	if value.Kind() == slog.KindString {
		text := value.String()
		if strings.ContainsAny(text, " \t\n\"") {
			line.WriteString(strconv.Quote(text))
		} else {
			line.WriteString(text)
		}
		return
	}
	line.WriteString(fmt.Sprint(value.Any()))
}

func main() {
	color := os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
	logger := slog.New(&consoleHandler{out: os.Stdout, color: color})
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	client := hilink.New(cfg.HiLinkURL, cfg.HiLinkUsername, cfg.HiLinkPassword)
	client.SetLogger(logger)
	store := sms.NewStore()
	forwarder := app.NewForwarder(cfg.SlackEnabled, cfg.SlackWebhook)
	forwarder.SetAddressBook(cfg.AddressBook)
	service := app.NewService(client, store, forwarder, 2*cfg.PollInterval, logger)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go service.Run(ctx)
	static, err := fs.Sub(web.Files, "dist")
	if err != nil {
		logger.Error("frontend assets unavailable", "error", err)
		os.Exit(1)
	}
	handler := app.NewHTTP(cfg, store, client, static, logger)
	server := &http.Server{Addr: cfg.ListenAddr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	logger.Info("server starting", "addr", cfg.ListenAddr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
