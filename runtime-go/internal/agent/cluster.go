package agent

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/distrib"
)

// ClusterConfig wires a Cluster.
type ClusterConfig struct {
	// NodeID identifies the node this cluster process represents.
	NodeID string
	// AgentQuota is the resource quota applied to every agent.
	AgentQuota ResourceQuota
	// InitialAgents is the size of the agent pool at startup.
	InitialAgents int
	// Autoscale configures the autoscaler.
	Autoscale AutoscalerConfig
	// Retry configures the task-level recovery layer. The zero value
	// uses DefaultRetryPolicy.
	Retry RetryPolicy
	// Factory builds agent processes; nil uses FakeAgent.
	Factory AgentFactory
	// Limiter isolates agent resources; nil uses NewPlatformLimiter().
	Limiter ResourceLimiter
	// Store persists task definitions; nil uses a MemoryConfigStore.
	Store ConfigStore
	// Registry receives the Prometheus collectors; nil uses the default.
	Registry prometheus.Registerer
	// Nodes, when non-empty, lists every cluster node (including this one)
	// and turns on multi-node mode: node health is tracked through a
	// distrib.Registry and AddRemoteAgents can register proxies for the
	// agents hosted on healthy peer nodes. Empty keeps single-node
	// behavior unchanged.
	Nodes []distrib.Node
	// SelfID identifies this node within Nodes; it defaults to NodeID.
	SelfID string
	// AgentsPerNode is how many remote agent proxies AddRemoteAgents
	// registers per healthy peer node; values <= 0 mean 1.
	AgentsPerNode int
	// RemoteTimeout bounds each remote agent RPC; values <= 0 use
	// DefaultRemoteTimeout.
	RemoteTimeout time.Duration
}

// NodeStatus is the health view of one cluster node.
type NodeStatus struct {
	// ID identifies the node.
	ID string `json:"id"`
	// Addr is the node base URL.
	Addr string `json:"addr"`
	// Role is the configured node role (e.g. "primary").
	Role string `json:"role,omitempty"`
	// Healthy reports the last known heartbeat outcome.
	Healthy bool `json:"healthy"`
	// Self marks the node this cluster process runs on.
	Self bool `json:"self,omitempty"`
}

// ClusterStatus is a point-in-time snapshot of the whole cluster.
type ClusterStatus struct {
	// NodeID identifies this node.
	NodeID string `json:"node_id"`
	// Agents is the current agent count.
	Agents int `json:"agents"`
	// QueueLen is the pending task count.
	QueueLen int `json:"queue_length"`
	// Restarts is the agent-level restart count.
	Restarts int `json:"restarts"`
	// Failovers is the node-level failover count.
	Failovers int `json:"failovers"`
	// Nodes is the per-node health view; empty in single-node mode.
	Nodes []NodeStatus `json:"nodes,omitempty"`
}

// Cluster assembles the framework pieces — config store, scheduler,
// health checker, autoscaler, failover, and metrics — behind one facade.
type Cluster struct {
	// Store holds the versioned task definitions.
	Store ConfigStore
	// Scheduler assigns tasks to agents.
	Scheduler *Scheduler
	// Health runs the agent-level recovery layer.
	Health *HealthChecker
	// Autoscaler runs the scaling controller.
	Autoscaler *Autoscaler
	// Failover runs the node-level recovery layer; nil when the cluster
	// was built without standby configuration.
	Failover *NodeFailover
	// Metrics exposes the Prometheus collectors.
	Metrics *Metrics

	nodeID  string
	quota   ResourceQuota
	factory AgentFactory
	retry   RetryPolicy
	seq     atomic.Int64

	// Multi-node state; registry is nil in single-node mode.
	registry      *distrib.Registry
	agentsPerNode int
	remoteTimeout time.Duration
	remoteMu      sync.Mutex
	remotes       map[string]*RemoteAgent // agentID -> proxy
	remoteNode    map[string]string       // agentID -> hosting node ID
}

// NewCluster builds a cluster from cfg and starts the initial agent pool.
func NewCluster(cfg ClusterConfig) (*Cluster, error) {
	if cfg.NodeID == "" {
		cfg.NodeID = "node-1"
	}
	if cfg.Factory == nil {
		cfg.Factory = func(id string) AgentProcess { return NewFakeAgent(id) }
	}
	if cfg.Limiter == nil {
		cfg.Limiter = NewPlatformLimiter()
	}
	if cfg.Store == nil {
		cfg.Store = NewMemoryConfigStore()
	}
	if cfg.Retry.MaxAttempts == 0 {
		cfg.Retry = DefaultRetryPolicy()
	}

	metrics := NewMetrics(cfg.Registry)
	c := &Cluster{
		Store:   cfg.Store,
		Metrics: metrics,
		nodeID:  cfg.NodeID,
		quota:   cfg.AgentQuota,
		factory: cfg.Factory,
		retry:   cfg.Retry,
	}
	c.Scheduler = NewScheduler(cfg.Limiter, metrics)
	c.Health = NewHealthChecker(cfg.Factory, metrics)
	c.Scheduler.OnDispatch = func(agentID string, t Task) {
		go c.execute(context.Background(), agentID, t)
	}
	c.Autoscaler = NewAutoscaler(cfg.Autoscale, func(delta int) {
		if delta > 0 {
			// M13 审计修复：扩缩容失败不再静默，记录告警便于运维定位
			if err := c.AddAgent(); err != nil {
				slog.Warn("autoscale: add agent failed", "err", err)
			}
		} else {
			if err := c.RemoveAgent(); err != nil {
				slog.Warn("autoscale: remove agent failed", "err", err)
			}
		}
	}, metrics)

	if len(cfg.Nodes) > 0 {
		selfID := cfg.SelfID
		if selfID == "" {
			selfID = cfg.NodeID
		}
		c.registry = distrib.NewRegistry(cfg.Nodes, selfID)
		c.agentsPerNode = cfg.AgentsPerNode
		if c.agentsPerNode <= 0 {
			c.agentsPerNode = 1
		}
		c.remoteTimeout = cfg.RemoteTimeout
		c.remotes = make(map[string]*RemoteAgent)
		c.remoteNode = make(map[string]string)
		c.wireFailover()
	}

	for i := 0; i < cfg.InitialAgents; i++ {
		if err := c.AddAgent(); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// AddAgent grows the pool by one agent.
func (c *Cluster) AddAgent() error {
	id := fmt.Sprintf("%s-agent-%d", c.nodeID, c.seq.Add(1))
	if err := c.Scheduler.AddAgent(id, c.quota); err != nil {
		return err
	}
	proc := c.factory(id)
	c.Health.Add(proc)
	if c.Failover != nil {
		c.Failover.RegisterAgent(id, c.nodeID)
	}
	return nil
}

// RemoveAgent shrinks the pool by one agent (the last registered).
func (c *Cluster) RemoveAgent() error {
	infos := c.Scheduler.Agents()
	if len(infos) == 0 {
		return ErrNoAgents
	}
	id := infos[len(infos)-1].ID
	proc := c.Health.Agent(id)
	c.Health.Remove(id)
	if proc != nil {
		// M13 审计修复：Stop 失败记录告警（进程可能残留）
		if err := proc.Stop(context.Background()); err != nil {
			slog.Warn("remove agent: process stop failed", "agent", id, "err", err)
		}
	}
	return c.Scheduler.RemoveAgent(id)
}

// wireFailover builds the node-level recovery layer for multi-node mode:
// when this node is not the primary, it watches the remote primary through
// the registry's health view and migrates that node's agents onto the
// local standby (this node) on loss. When this node is the primary or no
// primary is configured, Failover stays nil.
func (c *Cluster) wireFailover() {
	self := c.registry.Self()
	if self.ID == "" {
		return
	}
	var primaryID string
	for _, n := range c.registry.Others() {
		if n.Role == "primary" {
			primaryID = n.ID
			break
		}
	}
	if primaryID == "" {
		return
	}
	reg := c.registry
	primary := &Node{ID: primaryID, Reachable: func() bool { return reg.IsHealthy(primaryID) }}
	standby := &Node{ID: self.ID, Reachable: func() bool { return true }}
	c.Failover = NewNodeFailover(primary, standby, c.retargetRemote, c.Metrics)
}

// Registry returns the node health registry, or nil in single-node mode.
func (c *Cluster) Registry() *distrib.Registry { return c.registry }

// AddRemoteAgents registers AgentsPerNode remote agent proxies for every
// healthy peer node and reports how many were added. It is idempotent:
// proxies that already exist are skipped. A nil registry (single-node
// mode) is a no-op.
func (c *Cluster) AddRemoteAgents() (int, error) {
	if c.registry == nil {
		return 0, nil
	}
	added := 0
	for _, node := range c.registry.Others() {
		if !c.registry.IsHealthy(node.ID) {
			continue
		}
		for i := 0; i < c.agentsPerNode; i++ {
			id := fmt.Sprintf("%s-agent-%d", node.ID, i+1)
			c.remoteMu.Lock()
			_, dup := c.remotes[id]
			c.remoteMu.Unlock()
			if dup {
				continue
			}
			if err := c.Scheduler.AddAgent(id, c.quota); err != nil {
				return added, err
			}
			c.remoteMu.Lock()
			c.remotes[id] = NewRemoteAgent(id, node, c.remoteTimeout)
			c.remoteNode[id] = node.ID
			c.remoteMu.Unlock()
			if c.Failover != nil {
				c.Failover.RegisterAgent(id, node.ID)
			}
			added++
		}
	}
	return added, nil
}

// SyncRemoteAgents reconciles each remote agent's scheduling availability
// with the health of the node currently hosting it: agents on unhealthy
// nodes are marked unavailable (kept in the pool, skipped by placement)
// and agents on recovered nodes rejoin. The node watch loop and tests call
// it; it is a no-op in single-node mode.
func (c *Cluster) SyncRemoteAgents() {
	if c.registry == nil {
		return
	}
	c.remoteMu.Lock()
	links := make(map[string]string, len(c.remoteNode))
	for id, nodeID := range c.remoteNode {
		links[id] = nodeID
	}
	c.remoteMu.Unlock()
	for id, nodeID := range links {
		c.Scheduler.SetAvailable(id, c.registry.IsHealthy(nodeID))
	}
}

// StartNodeWatch runs SyncRemoteAgents every interval until ctx is done.
func (c *Cluster) StartNodeWatch(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.SyncRemoteAgents()
		}
	}
}

// retargetRemote implements the NodeFailover migration callback: the proxy
// of an agent that lived on a lost node is pointed at the standby node, so
// subsequent runs (including retries of in-flight tasks) reach the standby.
func (c *Cluster) retargetRemote(agentID, _, toNode string) {
	var target distrib.Node
	found := false
	for _, n := range append(c.registry.Others(), c.registry.Self()) {
		if n.ID == toNode {
			target, found = n, true
			break
		}
	}
	if !found {
		return
	}
	c.remoteMu.Lock()
	ra := c.remotes[agentID]
	c.remoteNode[agentID] = toNode
	c.remoteMu.Unlock()
	if ra != nil {
		ra.Retarget(target)
	}
}

// remoteAgent returns the remote proxy for agentID, or nil.
func (c *Cluster) remoteAgent(agentID string) *RemoteAgent {
	c.remoteMu.Lock()
	defer c.remoteMu.Unlock()
	return c.remotes[agentID]
}

// SubmitTask resolves the referenced definition version, schedules the
// task, and — when an agent has capacity — executes it synchronously
// through the task-level recovery layer (retries only when the definition
// is idempotent). queued reports that no agent currently has capacity; the
// task then waits in the scheduler queue and is dispatched asynchronously
// when capacity frees up.
func (c *Cluster) SubmitTask(ctx context.Context, defName string, version int, params map[string]string) (Task, TaskResult, bool, error) {
	var def TaskDefVersion
	var err error
	if version > 0 {
		def, err = c.Store.GetVersion(defName, version)
	} else {
		def, err = c.Store.Get(defName)
	}
	if err != nil {
		return Task{}, TaskResult{}, false, err
	}
	t := Task{
		ID:         fmt.Sprintf("task-%d", c.seq.Add(1)),
		DefName:    defName,
		Version:    def.Version,
		Params:     params,
		Resources:  ResourceRequirements(def.Def.Resources),
		Idempotent: def.Def.Idempotent,
	}
	agentID, queued, err := c.Scheduler.Submit(t)
	if err != nil || queued {
		return t, TaskResult{}, queued, err
	}
	res, err := c.execute(ctx, agentID, t)
	return t, res, false, err
}

// RunTask schedules an already-materialized task and executes it
// synchronously through the task-level recovery layer. It backs the
// /internal/run endpoint that serves RemoteAgent proxies on peer nodes.
// queued reports that no agent currently has capacity; the caller should
// signal the peer to retry later.
func (c *Cluster) RunTask(ctx context.Context, t Task) (TaskResult, bool, error) {
	// Terminal hop: place only on local agents. Re-entering a remote proxy
	// here would forward the task back over HTTP and loop.
	agentID, queued, err := c.Scheduler.SubmitExcluding(t, c.isRemoteAgent)
	if err != nil || queued {
		return TaskResult{}, queued, err
	}
	res, err := c.execute(ctx, agentID, t)
	return res, false, err
}

// isRemoteAgent reports whether id belongs to a RemoteAgent proxy.
func (c *Cluster) isRemoteAgent(id string) bool {
	c.remoteMu.Lock()
	defer c.remoteMu.Unlock()
	_, ok := c.remotes[id]
	return ok
}

// execute runs t on agentID with the retry policy and reports completion
// to the scheduler (which frees resources, updates the predictor, and
// drains the queue).
func (c *Cluster) execute(ctx context.Context, agentID string, t Task) (TaskResult, error) {
	proc := c.Health.Agent(agentID)
	if proc == nil {
		if ra := c.remoteAgent(agentID); ra != nil {
			proc = ra
		}
	}
	if proc == nil {
		return TaskResult{}, fmt.Errorf("agent: process %q not found", agentID)
	}
	var res TaskResult
	err := Retry(ctx, c.retry, t.Idempotent, func(ctx context.Context) error {
		var err error
		res, err = proc.Run(ctx, t)
		return err
	}, func(int) { c.Metrics.incRetry() })
	if err != nil {
		// Free the placement: a failed task must not leak the agent's
		// running count, load, or accounted quota.
		c.Scheduler.OnTaskFailed(agentID, t)
		return res, err
	}
	c.Scheduler.OnTaskCompleted(agentID, t, res.DurationSeconds, res.PeakMemoryBytes)
	return res, nil
}

// EvaluateAutoscale samples the cluster state and applies one autoscaling
// decision, returning the action taken.
func (c *Cluster) EvaluateAutoscale() ScaleAction {
	infos := c.Scheduler.Agents()
	var utilSum float64
	for _, info := range infos {
		utilSum += info.Utilization
	}
	var avg float64
	if len(infos) > 0 {
		avg = utilSum / float64(len(infos))
	}
	return c.Autoscaler.EvaluateAndApply(ScaleInput{
		Agents:      len(infos),
		QueueLen:    c.Scheduler.QueueLen(),
		Utilization: avg,
	})
}

// Status snapshots the cluster state.
func (c *Cluster) Status() ClusterStatus {
	st := ClusterStatus{
		NodeID:   c.nodeID,
		Agents:   len(c.Scheduler.Agents()),
		QueueLen: c.Scheduler.QueueLen(),
		Restarts: c.Health.Restarts(),
	}
	if c.Failover != nil {
		st.Failovers = c.Failover.Failovers()
	}
	if c.registry != nil {
		self := c.registry.Self()
		for _, n := range append(c.registry.Others(), self) {
			if n.ID == "" {
				continue
			}
			st.Nodes = append(st.Nodes, NodeStatus{
				ID:      n.ID,
				Addr:    n.Addr,
				Role:    n.Role,
				Healthy: c.registry.IsHealthy(n.ID),
				Self:    n.ID == self.ID,
			})
		}
	}
	return st
}
