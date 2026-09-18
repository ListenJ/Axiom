package agent

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// ErrAgentUnhealthy is returned by an AgentProcess that is not operational.
var ErrAgentUnhealthy = errors.New("agent: process unhealthy")

// TaskResult reports the outcome of one task execution on an agent.
type TaskResult struct {
	// TaskID identifies the executed task.
	TaskID string `json:"task_id"`
	// DurationSeconds is the observed wall-clock execution time.
	DurationSeconds float64 `json:"duration_seconds"`
	// PeakMemoryBytes is the observed peak memory consumption.
	PeakMemoryBytes float64 `json:"peak_memory_bytes"`
}

// AgentProcess abstracts a running agent instance: something that can be
// health-checked, execute tasks, and be stopped. A restart means building a
// fresh instance through an AgentFactory, not resurrecting the old object.
type AgentProcess interface {
	// ID identifies the agent.
	ID() string
	// Ping reports whether the agent is healthy.
	Ping(ctx context.Context) error
	// Run executes one task and reports its observed resource profile.
	Run(ctx context.Context, t Task) (TaskResult, error)
	// Stop terminates the agent instance.
	Stop(ctx context.Context) error
}

// AgentFactory builds a fresh agent instance with the given ID.
type AgentFactory func(id string) AgentProcess

// FakeAgent is an in-memory AgentProcess for tests and local runs. Its
// health can be flipped with SetHealthy to exercise recovery paths, and Run
// can simulate a duration so the scheduler's predictor receives samples.
type FakeAgent struct {
	id          string
	healthy     atomic.Bool
	SimDuration time.Duration
	mu          sync.Mutex
	pings       int
	stops       int
}

// NewFakeAgent creates a healthy fake agent.
func NewFakeAgent(id string) *FakeAgent {
	f := &FakeAgent{id: id}
	f.healthy.Store(true)
	return f
}

// ID implements AgentProcess.
func (f *FakeAgent) ID() string { return f.id }

// SetHealthy flips the health state.
func (f *FakeAgent) SetHealthy(ok bool) { f.healthy.Store(ok) }

// Ping implements AgentProcess.
func (f *FakeAgent) Ping(context.Context) error {
	f.mu.Lock()
	f.pings++
	f.mu.Unlock()
	if !f.healthy.Load() {
		return ErrAgentUnhealthy
	}
	return nil
}

// Run implements AgentProcess, sleeping SimDuration (if any) to simulate
// work and reporting it as the observed duration.
func (f *FakeAgent) Run(ctx context.Context, t Task) (TaskResult, error) {
	if !f.healthy.Load() {
		return TaskResult{}, ErrAgentUnhealthy
	}
	if f.SimDuration > 0 {
		select {
		case <-ctx.Done():
			return TaskResult{}, ctx.Err()
		case <-time.After(f.SimDuration):
		}
	}
	return TaskResult{
		TaskID:          t.ID,
		DurationSeconds: f.SimDuration.Seconds(),
		PeakMemoryBytes: float64(t.Resources.MemoryBytes),
	}, nil
}

// Stop implements AgentProcess.
func (f *FakeAgent) Stop(context.Context) error {
	f.mu.Lock()
	f.stops++
	f.mu.Unlock()
	f.healthy.Store(false)
	return nil
}

// Pings returns how many Ping calls the agent received.
func (f *FakeAgent) Pings() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pings
}

// Stops returns how many Stop calls the agent received.
func (f *FakeAgent) Stops() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stops
}

// HealthChecker implements the agent-level failure recovery layer: it
// periodically pings every registered agent and replaces unhealthy ones
// with fresh instances built by the factory.
type HealthChecker struct {
	mu       sync.Mutex
	factory  AgentFactory
	metrics  *Metrics
	agents   map[string]AgentProcess
	restarts int
}

// NewHealthChecker creates a checker whose restarts are built by factory.
// metrics may be nil.
func NewHealthChecker(factory AgentFactory, metrics *Metrics) *HealthChecker {
	return &HealthChecker{factory: factory, metrics: metrics, agents: make(map[string]AgentProcess)}
}

// Add registers an agent process.
func (h *HealthChecker) Add(p AgentProcess) {
	h.mu.Lock()
	h.agents[p.ID()] = p
	h.mu.Unlock()
}

// Remove unregisters an agent without stopping it.
func (h *HealthChecker) Remove(id string) {
	h.mu.Lock()
	delete(h.agents, id)
	h.mu.Unlock()
}

// Agent returns the current process for id, or nil.
func (h *HealthChecker) Agent(id string) AgentProcess {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.agents[id]
}

// Restarts returns how many restarts the checker has performed.
func (h *HealthChecker) Restarts() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.restarts
}

// CheckOnce pings every agent once and restarts those that fail, returning
// the IDs of the restarted agents.
func (h *HealthChecker) CheckOnce(ctx context.Context) []string {
	h.mu.Lock()
	procs := make([]AgentProcess, 0, len(h.agents))
	for _, p := range h.agents {
		procs = append(procs, p)
	}
	h.mu.Unlock()

	var restarted []string
	for _, p := range procs {
		if p.Ping(ctx) == nil {
			continue
		}
		_ = p.Stop(ctx)
		h.mu.Lock()
		// Only replace if nobody else swapped the process meanwhile.
		if h.agents[p.ID()] == p {
			h.agents[p.ID()] = h.factory(p.ID())
			h.restarts++
			restarted = append(restarted, p.ID())
			h.metrics.incRestart()
		}
		h.mu.Unlock()
	}
	return restarted
}

// Start runs CheckOnce every interval until ctx is done.
func (h *HealthChecker) Start(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.CheckOnce(ctx)
		}
	}
}
