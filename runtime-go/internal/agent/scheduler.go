package agent

import (
	"errors"
	"sort"
	"sync"
)

// ErrNoAgents is returned when a task is submitted to a scheduler without
// any agents.
var ErrNoAgents = errors.New("agent: no agents available")

// Task is one runnable instance of a TaskDefinition.
type Task struct {
	// ID uniquely identifies the instance.
	ID string `json:"id"`
	// DefName references the task definition.
	DefName string `json:"def_name"`
	// Version pins the definition version to run; 0 means "current".
	Version int `json:"version,omitempty"`
	// Params overrides/extends the definition parameters.
	Params map[string]string `json:"params,omitempty"`
	// Resources is the instance resource footprint.
	Resources ResourceRequirements `json:"resources"`
	// EstimateSeconds is the expected duration, used for scheduling until
	// the agent's predictor has observed real samples.
	EstimateSeconds float64 `json:"estimate_seconds,omitempty"`
	// Idempotent declares whether the task-level recovery layer may retry.
	Idempotent bool `json:"idempotent"`
}

// AgentInfo is a snapshot of one agent's scheduling state.
type AgentInfo struct {
	// ID identifies the agent.
	ID string `json:"id"`
	// Tasks is the number of currently running tasks.
	Tasks int `json:"tasks"`
	// Load is the outstanding predicted busy-seconds.
	Load float64 `json:"load"`
	// Utilization is the accounted CPU utilization (0..1).
	Utilization float64 `json:"utilization"`
	// PredictedDuration is the EMA-predicted task duration in seconds.
	PredictedDuration float64 `json:"predicted_duration"`
	// PredictedMemory is the EMA-predicted task memory in bytes.
	PredictedMemory float64 `json:"predicted_memory"`
}

// agentState is the mutable per-agent scheduling record.
type agentState struct {
	id      string
	running int
	load    float64 // outstanding predicted busy-seconds
	pred    *Predictor
	quota   ResourceQuota
}

// Scheduler assigns tasks to agents with a least-loaded policy: every task
// goes to the agent whose predicted load (outstanding busy-seconds plus the
// EMA-predicted cost of the new task) is smallest. Tasks that no agent can
// currently accommodate are queued and retried when capacity frees up.
type Scheduler struct {
	mu      sync.Mutex
	limiter ResourceLimiter
	metrics *Metrics
	agents  map[string]*agentState
	queue   []Task
	alpha   float64

	// OnDispatch, if set, is invoked (without the scheduler lock held)
	// for every queued task that gets placed during OnTaskCompleted's
	// queue drain. The Cluster uses it to execute drained tasks.
	OnDispatch func(agentID string, t Task)
}

// NewScheduler creates a scheduler accounting resources against limiter.
// metrics may be nil.
func NewScheduler(limiter ResourceLimiter, metrics *Metrics) *Scheduler {
	return &Scheduler{
		limiter: limiter,
		metrics: metrics,
		agents:  make(map[string]*agentState),
		alpha:   0.3,
	}
}

// AddAgent registers an agent and applies its resource quota.
func (s *Scheduler) AddAgent(id string, quota ResourceQuota) error {
	if err := s.limiter.Apply(id, quota); err != nil {
		return err
	}
	s.mu.Lock()
	s.agents[id] = &agentState{id: id, pred: NewPredictor(s.alpha), quota: quota}
	s.mu.Unlock()
	s.metrics.observeAgent(id, 0, 0)
	return nil
}

// RemoveAgent unregisters an agent and removes its quota. Running tasks of
// the agent are the caller's responsibility (see NodeFailover).
func (s *Scheduler) RemoveAgent(id string) error {
	s.mu.Lock()
	delete(s.agents, id)
	s.mu.Unlock()
	return s.limiter.Remove(id)
}

// Submit places t on the least-loaded agent with capacity. If no agent can
// accommodate it right now, t is queued and queued reports true. Queued
// tasks are retried (FIFO) on every OnTaskCompleted.
func (s *Scheduler) Submit(t Task) (agentID string, queued bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.agents) == 0 {
		return "", false, ErrNoAgents
	}
	if id, ok := s.placeLocked(t); ok {
		return id, false, nil
	}
	s.queue = append(s.queue, t)
	s.metrics.setQueueLength(len(s.queue))
	return "", true, nil
}

// OnTaskCompleted records the completion of t on agentID with its observed
// duration and peak memory: it frees the accounted resources, folds the
// sample into the agent's predictor, and drains the pending queue.
func (s *Scheduler) OnTaskCompleted(agentID string, t Task, actualSeconds, actualMemBytes float64) {
	s.mu.Lock()
	if a, ok := s.agents[agentID]; ok {
		if a.running > 0 {
			a.running--
		}
		a.load -= s.predictLocked(a, t)
		if a.load < 0 {
			a.load = 0
		}
		a.pred.Observe(actualSeconds, actualMemBytes)
		s.limiter.Release(agentID, ResourceUsage{
			MemoryBytes: t.Resources.MemoryBytes,
			CPUCores:    t.Resources.CPUCores,
		})
		s.observeAgentLocked(a)
	}
	dispatched := s.drainLocked()
	hook := s.OnDispatch
	s.mu.Unlock()
	if hook != nil {
		for _, d := range dispatched {
			hook(d.agentID, d.task)
		}
	}
}

// dispatchedTask is a queued task that found an agent during a drain.
type dispatchedTask struct {
	agentID string
	task    Task
}

// QueueLen returns the number of pending tasks.
func (s *Scheduler) QueueLen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.queue)
}

// Agents returns a snapshot of all agents, sorted by ID.
func (s *Scheduler) Agents() []AgentInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AgentInfo, 0, len(s.agents))
	for _, a := range s.agents {
		out = append(out, s.infoLocked(a))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// placeLocked assigns t to the least-loaded agent with capacity. Candidates
// are tried in ascending predicted-load order; the first whose limiter
// accepts the task's resources wins.
func (s *Scheduler) placeLocked(t Task) (string, bool) {
	cands := make([]*agentState, 0, len(s.agents))
	for _, a := range s.agents {
		cands = append(cands, a)
	}
	sort.Slice(cands, func(i, j int) bool {
		li := cands[i].load + s.predictLocked(cands[i], t)
		lj := cands[j].load + s.predictLocked(cands[j], t)
		if li != lj {
			return li < lj
		}
		return cands[i].id < cands[j].id
	})
	for _, a := range cands {
		err := s.limiter.Acquire(a.id, ResourceUsage{
			MemoryBytes: t.Resources.MemoryBytes,
			CPUCores:    t.Resources.CPUCores,
		})
		if err != nil {
			continue
		}
		a.running++
		a.load += s.predictLocked(a, t)
		s.observeAgentLocked(a)
		return a.id, true
	}
	return "", false
}

// drainLocked retries queued tasks in FIFO order while capacity is
// available, returning the tasks that were placed.
func (s *Scheduler) drainLocked() []dispatchedTask {
	var dispatched []dispatchedTask
	rest := s.queue[:0]
	for _, t := range s.queue {
		if id, ok := s.placeLocked(t); !ok {
			rest = append(rest, t)
		} else {
			dispatched = append(dispatched, dispatchedTask{agentID: id, task: t})
		}
	}
	s.queue = rest
	s.metrics.setQueueLength(len(s.queue))
	return dispatched
}

// predictLocked returns the predicted busy-seconds of t on a: the agent's
// EMA prediction once it has samples, the task estimate otherwise.
func (s *Scheduler) predictLocked(a *agentState, t Task) float64 {
	if a.pred.Samples() > 0 {
		return a.pred.Duration()
	}
	return t.EstimateSeconds
}

// infoLocked snapshots one agent.
func (s *Scheduler) infoLocked(a *agentState) AgentInfo {
	var util float64
	if a.quota.CPUCores > 0 {
		util = s.limiter.Usage(a.id).CPUCores / a.quota.CPUCores
	}
	return AgentInfo{
		ID:                a.id,
		Tasks:             a.running,
		Load:              a.load,
		Utilization:       util,
		PredictedDuration: a.pred.Duration(),
		PredictedMemory:   a.pred.Memory(),
	}
}

// observeAgentLocked refreshes the per-agent Prometheus gauges.
func (s *Scheduler) observeAgentLocked(a *agentState) {
	info := s.infoLocked(a)
	s.metrics.observeAgent(a.id, info.Tasks, info.Utilization)
}
