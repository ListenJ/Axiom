package agent

import (
	"context"
	"sync"
	"time"
)

// Node is a cluster node hosting agents. Reachable reports whether the node
// is alive; it is a function so tests and integrations can plug in real
// heartbeats or a fake.
type Node struct {
	// ID identifies the node.
	ID string `json:"id"`
	// Reachable reports whether the node answers heartbeats.
	Reachable func() bool `json:"-"`
}

// NodeFailover implements the node-level failure recovery layer: when the
// primary node is lost, every agent registered on it is migrated to the
// standby node. The actual rebuild of agent processes is delegated to the
// OnMigrate callback (typically the Cluster, which restarts the agent on
// the target node through the AgentFactory).
type NodeFailover struct {
	mu        sync.Mutex
	primary   *Node
	standby   *Node
	onMigrate func(agentID, fromNode, toNode string)
	metrics   *Metrics
	location  map[string]string // agentID -> nodeID
	failovers int
	failed    bool
}

// NewNodeFailover creates a failover controller watching primary with
// standby as its backup. onMigrate is invoked once per migrated agent and
// may be nil; metrics may be nil.
func NewNodeFailover(primary, standby *Node, onMigrate func(agentID, fromNode, toNode string), metrics *Metrics) *NodeFailover {
	return &NodeFailover{
		primary:   primary,
		standby:   standby,
		onMigrate: onMigrate,
		metrics:   metrics,
		location:  make(map[string]string),
	}
}

// RegisterAgent records that agentID runs on nodeID.
func (f *NodeFailover) RegisterAgent(agentID, nodeID string) {
	f.mu.Lock()
	f.location[agentID] = nodeID
	f.mu.Unlock()
}

// NodeOf returns the node currently hosting agentID.
func (f *NodeFailover) NodeOf(agentID string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.location[agentID]
}

// Failovers returns how many failovers have been executed.
func (f *NodeFailover) Failovers() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.failovers
}

// Check probes the primary once. If it is unreachable and a failover has
// not yet been executed, all of its agents are migrated to the standby and
// true is returned. The failover is executed at most once per controller.
func (f *NodeFailover) Check(ctx context.Context) bool {
	if f.primary.Reachable == nil || f.primary.Reachable() {
		return false
	}
	f.mu.Lock()
	if f.failed {
		f.mu.Unlock()
		return false
	}
	f.failed = true
	var moved []string
	for agentID, nodeID := range f.location {
		if nodeID == f.primary.ID {
			f.location[agentID] = f.standby.ID
			moved = append(moved, agentID)
		}
	}
	f.failovers++
	f.metrics.incFailover()
	cb := f.onMigrate
	from, to := f.primary.ID, f.standby.ID
	f.mu.Unlock()

	for _, agentID := range moved {
		if cb != nil {
			cb(agentID, from, to)
		}
	}
	return true
}

// Start probes the primary every interval until ctx is done.
func (f *NodeFailover) Start(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f.Check(ctx)
		}
	}
}
