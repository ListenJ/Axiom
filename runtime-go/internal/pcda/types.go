package pcda

// Stage identifies one phase of the PDCA cycle.
type Stage int

const (
	// StagePlan is the first phase: planning the cycle.
	StagePlan Stage = iota
	// StageDo executes the plan.
	StageDo
	// StageCheck verifies the execution result.
	StageCheck
	// StageAct standardizes or corrects based on the check outcome.
	StageAct
	// StageDone marks a cycle that has passed through all four phases.
	StageDone
)

// stageCount is the number of live (non-terminal) stages.
const stageCount = 4

// stages lists the live stages in execution order.
var stages = [stageCount]Stage{StagePlan, StageDo, StageCheck, StageAct}

// String returns the human-readable stage name.
func (s Stage) String() string {
	switch s {
	case StagePlan:
		return "plan"
	case StageDo:
		return "do"
	case StageCheck:
		return "check"
	case StageAct:
		return "act"
	case StageDone:
		return "done"
	default:
		return "unknown"
	}
}

// Next returns the stage a cycle flows into after completing s. StageDone is
// terminal and maps to itself.
func (s Stage) Next() Stage {
	if s >= StageDone {
		return StageDone
	}
	return s + 1
}

// CycleStatus is the lifecycle state of a cycle.
type CycleStatus string

const (
	// StatusPending means the cycle is accepted but not yet completed.
	StatusPending CycleStatus = "pending"
	// StatusCompleted means the cycle passed all four stages.
	StatusCompleted CycleStatus = "completed"
	// StatusFailed means the cycle was aborted after exhausting retries and
	// the degraded fallback.
	StatusFailed CycleStatus = "failed"
)

// Priority levels. Higher priority cycles are dequeued first by every stage.
type Priority int

const (
	// PriorityLow is background work, processed last.
	PriorityLow Priority = iota
	// PriorityNormal is the default priority.
	PriorityNormal
	// PriorityHigh is urgent work, dequeued before any other lane.
	PriorityHigh
)

// priorityLanes is the number of distinct priority lanes; index 0 is the
// lowest priority.
const priorityLanes = 3

// Cycle is the unit of work flowing through the PDCA engine. A cycle enters
// at StagePlan and passes through Do, Check and Act exactly once unless a
// stage failure aborts it.
type Cycle struct {
	ID       string            `json:"id"`
	Priority Priority          `json:"priority"`
	Payload  map[string]string `json:"payload,omitempty"`

	// Stage is the stage the cycle is currently waiting for or executing in.
	Stage Stage `json:"stage"`
	// Status is the terminal lifecycle state; empty means in flight.
	Status CycleStatus `json:"status,omitempty"`
	// Results accumulates one free-form entry per completed stage.
	Results map[string]string `json:"results,omitempty"`
	// Retries counts stage-handler retry attempts spent across all stages.
	Retries int `json:"retries,omitempty"`
	// Degraded reports whether the last stage ran its degraded fallback.
	Degraded bool `json:"degraded,omitempty"`
	// Error carries the last stage error code/message for observability.
	Error string `json:"error,omitempty"`

	// seq is the WAL sequence number of the last persisted mutation; it is
	// used to cut the WAL after a snapshot.
	seq uint64
}

// lane returns the priority lane index for the cycle.
func (c *Cycle) lane() int {
	p := int(c.Priority)
	if p < 0 {
		return 0
	}
	if p >= priorityLanes {
		return priorityLanes - 1
	}
	return p
}

// laneQueue is a priority queue built from one lock-free ring per priority
// lane. Dequeue always drains the highest non-empty lane first, preserving
// FIFO order inside a lane. Enqueue reports false on a full lane so callers
// can apply backpressure.
type laneQueue struct {
	lanes [priorityLanes]*ring
}

// newLaneQueue creates a lane queue where each lane holds capacity items.
func newLaneQueue(capacity int) *laneQueue {
	q := &laneQueue{}
	for i := range q.lanes {
		q.lanes[i] = newRing(capacity)
	}
	return q
}

// Enqueue inserts c into its priority lane. It reports false when the lane
// is full (backpressure signal).
func (q *laneQueue) Enqueue(c *Cycle) bool {
	return q.lanes[c.lane()].Enqueue(c)
}

// Dequeue removes the highest-priority cycle available. It reports false
// when every lane is empty.
func (q *laneQueue) Dequeue() (*Cycle, bool) {
	for i := priorityLanes - 1; i >= 0; i-- {
		if v, ok := q.lanes[i].Dequeue(); ok {
			return v.(*Cycle), true
		}
	}
	return nil, false
}

// Len returns the approximate total queue depth across all lanes.
func (q *laneQueue) Len() int {
	n := 0
	for _, l := range q.lanes {
		n += l.Len()
	}
	return n
}
