package pcda

import (
	"context"
	"testing"
	"time"
)

// crashRecover submits work to a first engine, takes a snapshot, then
// simulates a crash by abandoning the engine without Shutdown. A second
// engine on the same DataDir must recover an identical state.
func TestRecoverFromSnapshotPlusWAL(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.DataDir = dir
	cfg.SnapshotInterval = 0 // manual snapshots only

	e1 := NewEngine(cfg, nil)
	ctx := context.Background()
	if err := e1.Start(ctx); err != nil {
		t.Fatalf("start e1: %v", err)
	}

	// Completed before the snapshot.
	for _, id := range []string{"s1", "s2"} {
		if err := e1.Submit(&Cycle{ID: id, Payload: map[string]string{"k": id}}); err != nil {
			t.Fatalf("submit %s: %v", id, err)
		}
		waitStatus(t, e1, id, StatusCompleted)
	}
	if err := e1.Snapshot(); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	// Completed after the snapshot: covered by WAL replay only.
	if err := e1.Submit(&Cycle{ID: "w1", Payload: map[string]string{"k": "w1"}}); err != nil {
		t.Fatalf("submit w1: %v", err)
	}
	waitStatus(t, e1, "w1", StatusCompleted)

	// Simulated crash: no graceful Shutdown, no final snapshot.
	e2 := NewEngine(cfg, nil)
	if err := e2.Start(ctx); err != nil {
		t.Fatalf("start e2: %v", err)
	}
	defer e2.Shutdown(ctx)

	for _, id := range []string{"s1", "s2", "w1"} {
		want, ok := e1.Cycle(id)
		if !ok {
			t.Fatalf("e1 lost cycle %s", id)
		}
		got, ok := e2.Cycle(id)
		if !ok {
			t.Fatalf("e2 did not recover cycle %s", id)
		}
		if got.Stage != want.Stage || got.Status != want.Status {
			t.Fatalf("cycle %s: e2=(%v,%v) e1=(%v,%v)",
				id, got.Stage, got.Status, want.Stage, want.Status)
		}
		if got.Payload["k"] != id {
			t.Fatalf("cycle %s payload = %v", id, got.Payload)
		}
	}

	// Stop e1 last: its Shutdown snapshot must not disturb the assertions.
	if err := e1.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown e1: %v", err)
	}
}

// TestRecoverWithoutSnapshot verifies pure WAL replay when no snapshot
// exists yet.
func TestRecoverWithoutSnapshot(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.DataDir = dir

	e1 := NewEngine(cfg, nil)
	ctx := context.Background()
	if err := e1.Start(ctx); err != nil {
		t.Fatalf("start e1: %v", err)
	}
	if err := e1.Submit(&Cycle{ID: "only-wal"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	waitStatus(t, e1, "only-wal", StatusCompleted)
	// Crash before any snapshot.

	e2 := NewEngine(cfg, nil)
	if err := e2.Start(ctx); err != nil {
		t.Fatalf("start e2: %v", err)
	}
	defer e2.Shutdown(ctx)

	c, ok := e2.Cycle("only-wal")
	if !ok || c.Status != StatusCompleted {
		t.Fatalf("recovered cycle = %+v ok=%v", c, ok)
	}
	if err := e1.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown e1: %v", err)
	}
}

// TestRecoverResumesInFlightCycle verifies that a cycle interrupted
// mid-flight is re-enqueued at its recorded stage and runs to completion
// after recovery.
func TestRecoverResumesInFlightCycle(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.DataDir = dir

	block := make(chan struct{})
	e1 := NewEngine(cfg, nil)
	e1.SetHandler(StagePlan, func(ctx context.Context, cycles []*Cycle) error {
		<-block // hold the cycle inside plan
		return nil
	})
	ctx := context.Background()
	if err := e1.Start(ctx); err != nil {
		t.Fatalf("start e1: %v", err)
	}
	if err := e1.Submit(&Cycle{ID: "stuck"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	// Wait until the plan handler actually holds the cycle, then snapshot so
	// the in-flight state is durable.
	time.Sleep(50 * time.Millisecond)
	if err := e1.Snapshot(); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	// Recover while e1 is still blocked: e2 must see the cycle pending at
	// plan and, with an unblocked handler, drive it to completion.
	e2 := NewEngine(cfg, nil)
	if err := e2.Start(ctx); err != nil {
		t.Fatalf("start e2: %v", err)
	}
	defer e2.Shutdown(ctx)

	c, ok := e2.Cycle("stuck")
	if !ok {
		t.Fatal("e2 did not recover in-flight cycle")
	}
	if c.Stage != StagePlan || (c.Status != "" && c.Status != StatusPending) {
		t.Fatalf("recovered state = (%v,%v), want (plan,pending)", c.Stage, c.Status)
	}
	waitStatus(t, e2, "stuck", StatusCompleted)

	close(block)
	// e1's blocked worker now finishes; shut it down.
	if err := e1.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown e1: %v", err)
	}
}
