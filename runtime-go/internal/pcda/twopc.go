package pcda

import (
	"fmt"
	"sync"
)

// Transition describes one stage migration of a cycle. It is the unit of
// work a Coordinator commits atomically across all participants.
type Transition struct {
	CycleID string
	From    Stage
	To      Stage
}

// Participant is the 2PC participant contract. Implementations must be
// idempotent: Prepare, Commit and Abort may be retried by the coordinator
// after crashes.
//
// A TCC (Try/Confirm/Cancel) variant is intentionally reserved here but not
// implemented: a future TCCParticipant interface would expose
// Try(Transition) / Confirm(Transition) / Cancel(Transition) with the same
// coordinator driving Confirm/Cancel instead of Commit/Abort, trading 2PC's
// synchronous locking for application-level reservation semantics.
type Participant interface {
	// Prepare votes on the transition. A nil error is a YES vote; the
	// participant must then guarantee that a later Commit succeeds.
	Prepare(tx Transition) error
	// Commit applies the transition. Called only after every participant
	// voted YES.
	Commit(tx Transition) error
	// Abort rolls back a prepared transition. Called when any participant
	// voted NO.
	Abort(tx Transition) error
}

// TxError identifies the 2PC phase that failed.
type TxError struct {
	Phase string // "prepare" or "commit"
	Err   error
}

// Error implements the error interface.
func (e *TxError) Error() string { return fmt.Sprintf("2pc %s: %v", e.Phase, e.Err) }

// Unwrap returns the underlying failure.
func (e *TxError) Unwrap() error { return e.Err }

// Coordinator drives two-phase commit across a fixed participant set.
// It is stateless and safe for concurrent use.
type Coordinator struct{}

// NewCoordinator creates a Coordinator.
func NewCoordinator() *Coordinator { return &Coordinator{} }

// Run executes the two-phase commit protocol for tx:
//
//  1. Prepare phase: every participant votes. Any NO vote aborts the
//     transaction and rolls back every participant that already voted YES.
//  2. Commit phase: all participants apply the transition. A commit failure
//     is returned but cannot be rolled back (the prepare-phase YES votes
//     guaranteed commitability, so this indicates a serious defect).
func (c *Coordinator) Run(tx Transition, participants ...Participant) error {
	prepared := make([]Participant, 0, len(participants))
	for _, p := range participants {
		if err := p.Prepare(tx); err != nil {
			// Roll back every participant that already voted YES.
			for _, q := range prepared {
				_ = q.Abort(tx)
			}
			return &TxError{Phase: "prepare", Err: err}
		}
		prepared = append(prepared, p)
	}
	for _, p := range prepared {
		if err := p.Commit(tx); err != nil {
			return &TxError{Phase: "commit", Err: err}
		}
	}
	return nil
}

// MemoryParticipant is the pluggable in-memory Participant implementation.
// It keeps a per-cycle stage table and applies transitions atomically under
// a mutex. FailPrepare/FailCommit inject faults for testing the abort and
// failure paths.
type MemoryParticipant struct {
	mu    sync.Mutex
	state map[string]Stage

	// FailPrepare, when non-nil, makes every Prepare vote NO with this error.
	FailPrepare error
	// FailCommit, when non-nil, makes every Commit fail with this error.
	FailCommit error

	prepareCalls int
	commitCalls  int
	abortCalls   int
}

// NewMemoryParticipant creates an empty in-memory participant.
func NewMemoryParticipant() *MemoryParticipant {
	return &MemoryParticipant{state: make(map[string]Stage)}
}

// Seed inserts a cycle at the given stage, as if it had just been submitted.
func (m *MemoryParticipant) Seed(id string, stage Stage) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state[id] = stage
}

// Stage returns the current stage of a cycle; unknown cycles report the
// zero stage (StagePlan).
func (m *MemoryParticipant) Stage(id string) Stage {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state[id]
}

// Prepare votes YES when the cycle exists and currently sits at tx.From; the
// staged value is held until Commit or Abort.
func (m *MemoryParticipant) Prepare(tx Transition) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.prepareCalls++
	if m.FailPrepare != nil {
		return m.FailPrepare
	}
	cur, ok := m.state[tx.CycleID]
	if !ok {
		return fmt.Errorf("unknown cycle %q", tx.CycleID)
	}
	if cur != tx.From {
		return fmt.Errorf("cycle %q at stage %v, want %v", tx.CycleID, cur, tx.From)
	}
	return nil
}

// Commit applies the prepared transition.
func (m *MemoryParticipant) Commit(tx Transition) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commitCalls++
	if m.FailCommit != nil {
		return m.FailCommit
	}
	m.state[tx.CycleID] = tx.To
	return nil
}

// Abort rolls back a prepared transition; for the in-memory store the
// prepared value was never published, so abort only records the call.
func (m *MemoryParticipant) Abort(tx Transition) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.abortCalls++
	return nil
}
