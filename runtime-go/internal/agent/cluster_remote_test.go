package agent

import (
	"context"
	"testing"
	"time"

	"runtime-go/internal/distrib"
)

// newRemoteCluster builds a cluster on selfID with the given nodes and no
// local agents, then registers the remote agent proxies.
func newRemoteCluster(t *testing.T, selfID string, nodes []distrib.Node, agentsPerNode int) *Cluster {
	t.Helper()
	c, err := NewCluster(ClusterConfig{
		NodeID:        selfID,
		SelfID:        selfID,
		Nodes:         nodes,
		AgentsPerNode: agentsPerNode,
		AgentQuota:    ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 4},
	})
	if err != nil {
		t.Fatalf("NewCluster: %v", err)
	}
	return c
}

func TestClusterRemoteAgentsScheduled(t *testing.T) {
	stub := &remoteStub{t: t}
	srv := newRemoteStubServer(t, stub)
	nodes := []distrib.Node{
		{ID: "node-a", Addr: "http://127.0.0.1:1"},
		{ID: "node-b", Addr: srv.URL},
	}
	c := newRemoteCluster(t, "node-a", nodes, 2)

	added, err := c.AddRemoteAgents()
	if err != nil || added != 2 {
		t.Fatalf("AddRemoteAgents = %d, %v; want 2, nil", added, err)
	}
	// Idempotent: a second call registers nothing new.
	added, err = c.AddRemoteAgents()
	if err != nil || added != 0 {
		t.Fatalf("second AddRemoteAgents = %d, %v; want 0, nil", added, err)
	}
	if got := len(c.Scheduler.Agents()); got != 2 {
		t.Fatalf("scheduler agents = %d, want 2", got)
	}

	if _, err := c.Store.Put(testDef("crawler")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	task, res, queued, err := c.SubmitTask(context.Background(), "crawler", 0, nil)
	if err != nil || queued {
		t.Fatalf("SubmitTask: queued=%v err=%v", queued, err)
	}
	if res.TaskID != task.ID {
		t.Fatalf("res = %+v, task = %+v", res, task)
	}
	if stub.runs.Load() != 1 {
		t.Fatalf("remote peer runs = %d, want 1", stub.runs.Load())
	}
}

func TestClusterRemoteNodeUnavailableThenRecovers(t *testing.T) {
	stub := &remoteStub{t: t}
	srv := newRemoteStubServer(t, stub)
	nodes := []distrib.Node{
		{ID: "node-a", Addr: "http://127.0.0.1:1"},
		{ID: "node-b", Addr: srv.URL},
	}
	c := newRemoteCluster(t, "node-a", nodes, 1)
	if _, err := c.AddRemoteAgents(); err != nil {
		t.Fatalf("AddRemoteAgents: %v", err)
	}
	if _, err := c.Store.Put(testDef("crawler")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, _, queued, err := c.SubmitTask(context.Background(), "crawler", 0, nil); err != nil || queued {
		t.Fatalf("warm-up submit: queued=%v err=%v", queued, err)
	}

	// Node lost: its agents stop receiving tasks but stay in the pool.
	c.Registry().MarkUnhealthy("node-b")
	c.SyncRemoteAgents()
	infos := c.Scheduler.Agents()
	if len(infos) != 1 || infos[0].Available {
		t.Fatalf("agents = %+v, want 1 unavailable agent", infos)
	}
	if _, _, queued, err := c.SubmitTask(context.Background(), "crawler", 0, nil); err != nil || !queued {
		t.Fatalf("submit while node down: queued=%v err=%v, want queued", queued, err)
	}
	if stub.runs.Load() != 1 {
		t.Fatalf("peer received a task while unhealthy: runs = %d", stub.runs.Load())
	}

	// Node recovered: the agent rejoins and the queued task is dispatched.
	c.Registry().MarkHealthy("node-b")
	c.SyncRemoteAgents()
	if !c.Scheduler.Agents()[0].Available {
		t.Fatal("agent should be available again after node recovery")
	}
	deadline := time.Now().Add(3 * time.Second)
	for stub.runs.Load() != 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if stub.runs.Load() != 2 {
		t.Fatalf("queued task was not dispatched after recovery: runs = %d", stub.runs.Load())
	}
}

func TestClusterFailoverRetargetsRemoteAgents(t *testing.T) {
	stubP := &remoteStub{t: t}
	srvP := newRemoteStubServer(t, stubP)
	stubB := &remoteStub{t: t}
	srvB := newRemoteStubServer(t, stubB)
	nodes := []distrib.Node{
		{ID: "node-p", Addr: srvP.URL, Role: "primary"},
		{ID: "node-b", Addr: srvB.URL},
	}
	c := newRemoteCluster(t, "node-b", nodes, 1)
	if c.Failover == nil {
		t.Fatal("cluster with a remote primary must wire a NodeFailover")
	}
	if _, err := c.AddRemoteAgents(); err != nil {
		t.Fatalf("AddRemoteAgents: %v", err)
	}
	if _, err := c.Store.Put(testDef("crawler")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, _, queued, err := c.SubmitTask(context.Background(), "crawler", 0, nil); err != nil || queued {
		t.Fatalf("submit to primary: queued=%v err=%v", queued, err)
	}
	if stubP.runs.Load() != 1 || stubB.runs.Load() != 0 {
		t.Fatalf("primary=%d standby=%d, want 1/0", stubP.runs.Load(), stubB.runs.Load())
	}

	// Primary lost: the failover migrates its agents to the standby node.
	c.Registry().MarkUnhealthy("node-p")
	if !c.Failover.Check(context.Background()) {
		t.Fatal("failover did not trigger after primary loss")
	}
	c.SyncRemoteAgents()
	if _, _, queued, err := c.SubmitTask(context.Background(), "crawler", 0, nil); err != nil || queued {
		t.Fatalf("submit after failover: queued=%v err=%v", queued, err)
	}
	if stubB.runs.Load() != 1 || stubP.runs.Load() != 1 {
		t.Fatalf("after failover primary=%d standby=%d, want 1/1", stubP.runs.Load(), stubB.runs.Load())
	}

	// Idempotent: a second check does not fail over again.
	if c.Failover.Check(context.Background()) {
		t.Fatal("duplicate failover")
	}
	if c.Failover.Failovers() != 1 {
		t.Fatalf("Failovers = %d, want 1", c.Failover.Failovers())
	}
}
