package modelclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

func okResponse(w http.ResponseWriter, content string) {
	resp := ChatResponse{
		ID:     "chatcmpl-test",
		Object: "chat.completion",
		Model:  "test-model",
		Choices: []Choice{{
			Index:        0,
			Message:      Message{Role: "assistant", Content: content},
			FinishReason: "stop",
		}},
		Usage: Usage{PromptTokens: 3, CompletionTokens: 5, TotalTokens: 8},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func newTestClient(t *testing.T, cfg Config) *Client {
	t.Helper()
	c := NewClient(cfg, prometheus.NewRegistry())
	t.Cleanup(c.Close)
	return c
}

func sampleRequest() ChatRequest {
	return ChatRequest{
		Model: "test-model",
		Messages: []Message{
			{Role: "user", Content: "hello"},
		},
	}
}

func TestChatSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		var req ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if req.Model != "test-model" {
			t.Errorf("model = %s", req.Model)
		}
		okResponse(w, "hi there")
	}))
	defer srv.Close()

	c := newTestClient(t, Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour})
	resp, err := c.Chat(context.Background(), sampleRequest())
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if resp.Content() != "hi there" {
		t.Fatalf("content = %q", resp.Content())
	}
	if resp.Usage.TotalTokens != 8 {
		t.Fatalf("usage = %+v", resp.Usage)
	}
}

func TestRetryOn5xx(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		okResponse(w, "recovered")
	}))
	defer srv.Close()

	c := newTestClient(t, Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour})
	resp, err := c.Chat(context.Background(), sampleRequest())
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if resp.Content() != "recovered" {
		t.Fatalf("content = %q", resp.Content())
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("calls = %d, want 3", got)
	}
}

func TestNoRetryOn4xx(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad request"}`))
	}))
	defer srv.Close()

	c := newTestClient(t, Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour})
	_, err := c.Chat(context.Background(), sampleRequest())
	if err == nil {
		t.Fatal("expected error")
	}
	var appErr *observability.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected *AppError, got %T", err)
	}
	if appErr.Code != ErrCodeClientError {
		t.Fatalf("code = %s, want %s", appErr.Code, ErrCodeClientError)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls = %d, want 1 (no retry on 4xx)", got)
	}
}

func TestRetryExhausted(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newTestClient(t, Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour, MaxRetries: 2})
	_, err := c.Chat(context.Background(), sampleRequest())
	if err == nil {
		t.Fatal("expected error")
	}
	if got := calls.Load(); got != 3 { // 1 initial + 2 retries
		t.Fatalf("calls = %d, want 3", got)
	}
}

func TestRoundRobin(t *testing.T) {
	var hits1, hits2 atomic.Int32
	srv1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits1.Add(1)
		okResponse(w, "one")
	}))
	defer srv1.Close()
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits2.Add(1)
		okResponse(w, "two")
	}))
	defer srv2.Close()

	c := newTestClient(t, Config{Endpoints: []string{srv1.URL, srv2.URL}, HealthInterval: time.Hour})
	for i := 0; i < 4; i++ {
		if _, err := c.Chat(context.Background(), sampleRequest()); err != nil {
			t.Fatalf("Chat %d: %v", i, err)
		}
	}
	if hits1.Load() != 2 || hits2.Load() != 2 {
		t.Fatalf("hits = %d/%d, want 2/2", hits1.Load(), hits2.Load())
	}
}

func TestHealthCheckFailover(t *testing.T) {
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		okResponse(w, "good")
	}))
	defer good.Close()

	var badHealthHits atomic.Int32
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			badHealthHits.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		t.Error("unhealthy endpoint must not receive chat traffic")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()

	c := newTestClient(t, Config{Endpoints: []string{bad.URL, good.URL}, HealthInterval: time.Hour})
	c.probeAll() // trigger a probe round synchronously

	if healthy := c.HealthyEndpoints(); len(healthy) != 1 || healthy[0] != good.URL {
		t.Fatalf("healthy = %v, want [%s]", healthy, good.URL)
	}
	for i := 0; i < 3; i++ {
		resp, err := c.Chat(context.Background(), sampleRequest())
		if err != nil {
			t.Fatalf("Chat %d: %v", i, err)
		}
		if resp.Content() != "good" {
			t.Fatalf("content = %q", resp.Content())
		}
	}
	if badHealthHits.Load() == 0 {
		t.Fatal("bad endpoint was never probed")
	}

	// Gauge reflects health.
	g, err := c.metric.endpointHealth.GetMetricWithLabelValues(bad.URL)
	if err != nil {
		t.Fatalf("gauge: %v", err)
	}
	_ = g
}

func TestAllUnhealthyWithFallback(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer down.Close()

	c := newTestClient(t, Config{Endpoints: []string{down.URL}, HealthInterval: time.Hour})
	c.probeAll() // marks endpoint unhealthy

	fallbackCalled := false
	c.SetFallback(func(ctx context.Context, req ChatRequest) (ChatResponse, error) {
		fallbackCalled = true
		return ChatResponse{Choices: []Choice{{Message: Message{Role: "assistant", Content: "degraded"}}}}, nil
	})

	resp, err := c.Chat(context.Background(), sampleRequest())
	if err != nil {
		t.Fatalf("Chat with fallback: %v", err)
	}
	if !fallbackCalled {
		t.Fatal("fallback not invoked")
	}
	if resp.Content() != "degraded" {
		t.Fatalf("content = %q", resp.Content())
	}
}

func TestAllUnhealthyWithoutFallback(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer down.Close()

	c := newTestClient(t, Config{Endpoints: []string{down.URL}, HealthInterval: time.Hour})
	c.probeAll()

	_, err := c.Chat(context.Background(), sampleRequest())
	if err == nil {
		t.Fatal("expected error")
	}
	var appErr *observability.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected *AppError, got %T", err)
	}
	if appErr.Code != ErrCodeAllUnhealthy {
		t.Fatalf("code = %s, want %s", appErr.Code, ErrCodeAllUnhealthy)
	}
}

func TestHealthCheckRecovery(t *testing.T) {
	// A "down" endpoint (connection refused) becomes healthy after probe.
	var healthy atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" && !healthy.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		okResponse(w, "back")
	}))
	defer srv.Close()

	c := newTestClient(t, Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour})
	c.probeAll()
	if got := c.HealthyEndpoints(); len(got) != 0 {
		t.Fatalf("healthy = %v, want none", got)
	}

	healthy.Store(true)
	c.probeAll() // half-open trial closes the circuit
	if got := c.HealthyEndpoints(); len(got) != 1 {
		t.Fatalf("healthy after recovery = %v", got)
	}
}

func TestTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		time.Sleep(300 * time.Millisecond)
		okResponse(w, "too late")
	}))
	defer srv.Close()

	c := newTestClient(t, Config{
		Endpoints:      []string{srv.URL},
		Timeout:        50 * time.Millisecond,
		MaxRetries:     1,
		HealthInterval: time.Hour,
	})
	start := time.Now()
	_, err := c.Chat(context.Background(), sampleRequest())
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("took too long: %v", elapsed)
	}
	var appErr *observability.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected *AppError, got %T", err)
	}
}

func TestEndpointsFromEnv(t *testing.T) {
	t.Setenv("MODEL_SERVICE_URL", "http://a:9001, http://b:9001/")
	cfg := Config{}.withDefaults()
	if len(cfg.Endpoints) != 2 || cfg.Endpoints[0] != "http://a:9001" || cfg.Endpoints[1] != "http://b:9001" {
		t.Fatalf("endpoints = %v", cfg.Endpoints)
	}
}

func TestDefaultEndpoint(t *testing.T) {
	t.Setenv("MODEL_SERVICE_URL", "")
	cfg := Config{}.withDefaults()
	if len(cfg.Endpoints) != 1 || cfg.Endpoints[0] != DefaultEndpoint {
		t.Fatalf("endpoints = %v", cfg.Endpoints)
	}
	if !strings.HasPrefix(cfg.Endpoints[0], "http://192.168.0.150") {
		t.Fatalf("default = %s", cfg.Endpoints[0])
	}
}

func TestMetricsRecorded(t *testing.T) {
	reg := prometheus.NewRegistry()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		okResponse(w, "ok")
	}))
	defer srv.Close()

	c := NewClient(Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour}, reg)
	defer c.Close()
	if _, err := c.Chat(context.Background(), sampleRequest()); err != nil {
		t.Fatalf("Chat: %v", err)
	}

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	want := map[string]bool{
		"modelclient_request_duration_seconds": false,
		"modelclient_requests_total":           false,
		"modelclient_inflight_requests":        false,
		"modelclient_endpoint_healthy":         false,
	}
	for _, f := range families {
		if _, ok := want[f.GetName()]; ok {
			want[f.GetName()] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("metric %s not exported", name)
		}
	}
}
