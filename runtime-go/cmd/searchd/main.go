// Command searchd serves the concurrent search engine over HTTP.
//
// Configuration via environment:
//
//	SEARCHD_ADDR        listen address (default ":9103")
//	SEARCHD_REDIS_ADDR  optional Redis address; when set, index updates are
//	                    serialized through a Redis distributed lock instead
//	                    of the in-process lock
//	SEARCHD_NODES       optional JSON array of cluster nodes, e.g.
//	                    [{"id":"n1","addr":"http://${LAN_NODE_N1}:9103"},...];
//	                    when set, searchd runs in cluster mode and only holds
//	                    the shards it owns
//	SEARCHD_NODE_ID     this node's ID within SEARCHD_NODES (required in
//	                    cluster mode)
//	SEARCHD_NUM_SHARDS  global shard count in cluster mode (default 32)
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

	"github.com/redis/go-redis/v9"

	"runtime-go/internal/distrib"
	"runtime-go/internal/netutil"
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

	numShards := 16
	opts := []search.Option{search.WithLock(lock)}

	var reg *distrib.Registry
	if nodesJSON := os.Getenv("SEARCHD_NODES"); nodesJSON != "" {
		nodes, err := distrib.ParseNodes(nodesJSON)
		if err != nil {
			log.Fatalf("searchd: invalid SEARCHD_NODES: %v", err)
		}
		selfID := os.Getenv("SEARCHD_NODE_ID")
		reg = distrib.NewRegistry(nodes, selfID)
		if reg.Self().ID == "" {
			log.Fatalf("searchd: SEARCHD_NODE_ID %q not found in SEARCHD_NODES", selfID)
		}
		numShards = 32
		if s := os.Getenv("SEARCHD_NUM_SHARDS"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 1 {
				log.Fatalf("searchd: invalid SEARCHD_NUM_SHARDS %q", s)
			}
			numShards = n
		}
		opts = append(opts, search.WithCluster(reg, numShards))
		log.Printf("searchd: cluster mode as node %s with %d member(s), %d shards", selfID, len(nodes), numShards)
	}

	engine := search.NewEngine(nil, numShards, opts...)
	srv := &http.Server{
		Addr:              addr,
		Handler:           engine.HTTPHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if reg != nil {
		reg.StartHeartbeat(ctx, 5*time.Second, 2*time.Second)
		defer reg.Stop()
	}

	// P2-12b：多 acceptor 并发监听（SEARCHD_LISTENERS，Linux SO_REUSEPORT）
	if err := netutil.ServeAll(ctx, srv, addr, "SEARCHD_LISTENERS", "searchd"); err != nil {
		log.Fatal(err)
	}
}
