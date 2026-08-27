package distrib

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func TestNewMetrics_RegistersOnCustomRegistry(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	if m == nil {
		t.Fatal("expected non-nil Metrics")
	}

	// Exercise every collector, then gather to prove registration worked.
	m.SetNodeHealthy("n1", true)
	m.SetNodeHealthy("n2", false)
	m.IncHeartbeat("n1", "ok")
	m.IncHeartbeat("n1", "fail")
	m.ObserveRPCDuration("n1", "GET", 0.01)
	m.IncRPCError("n1")

	fams, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	want := map[string]bool{
		"distrib_node_healthy":         false,
		"distrib_heartbeats_total":     false,
		"distrib_rpc_duration_seconds": false,
		"distrib_rpc_errors_total":     false,
	}
	for _, f := range fams {
		if _, ok := want[f.GetName()]; ok {
			want[f.GetName()] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Fatalf("metric %q not registered", name)
		}
	}
}

func TestNewMetrics_DuplicateRegistrationDoesNotPanic(t *testing.T) {
	reg := prometheus.NewRegistry()
	m1 := NewMetrics(reg)
	// Second registration on the same registry must reuse, not panic.
	m2 := NewMetrics(reg)
	if m1 == nil || m2 == nil {
		t.Fatal("expected non-nil Metrics")
	}
	m2.IncHeartbeat("n9", "ok")
}

func TestNewMetrics_NilRegisterer(t *testing.T) {
	// Nil falls back to the default registerer; must not panic.
	m := NewMetrics(nil)
	m.SetNodeHealthy("n1", true)
}
