package agent

import (
	"context"
	"testing"

	"runtime-go/internal/distrib"
)

// Regression: the /internal/run terminal hop must never place a task on a
// remote proxy — a proxy that points back at this node (post-failover
// retarget) would otherwise loop the task over HTTP (observed as a
// placement storm in the two-node joint test).
func TestRunTaskStaysOnLocalAgents(t *testing.T) {
	stub := &remoteStub{t: t}
	srv := newRemoteStubServer(t, stub)
	// Remote proxy IDs (node-a-agent-*) sort before the local agent
	// (node-b-agent-1), so without the exclusion the terminal hop would
	// pick a proxy and forward the task back over HTTP.
	nodes := []distrib.Node{
		{ID: "node-a", Addr: srv.URL},
		{ID: "node-b", Addr: "http://127.0.0.1:1"},
	}
	c, err := NewCluster(ClusterConfig{
		NodeID:        "node-b",
		SelfID:        "node-b",
		Nodes:         nodes,
		InitialAgents: 1,
		AgentsPerNode: 2,
		AgentQuota:    ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 4},
	})
	if err != nil {
		t.Fatalf("NewCluster: %v", err)
	}
	if added, err := c.AddRemoteAgents(); err != nil || added != 2 {
		t.Fatalf("AddRemoteAgents = %d, %v; want 2, nil", added, err)
	}
	if got := len(c.Scheduler.Agents()); got != 3 {
		t.Fatalf("agents = %d, want 3 (1 local + 2 remote)", got)
	}
	if _, err := c.Store.Put(testDef("crawler")); err != nil {
		t.Fatalf("Put: %v", err)
	}

	task := Task{ID: "hop-1", DefName: "crawler", Resources: testDef("crawler").Resources, Idempotent: true}
	res, queued, err := c.RunTask(context.Background(), task)
	if err != nil || queued {
		t.Fatalf("RunTask: queued=%v err=%v", queued, err)
	}
	if res.TaskID != task.ID {
		t.Fatalf("res = %+v", res)
	}
	if stub.runs.Load() != 0 {
		t.Fatalf("terminal hop forwarded to peer: remote runs = %d, want 0", stub.runs.Load())
	}

	// With the only local agent unavailable, RunTask must queue (503 to the
	// peer) rather than fall through to a remote proxy.
	c.Scheduler.SetAvailable("node-b-agent-1", false)
	_, queued, err = c.RunTask(context.Background(), Task{ID: "hop-2", DefName: "crawler", Resources: task.Resources, Idempotent: true})
	if err != nil {
		t.Fatalf("RunTask with local unavailable: err=%v", err)
	}
	if !queued {
		t.Fatal("RunTask should queue when no local agent is available")
	}
	if stub.runs.Load() != 0 {
		t.Fatalf("queued terminal hop forwarded to peer: remote runs = %d", stub.runs.Load())
	}
}

// Regression: a task whose execution fails must release its placement —
// running count, load, and accounted quota (observed as a leaked
// running=85278 after remote failures in the two-node joint test).
func TestExecuteFailureReleasesPlacement(t *testing.T) {
	c := newTestCluster(t)
	if _, err := c.Store.Put(testDef("crawler")); err != nil {
		t.Fatalf("Put: %v", err)
	}

	for _, info := range c.Scheduler.Agents() {
		if fa, ok := c.Health.Agent(info.ID).(*FakeAgent); ok {
			fa.SetHealthy(false)
		}
	}
	if _, _, _, err := c.SubmitTask(context.Background(), "crawler", 0, nil); err == nil {
		t.Fatal("SubmitTask should fail with all agents unhealthy")
	}
	for _, info := range c.Scheduler.Agents() {
		if info.Tasks != 0 {
			t.Fatalf("agent %s running = %d after failure, want 0", info.ID, info.Tasks)
		}
	}

	// Quota freed: after healing, new tasks run again.
	for _, info := range c.Scheduler.Agents() {
		if fa, ok := c.Health.Agent(info.ID).(*FakeAgent); ok {
			fa.SetHealthy(true)
		}
	}
	if _, _, queued, err := c.SubmitTask(context.Background(), "crawler", 0, nil); err != nil || queued {
		t.Fatalf("SubmitTask after healing: queued=%v err=%v", queued, err)
	}
}
