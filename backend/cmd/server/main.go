package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"hilink-sms-manager/internal/app"
	"hilink-sms-manager/internal/config"
	"hilink-sms-manager/internal/hilink"
	"hilink-sms-manager/internal/sms"
	"hilink-sms-manager/web"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	client := hilink.New(cfg.HiLinkURL, cfg.HiLinkUsername, cfg.HiLinkPassword)
	store := sms.NewStore()
	forwarder := app.NewForwarder(cfg.SlackEnabled, cfg.SlackWebhook)
	service := app.NewService(client, store, forwarder, cfg.PollInterval, logger)
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
