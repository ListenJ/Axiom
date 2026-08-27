package agent

import (
	"sync"
	"time"
)

// ScaleAction is an autoscaler decision.
type ScaleAction int

const (
	// ScaleNone keeps the current agent count.
	ScaleNone ScaleAction = iota
	// ScaleUp adds one agent.
	ScaleUp
	// ScaleDown removes one agent.
	ScaleDown
)

func (a ScaleAction) String() string {
	switch a {
	case ScaleUp:
		return "up"
	case ScaleDown:
		return "down"
	default:
		return "none"
	}
}

// AutoscalerConfig tunes the autoscaling controller.
type AutoscalerConfig struct {
	// MinAgents is the lower bound of the agent pool.
	MinAgents int
	// MaxAgents is the upper bound of the agent pool.
	MaxAgents int
	// Cooldown is the minimum interval between two scaling actions
	// (flapping guard).
	Cooldown time.Duration
	// QueuePerAgent is the tolerated pending-queue length per agent;
	// beyond it the controller scales up.
	QueuePerAgent float64
	// ScaleUpUtilization triggers scale-up above this average CPU
	// utilization (0..1), even with an empty queue.
	ScaleUpUtilization float64
	// ScaleDownUtilization triggers scale-down below this average CPU
	// utilization while the queue is empty.
	ScaleDownUtilization float64
}

// ScaleInput is one observation of the cluster state.
type ScaleInput struct {
	// Agents is the current agent count.
	Agents int
	// QueueLen is the scheduler's pending queue length.
	QueueLen int
	// Utilization is the average accounted CPU utilization (0..1).
	Utilization float64
}

// Autoscaler decides when to grow or shrink the agent pool based on the
// task queue length and resource utilization, honoring min/max bounds and
// a cooldown between actions.
type Autoscaler struct {
	cfg       AutoscalerConfig
	apply     func(delta int)
	metrics   *Metrics
	now       func() time.Time
	mu        sync.Mutex
	lastScale time.Time
	scaled    bool
}

// NewAutoscaler creates a controller. apply is invoked with +1/-1 when a
// scaling decision is made (typically Cluster.ScaleBy); metrics may be nil.
func NewAutoscaler(cfg AutoscalerConfig, apply func(delta int), metrics *Metrics) *Autoscaler {
	return &Autoscaler{cfg: cfg, apply: apply, metrics: metrics, now: time.Now}
}

// Evaluate computes the action for in without applying it. It reports
// ScaleNone while a previous action is still inside the cooldown window.
func (a *Autoscaler) Evaluate(in ScaleInput) ScaleAction {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.evaluateLocked(in)
}

// EvaluateAndApply computes the action and, unless it is ScaleNone,
// invokes the apply callback, records the cooldown start, and bumps the
// scale-event metrics.
func (a *Autoscaler) EvaluateAndApply(in ScaleInput) ScaleAction {
	a.mu.Lock()
	act := a.evaluateLocked(in)
	if act != ScaleNone {
		a.lastScale = a.now()
		a.scaled = true
	}
	cb := a.apply
	a.mu.Unlock()

	if act != ScaleNone {
		if cb != nil {
			if act == ScaleUp {
				cb(1)
			} else {
				cb(-1)
			}
		}
		a.metrics.incScale(act.String())
	}
	return act
}

// evaluateLocked implements the scaling policy.
func (a *Autoscaler) evaluateLocked(in ScaleInput) ScaleAction {
	if a.scaled && a.now().Sub(a.lastScale) < a.cfg.Cooldown {
		return ScaleNone
	}
	if in.Agents < a.cfg.MaxAgents &&
		(float64(in.QueueLen) > float64(in.Agents)*a.cfg.QueuePerAgent ||
			in.Utilization > a.cfg.ScaleUpUtilization) {
		return ScaleUp
	}
	if in.Agents > a.cfg.MinAgents &&
		in.QueueLen == 0 && in.Utilization < a.cfg.ScaleDownUtilization {
		return ScaleDown
	}
	return ScaleNone
}
