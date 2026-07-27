package pcda

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// maxBatchSize caps dynamic batch-size growth.
const maxBatchSize = 512

// scaleUpWatermark is the per-worker queue depth that triggers scale-up.
const scaleUpWatermark = 8

// StageHandler processes one batch of cycles at a stage. Implementations
// read cycle payloads and write per-cycle Results; they must treat cycles as
// exclusively owned for the duration of the call and must be idempotent,
// because crash recovery re-executes the current stage (at-least-once).
type StageHandler func(ctx context.Context, cycles []*Cycle) error

// Config tunes an Engine. Zero values pick production-sane defaults.
type Config struct {
	// WorkersPerStage is the initial worker count of every stage pool.
	WorkersPerStage int
	// MinWorkers / MaxWorkers bound runtime scaling (manual and automatic).
	MinWorkers int
	MaxWorkers int
	// BatchSize is the initial per-stage batch target.
	BatchSize int
	// BatchWait is how long a worker waits to fill a partial batch.
	BatchWait time.Duration
	// QueueCapacity is the per-stage, per-priority-lane ring capacity.
	QueueCapacity int
	// MaxRetries is the number of L1 retries after the first attempt.
	MaxRetries int
	// RetryBackoff is the delay between L1 attempts.
	RetryBackoff time.Duration
	// DataDir holds the snapshot and WAL files; empty disables persistence.
	DataDir string
	// SnapshotInterval is the periodic snapshot cadence; 0 disables it.
	SnapshotInterval time.Duration
	// AutoscaleInterval is the resource-control loop cadence; 0 disables it.
	AutoscaleInterval time.Duration
}

// defaults fills unset fields.
func (c *Config) defaults() {
	if c.WorkersPerStage < 1 {
		c.WorkersPerStage = 4
	}
	if c.MinWorkers < 1 {
		c.MinWorkers = 1
	}
	if c.MaxWorkers < c.MinWorkers {
		c.MaxWorkers = 64
	}
	if c.BatchSize < 1 {
		c.BatchSize = 32
	}
	if c.BatchWait <= 0 {
		c.BatchWait = 2 * time.Millisecond
	}
	if c.QueueCapacity < 1 {
		c.QueueCapacity = 4096
	}
	if c.MaxRetries < 0 {
		c.MaxRetries = 0
	}
	if c.RetryBackoff <= 0 {
		c.RetryBackoff = time.Millisecond
	}
}

// cycleState is the published, read-safe snapshot of a live Cycle. Workers
// own the live *Cycle between dequeue and transition; every mutation is
// published into snap under mu so status readers never race with handlers.
type cycleState struct {
	mu   sync.RWMutex
	snap Cycle
}

// StageStats reports one stage's runtime state.
type StageStats struct {
	Workers    int   `json:"workers"`
	QueueDepth int   `json:"queue_depth"`
	BatchSize  int64 `json:"batch_size"`
}

// Stats reports the engine's runtime state, keyed by stage name.
type Stats struct {
	Stages map[string]StageStats `json:"stages"`
	// InFlight is the number of cycles not yet in a terminal state.
	InFlight int `json:"in_flight"`
}

// Engine is the PDCA cycle execution engine: four stage worker pools
// (Plan/Do/Check/Act) connected by priority-aware lock-free queues, with
// 2PC-guarded stage transitions, snapshot+WAL persistence and a
// load-driven resource control loop.
type Engine struct {
	cfg     Config
	metrics *metrics

	pools [stageCount]*stagePool
	coord *Coordinator
	store *MemoryParticipant

	handlerMu sync.RWMutex
	handlers  [stageCount]StageHandler
	degrades  [stageCount]StageHandler

	cycles sync.Map // cycle ID -> *cycleState

	running atomic.Bool
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup // background loops

	// Persistence; wal is nil when DataDir is empty.
	dataDir string
	wal     *wal
}

// NewEngine creates an engine with the given config and metrics registerer.
// A nil reg uses prometheus.DefaultRegisterer.
func NewEngine(cfg Config, reg prometheus.Registerer) *Engine {
	cfg.defaults()
	e := &Engine{
		cfg:     cfg,
		metrics: newMetrics(reg),
		coord:   NewCoordinator(),
		store:   NewMemoryParticipant(),
		dataDir: cfg.DataDir,
	}
	for i, s := range stages {
		e.pools[i] = newStagePool(s, e, cfg.QueueCapacity, cfg.BatchSize, cfg.BatchWait)
	}
	return e
}

// SetHandler installs the handler for a stage. A stage without a handler is
// a pass-through. May be called before or while the engine runs.
func (e *Engine) SetHandler(stage Stage, h StageHandler) {
	e.handlerMu.Lock()
	defer e.handlerMu.Unlock()
	e.handlers[stage] = h
}

// SetDegradeHandler installs the L2 degraded-mode fallback for a stage. It
// runs when the primary handler exhausts its L1 retries.
func (e *Engine) SetDegradeHandler(stage Stage, h StageHandler) {
	e.handlerMu.Lock()
	defer e.handlerMu.Unlock()
	e.degrades[stage] = h
}

// Start launches the worker pools and background loops. When DataDir is
// configured it first recovers state from the latest snapshot plus WAL.
func (e *Engine) Start(ctx context.Context) error {
	if e.running.Swap(true) {
		return observability.NewAppError(ErrCodeStopped, "engine already started")
	}
	e.ctx, e.cancel = context.WithCancel(ctx)

	if e.dataDir != "" {
		w, err := openWAL(e.dataDir)
		if err != nil {
			e.running.Store(false)
			return observability.WrapError(ErrCodePersist, "open WAL", err)
		}
		e.wal = w
		if err := e.Recover(); err != nil {
			e.running.Store(false)
			return err
		}
	}

	for _, p := range e.pools {
		p.start(e.cfg.WorkersPerStage)
	}

	// Re-enqueue cycles that were in flight when the last run stopped.
	if e.dataDir != "" {
		e.cycles.Range(func(_, v any) bool {
			st := v.(*cycleState)
			st.mu.RLock()
			c := st.snap
			st.mu.RUnlock()
			if c.Status == "" || c.Status == StatusPending {
				if c.Stage < StageDone {
					e.pools[c.Stage].enqueue(cloneCycle(&c))
				}
			}
			return true
		})
	}

	if e.cfg.SnapshotInterval > 0 && e.dataDir != "" {
		e.wg.Add(1)
		go e.snapshotLoop(e.cfg.SnapshotInterval)
	}
	if e.cfg.AutoscaleInterval > 0 {
		e.wg.Add(1)
		go e.autoscaleLoop(e.cfg.AutoscaleInterval)
	}
	if e.wal != nil {
		e.wg.Add(1)
		go e.walSyncLoop()
	}
	return nil
}

// Submit accepts a cycle into the engine at StagePlan. The engine takes
// ownership of c until it reaches a terminal status.
func (e *Engine) Submit(c *Cycle) error {
	if !e.running.Load() {
		return observability.NewAppError(ErrCodeStopped, "engine not running")
	}
	if c.ID == "" {
		return observability.NewAppError(ErrCodeNotFound, "cycle ID required")
	}
	st := &cycleState{}
	st.snap = *cloneCycle(c)
	st.snap.Stage = StagePlan
	st.snap.Status = StatusPending
	if _, loaded := e.cycles.LoadOrStore(c.ID, st); loaded {
		return observability.NewAppError(ErrCodeCycleExists, "cycle already exists").
			WithContext("cycle_id", c.ID)
	}
	e.store.Seed(c.ID, StagePlan)
	if err := e.walAppend("submit", &st.snap); err != nil {
		return err
	}
	if !e.pools[StagePlan].enqueue(c) {
		e.cycles.Delete(c.ID)
		return observability.NewAppError(ErrCodeQueueFull, "plan queue saturated").
			WithContext("cycle_id", c.ID)
	}
	return nil
}

// Cycle returns a read-safe copy of the cycle's published state. The second
// return value reports whether the cycle exists.
func (e *Engine) Cycle(id string) (*Cycle, bool) {
	v, ok := e.cycles.Load(id)
	if !ok {
		return nil, false
	}
	st := v.(*cycleState)
	st.mu.RLock()
	defer st.mu.RUnlock()
	return cloneCycle(&st.snap), true
}

// ScaleStage adjusts a stage's worker count at runtime, clamped to the
// configured [MinWorkers, MaxWorkers] bounds.
func (e *Engine) ScaleStage(stage Stage, workers int) error {
	if stage < 0 || stage >= stageCount {
		return observability.NewAppError(ErrCodeNotFound, "unknown stage").
			WithContext("stage", stage.String())
	}
	if workers < e.cfg.MinWorkers {
		workers = e.cfg.MinWorkers
	}
	if workers > e.cfg.MaxWorkers {
		workers = e.cfg.MaxWorkers
	}
	e.pools[stage].setWorkers(workers)
	return nil
}

// Stats reports current per-stage worker counts, queue depths and batch
// sizes, plus the number of in-flight cycles.
func (e *Engine) Stats() Stats {
	s := Stats{Stages: make(map[string]StageStats, stageCount)}
	for _, p := range e.pools {
		s.Stages[p.stage.String()] = StageStats{
			Workers:    p.workerCount(),
			QueueDepth: p.queue.Len(),
			BatchSize:  p.batchSize.Load(),
		}
	}
	e.cycles.Range(func(_, v any) bool {
		st := v.(*cycleState)
		st.mu.RLock()
		terminal := st.snap.Status == StatusCompleted || st.snap.Status == StatusFailed
		st.mu.RUnlock()
		if !terminal {
			s.InFlight++
		}
		return true
	})
	return s
}

// Shutdown stops accepting submissions, halts workers (in-flight batches
// finish), then writes a final snapshot and closes the WAL. Cycles still
// queued are captured by the snapshot and resume on the next Start.
func (e *Engine) Shutdown(ctx context.Context) error {
	if !e.running.Swap(false) {
		return nil
	}
	if e.cancel != nil {
		e.cancel()
	}
	e.wg.Wait()
	for _, p := range e.pools {
		p.stop()
	}
	if e.wal != nil {
		if err := e.Snapshot(); err != nil {
			return err
		}
		if err := e.wal.Sync(); err != nil {
			return observability.WrapError(ErrCodePersist, "WAL sync", err)
		}
		return e.wal.Close()
	}
	return nil
}

// processBatch executes one batch at a stage with the tiered failure policy:
// L1 retry (bounded) -> L2 degrade -> abort.
func (e *Engine) processBatch(stage Stage, batch []*Cycle) {
	start := time.Now()
	retries, err := e.execStage(stage, batch)
	e.metrics.observeStage(stage, len(batch), time.Since(start).Seconds())

	for _, c := range batch {
		if err == nil {
			e.publish(c, func(s *Cycle) {
				s.Results = copyMap(c.Results)
				s.Payload = copyMap(c.Payload)
				s.Retries += retries
			})
			e.advance(stage, c)
			continue
		}
		// L1 exhausted; record the failure before trying L2.
		e.metrics.module.ObserveRequest(time.Since(start).Seconds(), ErrCodeStageFailed)
		e.publish(c, func(s *Cycle) { s.Retries += retries })

		e.handlerMu.RLock()
		degrade := e.degrades[stage]
		e.handlerMu.RUnlock()
		if degrade != nil {
			if derr := degrade(e.ctx, []*Cycle{c}); derr == nil {
				e.publish(c, func(s *Cycle) {
					s.Results = copyMap(c.Results)
					s.Degraded = true
				})
				e.advance(stage, c)
				continue
			}
		}
		e.failCycle(stage, c, observability.WrapError(ErrCodeStageFailed,
			"stage handler failed after retries and degrade", err).
			WithContext("cycle_id", c.ID).WithContext("stage", stage.String()))
	}
}

// execStage runs the stage handler under L1 retry. It returns the number of
// retry attempts spent and the final error (nil on success).
func (e *Engine) execStage(stage Stage, batch []*Cycle) (int, error) {
	e.handlerMu.RLock()
	h := e.handlers[stage]
	e.handlerMu.RUnlock()
	if h == nil {
		return 0, nil // pass-through stage
	}
	rec := observability.SimpleRecovery{
		MaxRetries: e.cfg.MaxRetries + 1, // total attempts = retries + first try
		Backoff:    e.cfg.RetryBackoff,
	}
	calls := 0
	op := func(ctx context.Context) error {
		calls++
		return h(ctx, batch)
	}
	err := rec.Recover(e.ctx, observability.RecoveryRetry, op)
	retries := calls - 1
	if retries < 0 {
		retries = 0
	}
	return retries, err
}

// advance moves a cycle to the next stage through a 2PC transition, then
// either enqueues it there or marks it completed.
func (e *Engine) advance(stage Stage, c *Cycle) {
	next := stage.Next()
	tx := Transition{CycleID: c.ID, From: stage, To: next}
	if err := e.coord.Run(tx, e.store); err != nil {
		e.metrics.twoPCAborts.Inc()
		e.failCycle(stage, c, observability.WrapError(ErrCodeTxAborted,
			"stage transition aborted", err).WithContext("cycle_id", c.ID))
		return
	}
	e.metrics.twoPCCommits.Inc()

	if next == StageDone {
		e.publish(c, func(s *Cycle) {
			s.Stage = StageDone
			s.Status = StatusCompleted
		})
		v, _ := e.cycles.Load(c.ID)
		st := v.(*cycleState)
		st.mu.RLock()
		snap := st.snap
		st.mu.RUnlock()
		e.walAppend("terminal", &snap)
		e.metrics.cyclesCompleted.Inc()
		e.metrics.module.ObserveRequest(0, "")
		return
	}

	e.publish(c, func(s *Cycle) {
		s.Stage = next
		s.Status = StatusPending
	})
	v, _ := e.cycles.Load(c.ID)
	st := v.(*cycleState)
	st.mu.RLock()
	snap := st.snap
	st.mu.RUnlock()
	e.walAppend("transition", &snap)

	c.Stage = next
	if !e.pools[next].enqueue(c) {
		e.failCycle(next, c, observability.NewAppError(ErrCodeQueueFull,
			"next stage queue saturated").WithContext("cycle_id", c.ID))
	}
}

// failCycle marks a cycle terminally failed.
func (e *Engine) failCycle(stage Stage, c *Cycle, err *observability.AppError) {
	e.publish(c, func(s *Cycle) {
		s.Status = StatusFailed
		s.Error = err.LogString()
	})
	v, _ := e.cycles.Load(c.ID)
	st := v.(*cycleState)
	st.mu.RLock()
	snap := st.snap
	st.mu.RUnlock()
	e.walAppend("terminal", &snap)
	e.metrics.cyclesFailed.Inc()
}

// publish applies fn to the cycle's published snapshot under its write lock.
func (e *Engine) publish(c *Cycle, fn func(*Cycle)) {
	v, ok := e.cycles.Load(c.ID)
	if !ok {
		return
	}
	st := v.(*cycleState)
	st.mu.Lock()
	defer st.mu.Unlock()
	fn(&st.snap)
}

// walAppend persists one mutation when the WAL is enabled, tagging the
// snapshot with the assigned sequence number.
func (e *Engine) walAppend(op string, snap *Cycle) error {
	if e.wal == nil {
		return nil
	}
	seq, err := e.wal.Append(op, snap)
	if err != nil {
		return observability.WrapError(ErrCodePersist, "WAL append", err).
			WithContext("cycle_id", snap.ID).WithContext("op", op)
	}
	snap.seq = seq
	return nil
}

// cloneCycle deep-copies a cycle's maps so readers never alias mutable
// handler state.
func cloneCycle(c *Cycle) *Cycle {
	out := *c
	out.Payload = copyMap(c.Payload)
	out.Results = copyMap(c.Results)
	return &out
}

// copyMap returns a copy of m, preserving nil.
func copyMap(m map[string]string) map[string]string {
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
