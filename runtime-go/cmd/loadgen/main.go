// loadgen is a load generator and data seeder for the runtime-go cluster.
//
// Modes:
//
//	seed   — generate synthetic documents and POST them to searchd /documents
//	search — open-model load test against searchd /search at a fixed QPS
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// vocab is generated at init: 5000 synthetic terms (+ 200 CJK) so term
// document-frequency stays selective (~0.8% per term at 40 words/doc).
// A small vocab makes every query a full-corpus scan and skews load tests.
var vocab = func() []string {
	base := []string{
		"goroutine", "channel", "scheduler", "mutex", "atomic", "context", "buffer",
		"pipeline", "worker", "pool", "queue", "shard", "index", "token", "search",
		"vector", "memory", "cache", "latency", "throughput", "cluster", "replica",
		"failover", "snapshot", "journal", "compaction", "optimizer", "planner",
	}
	out := make([]string, 0, 5200)
	out = append(out, base...)
	for i := 0; i < 5000; i++ {
		out = append(out, fmt.Sprintf("term%04d", i))
	}
	cjk := []string{"调度", "并发", "索引", "查询", "缓存", "集群", "分片", "故障", "恢复", "快照"}
	for i := 0; i < 20; i++ {
		for _, c := range cjk {
			out = append(out, fmt.Sprintf("%s%02d", c, i))
		}
	}
	return out
}()

type document struct {
	ID     string            `json:"id"`
	Title  string            `json:"title"`
	Body   string            `json:"body"`
	Fields map[string]string `json:"fields,omitempty"`
}

func randWords(r *rand.Rand, n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(vocab[r.Intn(len(vocab))])
	}
	return b.String()
}

func main() {
	mode := flag.String("mode", "search", "seed | search")
	addr := flag.String("addr", "http://127.0.0.1:9103", "searchd entry address")
	qps := flag.Int("qps", 10000, "target requests per second (search mode)")
	dur := flag.Duration("duration", 30*time.Second, "load duration (search mode)")
	workers := flag.Int("workers", 64, "concurrent workers (search mode)")
	docs := flag.Int("docs", 10000, "documents to generate (seed mode)")
	batch := flag.Int("batch", 500, "docs per POST (seed mode)")
	timeout := flag.Duration("timeout", 10*time.Second, "per-request timeout")
	qmix := flag.String("mix", "mixed", "query mix: mixed | simple (search mode)")
	flag.Parse()

	client := &http.Client{
		Timeout:   *timeout,
		Transport: &http.Transport{MaxIdleConnsPerHost: *workers * 2, MaxIdleConns: *workers * 2},
	}

	switch *mode {
	case "seed":
		seed(client, *addr, *docs, *batch)
	case "search":
		load(client, *addr, *qps, *dur, *workers, *qmix)
	default:
		fmt.Fprintln(os.Stderr, "unknown mode:", *mode)
		os.Exit(2)
	}
}

func seed(client *http.Client, addr string, total, batch int) {
	r := rand.New(rand.NewSource(42))
	start := time.Now()
	sent := 0
	for sent < total {
		n := batch
		if remaining := total - sent; remaining < n {
			n = remaining
		}
		ds := make([]document, n)
		for i := range ds {
			id := sent + i
			ds[i] = document{
				ID:     fmt.Sprintf("doc-%d", id),
				Title:  fmt.Sprintf("Doc %d %s", id, randWords(r, 2)),
				Body:   randWords(r, 40),
				Fields: map[string]string{"lang": []string{"go", "rust", "java"}[id%3]},
			}
		}
		body, _ := json.Marshal(ds)
		resp, err := client.Post(addr+"/documents", "application/json", bytes.NewReader(body))
		if err != nil {
			fmt.Fprintln(os.Stderr, "seed error:", err)
			os.Exit(1)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			fmt.Fprintf(os.Stderr, "seed batch at %d: status %d\n", sent, resp.StatusCode)
			os.Exit(1)
		}
		sent += n
		fmt.Printf("\rseeded %d/%d", sent, total)
	}
	fmt.Printf("\nseed done: %d docs in %s\n", total, time.Since(start).Round(time.Millisecond))
}

func load(client *http.Client, addr string, qps int, dur time.Duration, workers int, qmix string) {
	// Query mix: single terms (selective), 2-term AND, field filter, NOT,
	// OR, prefix — drawn from a fixed vocab sample for reproducibility.
	mixed := []string{
		"term0042", "term1337", "调度07", "term0042 term9999", "lang:go term0007",
		"term0123 -term0456", "term0001 OR term0002", "term12*", "term3333 term4444", "查询11 缓存11",
	}
	simple := []string{"term0042", "term1337", "term9999", "调度07", "term0007", "term0123", "term3333", "查询11"}
	queries := mixed
	if qmix == "simple" {
		queries = simple
	}
	r := rand.New(rand.NewSource(7))

	var (
		okCount   atomic.Int64
		errCount  atomic.Int64
		latMu     sync.Mutex
		latencies = make([]float64, 0, qps*int(dur.Seconds())+workers)
		errSample atomic.Int64
	)

	// qps <= 0: closed-loop mode — issue as fast as workers drain the queue.
	// (The ticker pacer is capped by OS timer granularity: ~1-2k qps on
	// Windows, ~100k on Linux.)
	var tick <-chan time.Time
	if qps > 0 {
		ticker := time.NewTicker(time.Second / time.Duration(qps))
		defer ticker.Stop()
		tick = ticker.C
	}
	jobs := make(chan string, workers*4)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for q := range jobs {
				start := time.Now()
				resp, err := client.Get(addr + "/search?q=" + url.QueryEscape(q))
				if err != nil {
					if errSample.Add(1) <= 5 {
						fmt.Fprintf(os.Stderr, "err sample: %v\n", err)
					}
					errCount.Add(1)
					continue
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					errCount.Add(1)
					continue
				}
				okCount.Add(1)
				ms := float64(time.Since(start).Microseconds()) / 1000.0
				latMu.Lock()
				latencies = append(latencies, ms)
				latMu.Unlock()
			}
		}()
	}

	deadline := time.Now().Add(dur)
	start := time.Now()
	issued := 0
	for time.Now().Before(deadline) {
		if tick != nil {
			<-tick
		}
		jobs <- queries[r.Intn(len(queries))]
		issued++
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(start)

	sort.Float64s(latencies)
	pct := func(p float64) float64 {
		if len(latencies) == 0 {
			return 0
		}
		i := int(p * float64(len(latencies)-1))
		return latencies[i]
	}
	fmt.Printf("=== loadgen report ===\n")
	fmt.Printf("duration:      %s\n", elapsed.Round(time.Millisecond))
	fmt.Printf("issued:        %d (target %d qps)\n", issued, qps)
	fmt.Printf("ok:            %d\n", okCount.Load())
	fmt.Printf("errors:        %d (%.2f%%)\n", errCount.Load(), 100*float64(errCount.Load())/float64(max(issued, 1)))
	fmt.Printf("achieved qps:  %.0f\n", float64(okCount.Load())/elapsed.Seconds())
	fmt.Printf("latency ms:    p50=%.2f p95=%.2f p99=%.2f max=%.2f\n",
		pct(0.50), pct(0.95), pct(0.99), pct(1.0))
}
