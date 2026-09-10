package distrib

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// flakyHealthz serves 200 until flipped to 500 and back, simulating a node
// that goes down and recovers.
func flakyHealthz(t *testing.T, status *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(int(status.Load()))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func TestHeartbeat_FlipsAndRecovers(t *testing.T) {
	status := &atomic.Int32{}
	status.Store(http.StatusOK)
	srv := flakyHealthz(t, status)

	r := NewRegistry([]Node{
		{ID: "self", Addr: "http://127.0.0.1:1"},
		{ID: "peer", Addr: srv.URL},
	}, "self")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.StartHeartbeat(ctx, 10*time.Millisecond, time.Second)
	defer r.Stop()

	// Initially healthy after first probe round.
	waitFor(t, "peer probed healthy", func() bool { return r.IsHealthy("peer") })

	// Node goes down: flag flips to unhealthy.
	status.Store(http.StatusInternalServerError)
	waitFor(t, "peer marked unhealthy", func() bool { return !r.IsHealthy("peer") })

	// Node recovers: flag flips back automatically.
	status.Store(http.StatusOK)
	waitFor(t, "peer marked healthy again", func() bool { return r.IsHealthy("peer") })
}

func TestHeartbeat_StopTerminatesLoop(t *testing.T) {
	status := &atomic.Int32{}
	status.Store(http.StatusOK)
	srv := flakyHealthz(t, status)

	r := NewRegistry([]Node{
		{ID: "self", Addr: "http://127.0.0.1:1"},
		{ID: "peer", Addr: srv.URL},
	}, "self")

	r.StartHeartbeat(context.Background(), 10*time.Millisecond, time.Second)
	waitFor(t, "peer probed healthy", func() bool { return r.IsHealthy("peer") })
	r.Stop()

	// After Stop, state no longer tracks the peer.
	status.Store(http.StatusInternalServerError)
	time.Sleep(100 * time.Millisecond)
	if !r.IsHealthy("peer") {
		t.Fatal("health flag changed after Stop; loop still running")
	}

	// Stop is idempotent.
	r.Stop()
}

func TestHeartbeat_UnreachablePeer(t *testing.T) {
	r := NewRegistry([]Node{
		{ID: "self", Addr: "http://127.0.0.1:1"},
		{ID: "peer", Addr: "http://127.0.0.1:1"}, // nothing listens here
	}, "self")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.StartHeartbeat(ctx, 10*time.Millisecond, 50*time.Millisecond)
	defer r.Stop()

	waitFor(t, "unreachable peer marked unhealthy", func() bool { return !r.IsHealthy("peer") })
}
