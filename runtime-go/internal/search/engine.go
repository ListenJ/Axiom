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
	n     int
}

func newWorkerPool(n int) *workerPool {
	if n < 1 {
		n = 1
	}
	p := &workerPool{tasks: make(chan func(), n*8), n: n}
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

// scratch bundles the per-query buffers a shard evaluation reuses: the
// scoring board, the bitmap arena for intermediate results and the leaf
// posting-list collector. Keeping them in an engine-owned channel (instead
// of sync.Pool) survives GC cycles, so steady-state queries allocate almost
// nothing. A scratch serves one goroutine at a time.
type scratch struct {
	board  scoreBoard
	arena  bitmapArena
	leaves []leaf
}

func (e *Engine) getScratch() *scratch {
	select {
	case sc := <-e.scratchCh:
		return sc
	default:
		return &scratch{}
	}
}

func (e *Engine) putScratch(sc *scratch) {
	select {
	case e.scratchCh <- sc:
	default:
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

	// cluster is non-nil in cluster mode (see WithCluster); updateMu
	// serializes local copy-on-write swaps so HTTP-routed and
	// cluster-routed updates cannot interleave a read-modify-write.
	cluster  *clusterState
	updateMu sync.Mutex

	// scratchCh recycles per-query scratch buffers (see scratch).
	scratchCh chan *scratch

	queries     atomic.Uint64
	latencyNs   atomic.Uint64
	swaps       atomic.Uint64
	active      atomic.Int64
	lastBuildNs atomic.Int64

	// qcache maps query strings to their parsed and optimized condition
	// trees, so repeated queries skip parsing and cost estimation. Cached
	// trees are immutable after Optimize; optimization only affects
	// evaluation order, never results, so entries stay valid across index
	// swaps. qcacheMu guards the map.
	qcacheMu sync.Mutex
	qcache   map[string]Node
}

// maxQueryCache bounds the compiled-query cache; when full it is cleared
// wholesale (cache misses just re-parse).
const maxQueryCache = 1024

// compiledNode returns the parsed and optimized condition tree for query,
// consulting the cache first. Parse errors are not cached.
func (e *Engine) compiledNode(query string, idx *Index) (Node, error) {
	e.qcacheMu.Lock()
	n, ok := e.qcache[query]
	e.qcacheMu.Unlock()
	if ok {
		return n, nil
	}
	node, err := ParseQuery(query)
	if err != nil {
		return nil, err
	}
	node = Optimize(node, idx)
	e.qcacheMu.Lock()
	if e.qcache == nil {
		e.qcache = make(map[string]Node)
	}
	if len(e.qcache) >= maxQueryCache {
		clear(e.qcache)
	}
	e.qcache[query] = node
	e.qcacheMu.Unlock()
	return node, nil
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
// in which case the Prometheus default registerer/gatherer is used. In
// cluster mode (WithCluster) the cluster's global shard count wins.
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
	if e.cluster != nil {
		numShards = e.cluster.numShards
	}
	e.reg = normalizeRegistry(reg)
	e.m = newMetrics(e.reg.reg, "searchd")
	e.scratchCh = make(chan *scratch, e.pool.n+8)
	e.idx.Store(BuildIndex(nil, numShards, 1))
	return e
}

// Build replaces the index with one built from docs in parallel. It is the
// bulk-load path; incremental changes go through Update. In cluster mode
// only documents owned by the local node are indexed.
func (e *Engine) Build(ctx context.Context, docs []Document) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	start := time.Now()
	idx := BuildIndex(e.filterOwned(docs), len(e.idx.Load().shards), runtime.NumCPU())
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
	if e.cluster != nil {
		return e.clusterUpdate(ctx, upserts, deletes)
	}
	e.applyLocal(upserts, deletes)
	return nil
}

// filterOwned drops documents whose shard belongs to a remote node. In
// single-node mode it returns docs unchanged.
func (e *Engine) filterOwned(docs []Document) []Document {
	if e.cluster == nil {
		return docs
	}
	n := e.numShards()
	out := make([]Document, 0, len(docs))
	for _, d := range docs {
		if e.cluster.owns(shardOfID(d.ID, n)) {
			out = append(out, d)
		}
	}
	return out
}

// Search parses, optimizes and executes query, returning up to limit hits
// ordered by descending score (ties broken by ID).
func (e *Engine) Search(ctx context.Context, query string, limit int) ([]Hit, error) {
	hits, _, err := e.SearchDetailed(ctx, query, limit)
	return hits, err
}

// SearchDetailed is Search plus a partial flag: in cluster mode partial is
// true when some shards could not be queried (unhealthy peer or failed RPC)
// and the result is degraded. In single-node mode partial is always false.
func (e *Engine) SearchDetailed(ctx context.Context, query string, limit int) ([]Hit, bool, error) {
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
	var partial bool
	errCode := ""
	idx := e.idx.Load()
	node, err := e.compiledNode(query, idx)
	if err == nil {
		if e.cluster != nil {
			hits, partial, err = e.clusterSearch(ctx, idx, node, query, limit)
		} else {
			hits, err = e.searchShards(ctx, idx, node, allShardIDs(len(idx.shards)), limit)
		}
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
	return hits, partial, err
}

// allShardIDs returns [0, n) — the full local shard list of a single-node
// engine.
func allShardIDs(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

// searchShards fans the query out to the given local shards on the worker
// pool and merges the per-shard Top-K heaps into a global Top-K. Shards are
// processed in GOMAXPROCS-sized batches so dispatch overhead stays
// proportional to available parallelism rather than shard count.
func (e *Engine) searchShards(ctx context.Context, idx *Index, node Node, shards []int, limit int) ([]Hit, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	tops := make([][]scoredDoc, len(shards))
	groups := min(len(shards), runtime.GOMAXPROCS(0))
	var wg sync.WaitGroup
	for g := 0; g < groups; g++ {
		lo := g * len(shards) / groups
		hi := (g + 1) * len(shards) / groups
		wg.Add(1)
		e.pool.run(func() {
			defer wg.Done()
			sc := e.getScratch()
			defer e.putScratch(sc)
			for i := lo; i < hi; i++ {
				sh := idx.shards[shards[i]]
				sc.arena.reset()
				sc.leaves = sc.leaves[:0]
				alive := sh.aliveMask()
				res := sh.eval(node, alive, false, &sc.leaves, &sc.arena)
				if len(sh.tomb) > 0 {
					res.and(alive)
				}
				tops[i] = sh.topK(res, sc.leaves, limit, &sc.board)
			}
		})
	}
	wg.Wait()

	h := make([]scoredDoc, 0, min(limit, 64))
	for i, ts := range tops {
		for _, sd := range ts {
			sd.shard = shards[i]
			offerTopK(&h, sd, limit)
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
