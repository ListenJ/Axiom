package pcda

import (
	"context"
	"sync"
	"testing"
	"time"
)

// testConfig returns a fast, persistence-free engine config for tests.
func testConfig() Config {
	return Config{
		WorkersPerStage: 2,
		BatchSize:       4,
		BatchWait:       time.Millisecond,
		QueueCapacity:   256,
		MaxRetries:      3,
	}
}

// waitStatus polls until the cycle reaches a terminal status or the timeout
// expires, failing the test on timeout.
func waitStatus(t *testing.T, e *Engine, id string, want CycleStatus) *Cycle {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c, ok := e.Cycle(id); ok && c.Status == want {
			return c
		}
		time.Sleep(time.Millisecond)
	}
	c, _ := e.Cycle(id)
	t.Fatalf("cycle %s did not reach %s in time; last=%+v", id, want, c)
	return nil
}

func TestEngineFourStageFlow(t *testing.T) {
	e := NewEngine(testConfig(), nil)

	var mu sync.Mutex
	var order []string
	record := func(stage Stage) StageHandler {
		return func(ctx context.Context, cycles []*Cycle) error {
			mu.Lock()
			for _, c := range cycles {
				order = append(order, c.ID+":"+stage.String())
			}
			mu.Unlock()
			for _, c := range cycles {
				if c.Results == nil {
					c.Results = map[string]string{}
				}
				c.Results[stage.String()] = "ok"
			}
			return nil
		}
	}
	for _, s := range stages {
		e.SetHandler(s, record(s))
	}

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	if err := e.Submit(&Cycle{ID: "c1", Priority: PriorityNormal}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	c := waitStatus(t, e, "c1", StatusCompleted)
	if c.Stage != StageDone {
		t.Fatalf("stage = %v, want done", c.Stage)
	}
	for _, s := range stages {
		if c.Results[s.String()] != "ok" {
			t.Fatalf("missing result for stage %s: %v", s, c.Results)
		}
	}

	// Verify per-cycle stage order for c1.
	mu.Lock()
	defer mu.Unlock()
	var got []string
	for _, entry := range order {
		if entry[:2] == "c1" {
			got = append(got, entry[3:])
		}
	}
	want := []string{"plan", "do", "check", "act"}
	if len(got) != len(want) {
		t.Fatalf("stage visits = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("stage order = %v, want %v", got, want)
		}
	}
}

func TestEngineCycleNotFound(t *testing.T) {
	e := NewEngine(testConfig(), nil)
	if _, ok := e.Cycle("ghost"); ok {
		t.Fatal("unknown cycle must report not-found")
	}
}

func TestEngineDuplicateSubmitRejected(t *testing.T) {
	e := NewEngine(testConfig(), nil)
	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	if err := e.Submit(&Cycle{ID: "dup"}); err != nil {
		t.Fatalf("first submit: %v", err)
	}
	err := e.Submit(&Cycle{ID: "dup"})
	if err == nil {
		t.Fatal("duplicate submit must fail")
	}
}
