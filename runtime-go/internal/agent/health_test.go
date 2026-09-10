package agent

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestHealthCheckerRestartsUnhealthyAgent(t *testing.T) {
	var created []string
	factory := func(id string) AgentProcess {
		created = append(created, id)
		return NewFakeAgent(id)
	}
	h := NewHealthChecker(factory, NewMetrics(nil))

	bad := NewFakeAgent("a1")
	good := NewFakeAgent("a2")
	h.Add(bad)
	h.Add(good)

	bad.SetHealthy(false)
	restarted := h.CheckOnce(context.Background())
	if len(restarted) != 1 || restarted[0] != "a1" {
		t.Fatalf("restarted = %v, want [a1]", restarted)
	}
	if len(created) != 1 || created[0] != "a1" {
		t.Fatalf("factory created = %v, want [a1]", created)
	}
	// The old instance was stopped and replaced by a fresh one.
	if bad.Stops() != 1 {
		t.Fatalf("old agent stops = %d, want 1", bad.Stops())
	}
	if h.Agent("a1") == bad {
		t.Fatal("agent a1 was not replaced")
	}
	if h.Restarts() != 1 {
		t.Fatalf("Restarts = %d, want 1", h.Restarts())
	}

	// All healthy now: nothing happens.
	if r := h.CheckOnce(context.Background()); len(r) != 0 {
		t.Fatalf("second check restarted %v", r)
	}
}

func TestHealthCheckerPeriodic(t *testing.T) {
	factory := func(id string) AgentProcess { return NewFakeAgent(id) }
	h := NewHealthChecker(factory, nil)
	bad := NewFakeAgent("a1")
	h.Add(bad)
	bad.SetHealthy(false)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		h.Start(ctx, 5*time.Millisecond)
		close(done)
	}()
	deadline := time.After(2 * time.Second)
	for h.Restarts() == 0 {
		select {
		case <-deadline:
			t.Fatal("periodic checker never restarted the agent")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	<-done
}

func TestHealthCheckerRemove(t *testing.T) {
	h := NewHealthChecker(func(id string) AgentProcess { return NewFakeAgent(id) }, nil)
	p := NewFakeAgent("a1")
	p.SetHealthy(false)
	h.Add(p)
	h.Remove("a1")
	if r := h.CheckOnce(context.Background()); len(r) != 0 {
		t.Fatalf("removed agent still checked: %v", r)
	}
	if h.Agent("a1") != nil {
		t.Fatal("removed agent still present")
	}
}

func TestFakeAgentRun(t *testing.T) {
	f := NewFakeAgent("a1")
	res, err := f.Run(context.Background(), Task{ID: "t1"})
	if err != nil || res.TaskID != "t1" {
		t.Fatalf("Run = %+v, %v", res, err)
	}
	f.SetHealthy(false)
	if _, err := f.Run(context.Background(), Task{ID: "t2"}); !errors.Is(err, ErrAgentUnhealthy) {
		t.Fatalf("Run on unhealthy = %v", err)
	}
	if err := f.Ping(context.Background()); !errors.Is(err, ErrAgentUnhealthy) {
		t.Fatalf("Ping on unhealthy = %v", err)
	}
}
