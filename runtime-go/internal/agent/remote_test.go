package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"runtime-go/internal/distrib"
)

// remoteStub serves /healthz and /internal/run like an agentd peer.
type remoteStub struct {
	t        *testing.T
	runs     atomic.Int64
	failRuns atomic.Int64 // number of /internal/run calls to fail with 500
	block    chan struct{}
}

func newRemoteStubServer(t *testing.T, stub *remoteStub) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("POST /internal/run", func(w http.ResponseWriter, r *http.Request) {
		if stub.block != nil {
			<-stub.block
		}
		stub.runs.Add(1)
		if stub.failRuns.Load() > 0 {
			stub.failRuns.Add(-1)
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		var task Task
		if err := json.NewDecoder(r.Body).Decode(&task); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(TaskResult{
			TaskID:          task.ID,
			DurationSeconds: 1.5,
			PeakMemoryBytes: float64(task.Resources.MemoryBytes),
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestRemoteAgentRunAndPing(t *testing.T) {
	stub := &remoteStub{t: t}
	srv := newRemoteStubServer(t, stub)
	a := NewRemoteAgent("ra-1", distrib.Node{ID: "node-b", Addr: srv.URL}, 0)

	if err := a.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	res, err := a.Run(context.Background(), Task{ID: "t1", Resources: ResourceRequirements{MemoryBytes: 4096}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.TaskID != "t1" || res.DurationSeconds != 1.5 || res.PeakMemoryBytes != 4096 {
		t.Fatalf("result = %+v", res)
	}
	if err := a.Stop(context.Background()); err != nil {
		t.Fatalf("Stop must be a no-op: %v", err)
	}
}

func TestRemoteAgentServerErrorAndRetry(t *testing.T) {
	stub := &remoteStub{t: t}
	stub.failRuns.Store(1) // first call 500s, second succeeds
	srv := newRemoteStubServer(t, stub)
	a := NewRemoteAgent("ra-1", distrib.Node{ID: "node-b", Addr: srv.URL}, time.Second)

	if _, err := a.Run(context.Background(), Task{ID: "t1"}); err == nil {
		t.Fatal("Run must report the peer's 500")
	}
	// A retry (e.g. by the cluster's retry layer) reaches the recovered peer.
	res, err := a.Run(context.Background(), Task{ID: "t1"})
	if err != nil || res.TaskID != "t1" {
		t.Fatalf("retry: res=%+v err=%v", res, err)
	}
	if stub.runs.Load() != 2 {
		t.Fatalf("peer runs = %d, want 2", stub.runs.Load())
	}
}

func TestRemoteAgentTimeout(t *testing.T) {
	stub := &remoteStub{t: t, block: make(chan struct{})}
	srv := newRemoteStubServer(t, stub)
	defer close(stub.block)
	a := NewRemoteAgent("ra-1", distrib.Node{ID: "node-b", Addr: srv.URL}, 50*time.Millisecond)

	if _, err := a.Run(context.Background(), Task{ID: "t1"}); err == nil {
		t.Fatal("Run must fail on timeout")
	} else {
		var appErr interface{ Timeout() bool }
		_ = appErr // error shape is distrib's; just ensure it is an error
	}
	if err := a.Ping(context.Background()); err != nil {
		t.Fatalf("Ping on healthy peer: %v", err)
	}
}

func TestRemoteAgentUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.URL
	srv.Close() // nothing listening anymore
	a := NewRemoteAgent("ra-1", distrib.Node{ID: "node-b", Addr: addr}, time.Second)
	if err := a.Ping(context.Background()); err == nil {
		t.Fatal("Ping must fail for an unreachable peer")
	}
	if _, err := a.Run(context.Background(), Task{ID: "t1"}); err == nil || errors.Is(err, ErrAgentUnhealthy) {
		t.Fatalf("Run err = %v", err)
	}
}
