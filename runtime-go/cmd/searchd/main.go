// Command searchd serves the single-machine concurrent search engine over HTTP.
//
// Configuration via environment:
//
//	SEARCHD_ADDR        listen address (default ":9103")
//	SEARCHD_NUM_SHARDS  shard count (default 16)
//	SEARCHD_WORKERS     query fan-out worker pool size (default: NumCPU)
//	SEARCHD_LISTENERS   optional multi-acceptor count (Linux SO_REUSEPORT)
//
// Multi-machine cluster mode (SEARCHD_NODES / SEARCHD_NODE_ID / Redis
// distributed lock) was retired on 2026-10-03; searchd is single-machine
// only. Concurrency remains in-process via the shard worker pool.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"runtime-go/internal/httpauth"
	"runtime-go/internal/netutil"
	"runtime-go/internal/search"
)

func isWriteRequest(r *http.Request) bool {
	return r.Method != http.MethodGet && r.Method != http.MethodHead
}

func main() {
	addr := os.Getenv("SEARCHD_ADDR")
	if addr == "" {
		addr = ":9103"
	}

	numShards := 16
	if s := os.Getenv("SEARCHD_NUM_SHARDS"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			log.Fatalf("searchd: invalid SEARCHD_NUM_SHARDS %q", s)
		}
		numShards = n
	}

	opts := []search.Option{search.WithLock(search.NewMemLock())}
	if s := os.Getenv("SEARCHD_WORKERS"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			log.Fatalf("searchd: invalid SEARCHD_WORKERS %q", s)
		}
		opts = append(opts, search.WithWorkers(n))
	}
	engine := search.NewEngine(nil, numShards, opts...)
	srv := &http.Server{
		Addr:              addr,
		Handler:           httpauth.WriteGuard("SEARCHD_AUTH_TOKEN", isWriteRequest)(engine.HTTPHandler()),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := netutil.ServeAll(ctx, srv, addr, "SEARCHD_LISTENERS", "searchd")
	engine.Close()
	if serveErr != nil {
		log.Fatal(serveErr)
	}
}
