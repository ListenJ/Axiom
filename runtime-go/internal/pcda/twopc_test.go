package pcda

import (
	"errors"
	"testing"
)

func TestTwoPCCommitPath(t *testing.T) {
	store := NewMemoryParticipant()
	store.Seed("c1", StagePlan)

	tx := Transition{CycleID: "c1", From: StagePlan, To: StageDo}
	if err := NewCoordinator().Run(tx, store); err != nil {
		t.Fatalf("commit path: %v", err)
	}
	if got := store.Stage("c1"); got != StageDo {
		t.Fatalf("stage after commit = %v, want do", got)
	}
	if store.prepareCalls != 1 || store.commitCalls != 1 || store.abortCalls != 0 {
		t.Fatalf("calls: prepare=%d commit=%d abort=%d",
			store.prepareCalls, store.commitCalls, store.abortCalls)
	}
}

func TestTwoPCAbortOnPrepareFailure(t *testing.T) {
	good := NewMemoryParticipant()
	bad := NewMemoryParticipant()
	good.Seed("c1", StagePlan)
	bad.Seed("c1", StagePlan)
	bad.FailPrepare = errors.New("prepare rejected")

	tx := Transition{CycleID: "c1", From: StagePlan, To: StageDo}
	err := NewCoordinator().Run(tx, good, bad)
	if err == nil {
		t.Fatal("prepare failure must abort the transaction")
	}
	var txErr *TxError
	if !errors.As(err, &txErr) || txErr.Phase != "prepare" {
		t.Fatalf("want prepare-phase TxError, got %v", err)
	}
	// The good participant must be rolled back; no state may leak.
	if got := good.Stage("c1"); got != StagePlan {
		t.Fatalf("good participant stage = %v, want plan (rolled back)", got)
	}
	if good.abortCalls != 1 || good.commitCalls != 0 {
		t.Fatalf("good calls: abort=%d commit=%d", good.abortCalls, good.commitCalls)
	}
	if bad.commitCalls != 0 {
		t.Fatal("failing participant must never see Commit")
	}
}

func TestTwoPCUnknownCyclePrepareFails(t *testing.T) {
	store := NewMemoryParticipant() // not seeded
	tx := Transition{CycleID: "ghost", From: StagePlan, To: StageDo}
	if err := NewCoordinator().Run(tx, store); err == nil {
		t.Fatal("transition for unknown cycle must fail")
	}
	if got := store.Stage("ghost"); got != StagePlan {
		t.Fatalf("ghost cycle stage = %v, want zero value plan", got)
	}
}

func TestTwoPCPrepareVoteIsAtomicAcrossParticipants(t *testing.T) {
	// Second participant fails prepare; first must end in its prior state.
	a, b := NewMemoryParticipant(), NewMemoryParticipant()
	a.Seed("c1", StageCheck)
	b.Seed("c1", StageCheck)
	b.FailPrepare = errors.New("nope")
	err := NewCoordinator().Run(Transition{CycleID: "c1", From: StageCheck, To: StageAct}, a, b)
	if err == nil || a.Stage("c1") != StageCheck || b.Stage("c1") != StageCheck {
		t.Fatalf("atomicity violated: err=%v a=%v b=%v", err, a.Stage("c1"), b.Stage("c1"))
	}
}
