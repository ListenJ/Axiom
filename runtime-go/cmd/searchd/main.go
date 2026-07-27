// Command searchd serves the concurrent search engine over HTTP.
//
// Configuration via environment:
//
//	SEARCHD_ADDR        listen address (default ":9103")
//	SEARCHD_REDIS_ADDR  optional Redis address; when set, index updates are
//	                    serialized through a Redis distributed lock instead
//	                    of the in-process lock
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/redis/go-redis/v9"

	"runtime-go/internal/search"
)

func main() {
	addr := os.Getenv("SEARCHD_ADDR")
	if addr == "" {
		addr = ":9103"
	}

	var lock search.DistLock = search.NewMemLock()
	if raddr := os.Getenv("SEARCHD_REDIS_ADDR"); raddr != "" {
		lock = search.NewRedisLock(redis.NewClient(&redis.Options{Addr: raddr}))
		log.Printf("searchd: using Redis lock at %s", raddr)
	}

	engine := search.NewEngine(nil, 16, search.WithLock(lock))
	srv := &http.Server{
		Addr:              addr,
		Handler:           engine.HTTPHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("searchd: listening on %s", addr)
	log.Fatal(srv.ListenAndServe())
}
