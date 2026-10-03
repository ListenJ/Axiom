// Command searchd serves the single-machine concurrent search engine over HTTP.
//
// Configuration via environment:
//
//	SEARCHD_ADDR        listen address (default ":9103")
//	SEARCHD_NUM_SHARDS  shard count (default 16)
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

	engine := search.NewEngine(nil, numShards, search.WithLock(search.NewMemLock()))
	srv := &http.Server{
		Addr:              addr,
		Handler:           httpauth.WriteGuard("SEARCHD_AUTH_TOKEN", isWriteRequest)(engine.HTTPHandler()),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := netutil.ServeAll(ctx, srv, addr, "SEARCHD_LISTENERS", "searchd"); err != nil {
		log.Fatal(err)
	}
}
