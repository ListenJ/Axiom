package search

import (
	"context"
	"errors"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// workerPool is a fixed set of goroutines executing submitted tasks. When
// the queue is full the caller runs the task inline, which keeps fan-out
// deadlock-free under nested or saturated submission.
type workerPool struct {
	tasks chan func()
}

func newWorkerPool(n int) *workerPool {
	if n < 1 {
		n = 1
	}
	p := &workerPool{tasks: make(chan func(), n*8)}
	for i := 0; i < n; i++ {
		go func() {
			for f := range p.tasks {
				f()
			}
		}()
	}
	return p
}

// run schedules f on the pool, executing it inline if the queue is full.
func (p *workerPool) run(f func()) {
	select {
	case p.tasks <- f:
	default:
		f()
	}
}

// Engine is the concurrent search engine: an immutable index snapshot held
// in an atomic.Pointer (lock-free reads, copy-on-write updates), an
// optional distributed lock serializing updates, a worker pool fanning
// queries out to shards, and metrics.
type Engine struct {
	idx  atomic.Pointer[Index]
	num  atomic.Uint32
	lock DistLock
	pool *workerPool
	m    *Metrics
	reg  engineRegistry

	queries     atomic.Uint64
	latencyNs   atomic.Uint64
	swaps       atomic.Uint64
	active      atomic.Int64
	lastBuildNs atomic.Int64
}

// engineRegistry bundles the registerer used for metrics with the gatherer
// backing the /metrics HTTP endpoint.
type engineRegistry struct {
	reg prometheus.Registerer
	gat prometheus.Gatherer
}

func normalizeRegistry(reg prometheus.Registerer) engineRegistry {
	if reg == nil {
		return engineRegistry{prometheus.DefaultRegisterer, prometheus.DefaultGatherer}
	}
	g, ok := reg.(prometheus.Gatherer)
	if !ok {
		g = prometheus.DefaultGatherer
	}
	return engineRegistry{reg, g}
}

// Option configures an Engine.
type Option func(*Engine)

// WithLock makes updates mutually exclusive through l (MemLock within one
// process, RedisLock across processes).
func WithLock(l DistLock) Option { return func(e *Engine) { e.lock = l } }

// WithWorkers sets the size of the query fan-out worker pool. Values < 1
// mean runtime.NumCPU().
func WithWorkers(n int) Option {
	return func(e *Engine) {
		if n < 1 {
			n = runtime.NumCPU()
		}
		e.pool = newWorkerPool(n)
	}
}

// NewEngine creates an empty engine with numShards shards. reg may be nil,
// in which case the Prometheus default registerer/gatherer is used.
func NewEngine(reg prometheus.Registerer, numShards int, opts ...Option) *Engine {
	if numShards < 1 {
		numShards = 1
	}
	e := &Engine{}
	for _, o := range opts {
		o(e)
	}
	if e.pool == nil {
		e.pool = newWorkerPool(runtime.NumCPU())
	}
	e.reg = normalizeRegistry(reg)
	e.m = newMetrics(e.reg.reg, "searchd")
	e.idx.Store(BuildIndex(nil, numShards, 1))
	return e
}

// Build replaces the index with one built from docs in parallel. It is the
// bulk-load path; incremental changes go through Update.
func (e *Engine) Build(ctx context.Context, docs []Document) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	start := time.Now()
	idx := BuildIndex(docs, len(e.idx.Load().shards), runtime.NumCPU())
	var max uint32
	for _, n := range idx.ids {
		if n >= max {
			max = n + 1
		}
	}
	e.num.Store(max)
	e.idx.Store(idx)
	dur := time.Since(start)
	e.lastBuildNs.Store(int64(dur))
	e.swaps.Add(1)
	e.m.observeBuild(dur.Seconds())
	e.m.observeSwap()
	return nil
}

// Update atomically applies upserts and deletes as one copy-on-write swap,
// so every change is visible to queries as soon as Update returns. When a
// DistLock is configured, concurrent updates (also across processes) are
// serialized through it.
func (e *Engine) Update(ctx context.Context, upserts []Document, deletes []string) error {
	if e.lock != nil {
		waitStart := time.Now()
		unlock, err := e.lock.Lock(ctx, "searchd:index-update", 30*time.Second)
		e.m.observeLockWait(time.Since(waitStart).Seconds())
		if err != nil {
			e.m.observeLockError()
			return err
		}
		defer func() { _ = unlock(context.Background()) }()
	}
	next := func() uint32 { return e.num.Add(1) - 1 }
	e.idx.Store(e.idx.Load().apply(upserts, deletes, next))
	e.swaps.Add(1)
	e.m.observeSwap()
	return nil
}

// Search parses, optimizes and executes query, returning up to limit hits
// ordered by descending score (ties broken by ID).
func (e *Engine) Search(ctx context.Context, query string, limit int) ([]Hit, error) {
	if limit <= 0 {
		limit = 10
	}
	start := time.Now()
	e.active.Add(1)
	e.m.activeInc()
	defer func() {
		e.active.Add(-1)
		e.m.activeDec()
	}()

	var hits []Hit
	errCode := ""
	node, err := ParseQuery(query)
	if err == nil {
		idx := e.idx.Load()
		node = Optimize(node, idx)
		hits, err = e.searchShards(ctx, idx, node, limit)
	}
	if err != nil {
		errCode = "SEARCH_ERROR"
		var ae *observability.AppError
		if errors.As(err, &ae) {
			errCode = ae.Code
		}
	}
	dur := time.Since(start)
	e.m.ObserveRequest(dur.Seconds(), errCode)
	e.queries.Add(1)
	e.latencyNs.Add(uint64(dur))
	return hits, err
}

// searchShards fans the query out to all shards on the worker pool and
// merges the per-shard Top-K heaps into a global Top-K.
func (e *Engine) searchShards(ctx context.Context, idx *Index, node Node, limit int) ([]Hit, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	n := len(idx.shards)
	tops := make([][]scoredDoc, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		sh := idx.shards[i]
		wg.Add(1)
		e.pool.run(func() {
			defer wg.Done()
			var leaves [][]posting
			alive := sh.aliveMask()
			res := sh.eval(node, alive, false, &leaves)
			res.and(alive)
			tops[i] = sh.topK(res, leaves, limit)
		})
	}
	wg.Wait()

	h := docHeap{}
	for i, ts := range tops {
		for _, sd := range ts {
			sd.shard = i
			pushTopK(&h, sd, limit)
		}
	}
	hits := make([]Hit, 0, len(h))
	for _, sd := range h {
		d := idx.shards[sd.shard].docs[sd.num]
		hits = append(hits, Hit{ID: d.id, Title: d.title, Score: sd.score})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].ID < hits[j].ID
	})
	return hits, nil
}

// Stats is a point-in-time snapshot of engine counters for the /stats
// endpoint.
type EngineStats struct {
	Documents     int     `json:"documents"`
	Shards        int     `json:"shards"`
	QueriesTotal  uint64  `json:"queries_total"`
	AvgLatencyMs  float64 `json:"avg_latency_ms"`
	COWSwapsTotal uint64  `json:"cow_swaps_total"`
	LastBuildMs   float64 `json:"last_build_ms"`
	ActiveQueries int64   `json:"active_queries"`
}

// Snapshot returns the current engine statistics.
func (e *Engine) Snapshot() EngineStats {
	q := e.queries.Load()
	var avg float64
	if q > 0 {
		avg = float64(e.latencyNs.Load()) / float64(q) / 1e6
	}
	return EngineStats{
		Documents:     e.idx.Load().docs,
		Shards:        len(e.idx.Load().shards),
		QueriesTotal:  q,
		AvgLatencyMs:  avg,
		COWSwapsTotal: e.swaps.Load(),
		LastBuildMs:   float64(e.lastBuildNs.Load()) / 1e6,
		ActiveQueries: e.active.Load(),
	}
}

// DocCount returns the live document count.
func (e *Engine) DocCount() int { return e.idx.Load().docs }
