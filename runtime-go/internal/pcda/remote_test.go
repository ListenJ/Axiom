package pcda

import (
	"errors"
	"net/http/httptest"
	"testing"
	"time"
)

// newTxServer starts a participant-side tx endpoint backed by a fresh
// MemoryParticipant, simulating a second pcdad instance.
func newTxServer(t *testing.T) (*MemoryParticipant, *httptest.Server) {
	t.Helper()
	return newTxServerWith(t, NewMemoryParticipant())
}

// newTxServerWith serves mp over the tx endpoint.
func newTxServerWith(t *testing.T, mp *MemoryParticipant) (*MemoryParticipant, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(NewTxHandler(mp))
	t.Cleanup(srv.Close)
	return mp, srv
}

func TestRemoteTwoPhaseCommitAcrossInstances(t *testing.T) {
	// Coordinator runs here (node A) with one local participant; the
	// second participant lives behind another instance's HTTP endpoint
	// (node B).
	local := NewMemoryParticipant()
	local.Seed("c1", StagePlan)
	remote, srvB := newTxServer(t)
	remote.Seed("c1", StagePlan)
	rp := NewRemoteParticipant(srvB.URL, time.Second)

	tx := Transition{CycleID: "c1", From: StagePlan, To: StageDo}
	if err := NewCoordinator().Run(tx, local, rp); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := local.Stage("c1"); got != StageDo {
		t.Fatalf("local stage = %v, want do", got)
	}
	if got := remote.Stage("c1"); got != StageDo {
		t.Fatalf("remote stage = %v, want do", got)
	}
}

func TestRemotePrepareRejectAbortsAll(t *testing.T) {
	// Two remote participants on separate instances; B never sees the
	// cycle and votes NO, so A (already prepared) must be aborted.
	mpA := NewMemoryParticipant()
	mpA.Seed("c1", StagePlan)
	_, srvA := newTxServerWith(t, mpA)
	mpB, srvB := newTxServer(t) // c1 not seeded: Prepare rejects unknown cycle

	rpA := NewRemoteParticipant(srvA.URL, time.Second)
	rpB := NewRemoteParticipant(srvB.URL, time.Second)

	tx := Transition{CycleID: "c1", From: StagePlan, To: StageDo}
	err := NewCoordinator().Run(tx, rpA, rpB)
	var txErr *TxError
	if !errors.As(err, &txErr) || txErr.Phase != "prepare" {
		t.Fatalf("err = %v, want prepare TxError", err)
	}
	if got := mpA.Stage("c1"); got != StagePlan {
		t.Fatalf("aborted participant stage = %v, want plan (unchanged)", got)
	}
	if got := mpB.Stage("c1"); got != StagePlan {
		t.Fatalf("rejecting participant stage = %v, want plan", got)
	}
}

func TestRemoteParticipantUnreachable(t *testing.T) {
	srv := httptest.NewServer(NewTxHandler(NewMemoryParticipant()))
	addr := srv.URL
	srv.Close() // peer is gone
	rp := NewRemoteParticipant(addr, 200*time.Millisecond)
	tx := Transition{CycleID: "c1", From: StagePlan, To: StageDo}
	if err := rp.Prepare(tx); err == nil {
		t.Fatal("Prepare must fail for an unreachable peer")
	}
	if err := rp.Commit(tx); err == nil {
		t.Fatal("Commit must fail for an unreachable peer")
	}
	if err := rp.Abort(tx); err == nil {
		t.Fatal("Abort must fail for an unreachable peer")
	}
}
