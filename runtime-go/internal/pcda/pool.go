package pcda

import (
	"sync"
	"sync/atomic"
	"time"
)

// batchPool recycles batch buffers between worker iterations to keep the
// steady-state allocation rate near zero.
var batchPool = sync.Pool{
	New: func() any {
		buf := make([]*Cycle, 0, 64)
		return &buf
	},
}

// cyclePool recycles Cycle objects for API layers that churn through many
// short-lived submissions. The engine never releases caller-owned cycles;
// callers that acquired a cycle from AcquireCycle may return it with
// ReleaseCycle once they no longer need it.
var cyclePool = sync.Pool{New: func() any { return &Cycle{} }}

// AcquireCycle returns a reset Cycle from the shared pool.
func AcquireCycle() *Cycle {
	c := cyclePool.Get().(*Cycle)
	*c = Cycle{Priority: PriorityNormal}
	return c
}

// ReleaseCycle returns c to the shared pool. c must not be referenced
// afterwards.
func ReleaseCycle(c *Cycle) { cyclePool.Put(c) }

// stagePool is one stage's worker pool. Workers pull batches from the
// stage's priority lane queue and hand them to the engine for execution.
// The pool scales at runtime: SetWorkers starts or stops workers without
// interrupting in-flight batches.
type stagePool struct {
	stage  Stage
	queue  *laneQueue
	wake   chan struct{} // capacity 1; non-blocking signal from Enqueue
	engine *Engine

	batchSize atomic.Int64
	batchWait time.Duration

	mu      sync.Mutex
	workers map[int]chan struct{} // worker ID -> per-worker stop channel
	nextID  int
	running bool
	wg      sync.WaitGroup
}

// newStagePool creates a pool for stage with the given queue parameters.
func newStagePool(stage Stage, e *Engine, queueCap, batchSize int, batchWait time.Duration) *stagePool {
	p := &stagePool{
		stage:     stage,
		queue:     newLaneQueue(queueCap),
		wake:      make(chan struct{}, 1),
		engine:    e,
		batchWait: batchWait,
		workers:   make(map[int]chan struct{}),
	}
	p.batchSize.Store(int64(batchSize))
	return p
}

// start launches n workers.
func (p *stagePool) start(n int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running = true
	for i := 0; i < n; i++ {
		p.spawnLocked()
	}
}

// spawnLocked starts one worker goroutine. Callers must hold p.mu.
func (p *stagePool) spawnLocked() {
	id := p.nextID
	p.nextID++
	stop := make(chan struct{})
	p.workers[id] = stop
	p.wg.Add(1)
	go p.run(id, stop)
}

// stop terminates all workers and waits for in-flight batches to finish.
func (p *stagePool) stop() {
	p.mu.Lock()
	for _, stop := range p.workers {
		close(stop)
	}
	p.workers = make(map[int]chan struct{})
	p.running = false
	p.mu.Unlock()
	p.wg.Wait()
}

// setWorkers adjusts the pool to exactly n workers.
func (p *stagePool) setWorkers(n int) {
	if n < 1 {
		n = 1
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for len(p.workers) < n {
		p.spawnLocked()
	}
	for len(p.workers) > n {
		// Stop the most recently spawned workers first; they are the
		// most likely to be idle.
		id := p.nextID - 1
		stop, ok := p.workers[id]
		if !ok {
			for k, s := range p.workers {
				id, stop, ok = k, s, true
				break
			}
		}
		delete(p.workers, id)
		close(stop)
	}
}

// workerCount returns the current number of workers.
func (p *stagePool) workerCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.workers)
}

// setBatchSize adjusts the target batch size within [1, maxBatchSize].
func (p *stagePool) setBatchSize(n int) {
	if n < 1 {
		n = 1
	}
	if n > maxBatchSize {
		n = maxBatchSize
	}
	p.batchSize.Store(int64(n))
}

// enqueue inserts c into the stage queue and wakes one worker. It reports
// false when the cycle's lane is full (backpressure).
func (p *stagePool) enqueue(c *Cycle) bool {
	if !p.queue.Enqueue(c) {
		return false
	}
	select {
	case p.wake <- struct{}{}:
	default:
	}
	return true
}

// run is the worker loop: collect a batch, process it, repeat until the
// per-worker stop channel closes.
func (p *stagePool) run(id int, stop chan struct{}) {
	defer p.wg.Done()
	bufp := batchPool.Get().(*[]*Cycle)
	buf := (*bufp)[:0]
	defer func() {
		*bufp = buf[:0]
		batchPool.Put(bufp)
	}()

	for {
		select {
		case <-stop:
			return
		default:
		}
		buf = p.collect(buf, stop)
		if len(buf) == 0 {
			// Stopped with no work, or woken spuriously.
			select {
			case <-stop:
				return
			default:
				continue
			}
		}
		p.engine.processBatch(p.stage, buf)
		buf = buf[:0]
	}
}

// collect dequeues up to the current batch size. After the first item it
// waits at most batchWait for additional items so partial batches still flow
// under low load. It returns early (possibly empty) when stop closes.
func (p *stagePool) collect(buf []*Cycle, stop chan struct{}) []*Cycle {
	bs := int(p.batchSize.Load())
	var deadline time.Time
	for len(buf) < bs {
		if c, ok := p.queue.Dequeue(); ok {
			if len(buf) == 0 {
				deadline = time.Now().Add(p.batchWait)
			}
			buf = append(buf, c)
			continue
		}
		// Queue empty: decide how long to wait for more work.
		wait := p.batchWait
		if len(buf) > 0 {
			wait = time.Until(deadline)
			if wait <= 0 {
				return buf // batch window closed; emit partial batch
			}
		}
		timer := time.NewTimer(wait)
		select {
		case <-p.wake:
			timer.Stop()
		case <-stop:
			timer.Stop()
			return buf
		case <-timer.C:
			if len(buf) > 0 {
				return buf // partial batch after a full window
			}
			// Idle worker: loop and wait again.
		}
	}
	return buf
}
