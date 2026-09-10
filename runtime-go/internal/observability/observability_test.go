package observability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestModuleMetricsObserveRequest(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewModuleMetrics(reg, "testmod")

	m.ObserveRequest(0.05, "")
	m.ObserveRequest(0.10, "MODEL_SERVER_ERROR")
	m.ObserveRequest(0.20, "MODEL_SERVER_ERROR")
	m.SampleRuntime()

	if got := testutil.ToFloat64(m.requests); got != 3 {
		t.Fatalf("requests = %v, want 3", got)
	}
	if got := testutil.ToFloat64(m.errors.WithLabelValues("MODEL_SERVER_ERROR")); got != 2 {
		t.Fatalf("errors = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.goroutines); got < 1 {
		t.Fatalf("goroutines = %v, want >= 1", got)
	}

	// Histogram must be gatherable for histogram_quantile (p50/p95/p99).
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	var found bool
	for _, f := range families {
		if f.GetName() == "testmod_request_duration_seconds" {
			found = true
			if f.GetMetric()[0].GetHistogram().GetSampleCount() != 3 {
				t.Fatalf("histogram count = %d, want 3",
					f.GetMetric()[0].GetHistogram().GetSampleCount())
			}
		}
	}
	if !found {
		t.Fatal("testmod_request_duration_seconds not found")
	}
}

func TestModuleMetricsDuplicateRegistrationTolerated(t *testing.T) {
	reg := prometheus.NewRegistry()
	m1 := NewModuleMetrics(reg, "dupmod")
	m2 := NewModuleMetrics(reg, "dupmod") // must not panic

	m1.ObserveRequest(0.01, "")
	m2.ObserveRequest(0.01, "")

	if got := testutil.ToFloat64(m1.requests); got != 2 {
		t.Fatalf("shared requests counter = %v, want 2", got)
	}
}

func TestModuleMetricsNameSanitized(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewModuleMetrics(reg, "my-module")
	m.ObserveRequest(0.01, "")
	if got := testutil.ToFloat64(m.requests); got != 1 {
		t.Fatalf("requests = %v, want 1", got)
	}
}

func TestAppErrorStackAndUnwrap(t *testing.T) {
	cause := errors.New("connection refused")
	err := WrapError("MODEL_NETWORK_ERROR", "call model", cause).
		WithContext("endpoint", "http://x")

	if !errors.Is(err, cause) {
		t.Fatal("errors.Is should match cause via Unwrap")
	}
	if !strings.Contains(err.Stack, "TestAppErrorStackAndUnwrap") {
		t.Fatalf("stack should contain caller, got:\n%s", err.Stack)
	}
	if !strings.Contains(err.Error(), "MODEL_NETWORK_ERROR") ||
		!strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("unexpected Error(): %s", err.Error())
	}
	if !strings.Contains(err.LogString(), "endpoint=http://x") {
		t.Fatalf("LogString missing context: %s", err.LogString())
	}
}

func TestAppErrorToJSON(t *testing.T) {
	err := NewAppError("ALL_ENDPOINTS_UNHEALTHY", "no healthy endpoint").
		WithContext("endpoints", "2")

	data, jsonErr := err.ToJSON()
	if jsonErr != nil {
		t.Fatalf("ToJSON: %v", jsonErr)
	}
	var decoded map[string]any
	if jsonErr := json.Unmarshal(data, &decoded); jsonErr != nil {
		t.Fatalf("invalid JSON: %v", jsonErr)
	}
	if decoded["code"] != "ALL_ENDPOINTS_UNHEALTHY" {
		t.Fatalf("code = %v", decoded["code"])
	}
	if decoded["stack"] == "" {
		t.Fatal("stack should be present in JSON")
	}
	if decoded["context"].(map[string]any)["endpoints"] != "2" {
		t.Fatalf("context = %v", decoded["context"])
	}
}

func TestWrapErrorNil(t *testing.T) {
	if err := WrapError("X", "y", nil); err != nil {
		t.Fatalf("WrapError(nil cause) = %v, want nil", err)
	}
}

type recordingAlerter struct{ alerts []Alert }

func (r *recordingAlerter) Fire(a Alert) { r.alerts = append(r.alerts, a) }

func TestAlertManagerCheck(t *testing.T) {
	rec := &recordingAlerter{}
	mgr := NewAlertManager(rec,
		AlertRule{Name: "always", Severity: SeverityWarning, Message: "fires",
			Condition: func() bool { return true }},
		AlertRule{Name: "never", Severity: SeverityCritical, Message: "silent",
			Condition: func() bool { return false }},
	)

	if fired := mgr.Check(); fired != 1 {
		t.Fatalf("fired = %d, want 1", fired)
	}
	if len(rec.alerts) != 1 || rec.alerts[0].Rule != "always" {
		t.Fatalf("alerts = %+v", rec.alerts)
	}
	if rec.alerts[0].Severity != SeverityWarning {
		t.Fatalf("severity = %v", rec.alerts[0].Severity)
	}
}

func TestSimpleRecoveryL1Retry(t *testing.T) {
	calls := 0
	op := func(ctx context.Context) error {
		calls++
		if calls < 3 {
			return errors.New("temporary")
		}
		return nil
	}
	policy := SimpleRecovery{MaxRetries: 3, Backoff: time.Millisecond}
	if err := policy.Recover(context.Background(), RecoveryRetry, op); err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestSimpleRecoveryL1Exhausted(t *testing.T) {
	op := func(ctx context.Context) error { return errors.New("permanent") }
	policy := SimpleRecovery{MaxRetries: 2, Backoff: time.Millisecond}
	if err := policy.Recover(context.Background(), RecoveryRetry, op); err == nil {
		t.Fatal("expected error after retries exhausted")
	}
}

func TestSimpleRecoveryL2L3(t *testing.T) {
	degraded, switched := false, false
	policy := SimpleRecovery{
		Degrade:    func(ctx context.Context) error { degraded = true; return nil },
		Switchover: func(ctx context.Context) error { switched = true; return nil },
	}
	noop := func(ctx context.Context) error { return nil }
	if err := policy.Recover(context.Background(), RecoveryDegrade, noop); err != nil || !degraded {
		t.Fatalf("L2: err=%v degraded=%v", err, degraded)
	}
	if err := policy.Recover(context.Background(), RecoverySwitchover, noop); err != nil || !switched {
		t.Fatalf("L3: err=%v switched=%v", err, switched)
	}
	if err := (SimpleRecovery{}).Recover(context.Background(), RecoveryDegrade, noop); err == nil {
		t.Fatal("expected error when no handler configured")
	}
}
