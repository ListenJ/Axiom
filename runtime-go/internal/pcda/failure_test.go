package pcda

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestEngineRetryThenSuccess(t *testing.T) {
	cfg := testConfig()
	cfg.MaxRetries = 3
	e := NewEngine(cfg, nil)

	var calls atomic.Int32
	e.SetHandler(StageDo, func(ctx context.Context, cycles []*Cycle) error {
		if calls.Add(1) <= 2 {
			return errors.New("transient")
		}
		return nil
	})

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	if err := e.Submit(&Cycle{ID: "retry"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	c := waitStatus(t, e, "retry", StatusCompleted)
	if c.Retries != 2 {
		t.Fatalf("retries = %d, want 2", c.Retries)
	}
	if c.Degraded {
		t.Fatal("cycle must not be marked degraded after a retry success")
	}
}

func TestEngineDegradeFallback(t *testing.T) {
	cfg := testConfig()
	cfg.MaxRetries = 1
	e := NewEngine(cfg, nil)

	e.SetHandler(StageCheck, func(ctx context.Context, cycles []*Cycle) error {
		return errors.New("always fails")
	})
	e.SetDegradeHandler(StageCheck, func(ctx context.Context, cycles []*Cycle) error {
		for _, c := range cycles {
			if c.Results == nil {
				c.Results = map[string]string{}
			}
			c.Results["check"] = "degraded"
		}
		return nil
	})

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	if err := e.Submit(&Cycle{ID: "degrade"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	c := waitStatus(t, e, "degrade", StatusCompleted)
	if !c.Degraded {
		t.Fatal("cycle must be marked degraded")
	}
	if c.Results["check"] != "degraded" {
		t.Fatalf("degrade result missing: %v", c.Results)
	}
}

func TestEngineAbortAfterRetriesExhausted(t *testing.T) {
	cfg := testConfig()
	cfg.MaxRetries = 2
	e := NewEngine(cfg, nil)

	var calls atomic.Int32
	e.SetHandler(StagePlan, func(ctx context.Context, cycles []*Cycle) error {
		calls.Add(1)
		return errors.New("permanent")
	})

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	if err := e.Submit(&Cycle{ID: "abort"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	c := waitStatus(t, e, "abort", StatusFailed)
	if !strings.Contains(c.Error, ErrCodeStageFailed) {
		t.Fatalf("error = %q, want code %s", c.Error, ErrCodeStageFailed)
	}
	// MaxRetries=2 -> 3 total attempts.
	if got := calls.Load(); got != 3 {
		t.Fatalf("handler calls = %d, want 3", got)
	}
}

func TestEngineBatchProcessing(t *testing.T) {
	cfg := testConfig()
	cfg.BatchSize = 10
	cfg.BatchWait = 100 * time.Millisecond
	e := NewEngine(cfg, nil)

	var mu sync.Mutex
	var maxBatch, total int
	e.SetHandler(StagePlan, func(ctx context.Context, cycles []*Cycle) error {
		mu.Lock()
		if len(cycles) > maxBatch {
			maxBatch = len(cycles)
		}
		total += len(cycles)
		mu.Unlock()
		return nil
	})

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	const n = 10
	for i := 0; i < n; i++ {
		if err := e.Submit(&Cycle{ID: string(rune('a' + i))}); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}
	for i := 0; i < n; i++ {
		waitStatus(t, e, string(rune('a'+i)), StatusCompleted)
	}

	mu.Lock()
	defer mu.Unlock()
	if total != n {
		t.Fatalf("plan processed %d cycles, want %d", total, n)
	}
	if maxBatch < 2 {
		t.Fatalf("max batch = %d, want >= 2 (batching not happening)", maxBatch)
	}
}

func TestEngineConcurrentSubmission(t *testing.T) {
	cfg := testConfig()
	cfg.WorkersPerStage = 4
	cfg.QueueCapacity = 1024
	e := NewEngine(cfg, nil)

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	const n = 512
	var wg sync.WaitGroup
	for w := 0; w < 16; w++ {
		wg.Add(1)
		go func(base int) {
			defer wg.Done()
			for i := 0; i < n/16; i++ {
				id := "c-" + itoa(base*(n/16)+i)
				for {
					err := e.Submit(&Cycle{ID: id, Priority: Priority(i % 3)})
					if err == nil {
						break
					}
					// Queue-full backpressure: retry after a short pause.
					time.Sleep(time.Millisecond)
				}
			}
		}(w)
	}
	wg.Wait()

	for i := 0; i < n; i++ {
		waitStatus(t, e, "c-"+itoa(i), StatusCompleted)
	}
	if got := e.Stats().InFlight; got != 0 {
		t.Fatalf("in-flight after completion = %d, want 0", got)
	}
}

// itoa converts a small non-negative int to a decimal string without
// importing strconv in the test's hot path.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
