package agent

import (
	"context"
	"fmt"
	"sync/atomic"

	"github.com/prometheus/client_golang/prometheus"
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
			_ = c.AddAgent()
		} else {
			_ = c.RemoveAgent()
		}
	}, metrics)

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
		_ = proc.Stop(context.Background())
	}
	return c.Scheduler.RemoveAgent(id)
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

// execute runs t on agentID with the retry policy and reports completion
// to the scheduler (which frees resources, updates the predictor, and
// drains the queue).
func (c *Cluster) execute(ctx context.Context, agentID string, t Task) (TaskResult, error) {
	proc := c.Health.Agent(agentID)
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
	return st
}
