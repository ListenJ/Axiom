package agent

import (
	"context"
	"testing"
)

func TestNodeFailoverMigratesAgents(t *testing.T) {
	primaryUp := true
	primary := &Node{ID: "node-1", Reachable: func() bool { return primaryUp }}
	standby := &Node{ID: "node-2", Reachable: func() bool { return true }}

	var migrated []string
	nf := NewNodeFailover(primary, standby, func(agentID, from, to string) {
		migrated = append(migrated, agentID+":"+from+"->"+to)
	}, NewMetrics(nil))

	nf.RegisterAgent("a1", "node-1")
	nf.RegisterAgent("a2", "node-1")
	nf.RegisterAgent("a3", "node-2")

	// Primary healthy: nothing happens.
	if nf.Check(context.Background()) {
		t.Fatal("failover triggered while primary healthy")
	}
	if len(migrated) != 0 {
		t.Fatalf("migrated = %v", migrated)
	}

	// Primary lost: its agents move to the standby.
	primaryUp = false
	if !nf.Check(context.Background()) {
		t.Fatal("failover not triggered after primary loss")
	}
	if len(migrated) != 2 {
		t.Fatalf("migrated = %v, want 2 entries", migrated)
	}
	for _, id := range []string{"a1", "a2"} {
		if nf.NodeOf(id) != "node-2" {
			t.Fatalf("NodeOf(%s) = %q, want node-2", id, nf.NodeOf(id))
		}
	}
	if nf.NodeOf("a3") != "node-2" {
		t.Fatalf("a3 should stay on node-2, got %q", nf.NodeOf("a3"))
	}
	if nf.Failovers() != 1 {
		t.Fatalf("Failovers = %d, want 1", nf.Failovers())
	}

	// Idempotent: a second check does not fail over again.
	if nf.Check(context.Background()) {
		t.Fatal("duplicate failover")
	}
}

func TestNodeFailoverNoStandbyAgents(t *testing.T) {
	down := &Node{ID: "node-1", Reachable: func() bool { return false }}
	standby := &Node{ID: "node-2", Reachable: func() bool { return true }}
	nf := NewNodeFailover(down, standby, nil, nil)
	if !nf.Check(context.Background()) {
		t.Fatal("expected failover even with zero agents")
	}
	if nf.Failovers() != 1 {
		t.Fatalf("Failovers = %d, want 1", nf.Failovers())
	}
}
