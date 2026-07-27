package modelclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// Default configuration values.
const (
	DefaultEndpoint       = "http://192.168.0.150:9001"
	DefaultTimeout        = 30 * time.Second
	DefaultHealthInterval = 10 * time.Second
	DefaultMaxRetries     = 3

	// Retry backoff: initial 100ms, factor 2, capped at 2s.
	retryInitialBackoff = 100 * time.Millisecond
	retryMaxBackoff     = 2 * time.Second
	retryFactor         = 2.0
)

// Stable error codes produced by this package (usable as AppError codes and
// Prometheus error-code labels).
const (
	ErrCodeNetwork          = "MODEL_NETWORK_ERROR"
	ErrCodeServerError      = "MODEL_SERVER_ERROR"
	ErrCodeClientError      = "MODEL_CLIENT_ERROR"
	ErrCodeAllUnhealthy     = "MODEL_ALL_ENDPOINTS_UNHEALTHY"
	ErrCodeInvalidResponse  = "MODEL_INVALID_RESPONSE"
	ErrCodeNoFallbackResult = "MODEL_FALLBACK_ERROR"
)

// Config configures a Client.
type Config struct {
	// Endpoints are base URLs of OpenAI-compatible services. If empty,
	// MODEL_SERVICE_URL (comma-separated) is used, falling back to
	// DefaultEndpoint.
	Endpoints []string
	// Timeout is the per-attempt deadline. Zero uses DefaultTimeout.
	Timeout time.Duration
	// HealthInterval is the background health probe period. Zero uses
	// DefaultHealthInterval.
	HealthInterval time.Duration
	// MaxRetries is the number of retries after the first attempt, so a
	// request is attempted at most MaxRetries+1 times. Zero uses
	// DefaultMaxRetries.
	MaxRetries int
}

func (c Config) withDefaults() Config {
	if len(c.Endpoints) == 0 {
		if env := os.Getenv("MODEL_SERVICE_URL"); env != "" {
			for _, e := range strings.Split(env, ",") {
				if e = strings.TrimSpace(e); e != "" {
					c.Endpoints = append(c.Endpoints, e)
				}
			}
		}
		if len(c.Endpoints) == 0 {
			c.Endpoints = []string{DefaultEndpoint}
		}
	}
	for i, e := range c.Endpoints {
		c.Endpoints[i] = strings.TrimRight(e, "/")
	}
	if c.Timeout <= 0 {
		c.Timeout = DefaultTimeout
	}
	if c.HealthInterval <= 0 {
		c.HealthInterval = DefaultHealthInterval
	}
	if c.MaxRetries < 0 {
		c.MaxRetries = 0
	} else if c.MaxRetries == 0 {
		c.MaxRetries = DefaultMaxRetries
	}
	return c
}

// metrics holds the Prometheus collectors for the client.
type metrics struct {
	latency        *prometheus.HistogramVec
	results        *prometheus.CounterVec
	inflight       prometheus.Gauge
	endpointHealth *prometheus.GaugeVec
}

func newMetrics(reg prometheus.Registerer) *metrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	return &metrics{
		latency: observability.SafeRegister(reg, prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "modelclient_request_duration_seconds",
			Help:    "Model request latency by endpoint and outcome.",
			Buckets: prometheus.DefBuckets,
		}, []string{"endpoint", "outcome"})).(*prometheus.HistogramVec),
		results: observability.SafeRegister(reg, prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "modelclient_requests_total",
			Help: "Model requests by outcome (success/failure).",
		}, []string{"outcome"})).(*prometheus.CounterVec),
		inflight: observability.SafeRegister(reg, prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "modelclient_inflight_requests",
			Help: "Current number of in-flight model requests.",
		})).(prometheus.Gauge),
		endpointHealth: observability.SafeRegister(reg, prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "modelclient_endpoint_healthy",
			Help: "Endpoint health status (1 healthy, 0 unhealthy).",
		}, []string{"endpoint"})).(*prometheus.GaugeVec),
	}
}

// Client calls OpenAI-compatible chat completion services with load
// balancing, retries, health checking, and fallback.
type Client struct {
	cfg    Config
	http   *http.Client
	metric *metrics

	health map[string]*atomic.Bool // endpoint -> healthy
	rr     atomic.Uint64           // round-robin cursor

	fallbackMu sync.RWMutex
	fallback   FallbackFunc

	stopCh  chan struct{}
	stopped sync.WaitGroup
}

// NewClient creates a Client and starts its background health-check loop.
// Call Close to stop the loop. A nil reg uses prometheus.DefaultRegisterer.
func NewClient(cfg Config, reg prometheus.Registerer) *Client {
	cfg = cfg.withDefaults()
	c := &Client{
		cfg: cfg,
		http: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:        64,
				MaxIdleConnsPerHost: 16,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		metric: newMetrics(reg),
		health: make(map[string]*atomic.Bool, len(cfg.Endpoints)),
		stopCh: make(chan struct{}),
	}
	for _, ep := range cfg.Endpoints {
		b := &atomic.Bool{}
		b.Store(true) // assume healthy until first probe
		c.health[ep] = b
		c.metric.endpointHealth.WithLabelValues(ep).Set(1)
	}
	c.stopped.Add(1)
	go c.healthLoop()
	return c
}

// Close stops the background health-check loop.
func (c *Client) Close() {
	close(c.stopCh)
	c.stopped.Wait()
}

// SetFallback injects a degraded handler invoked when every endpoint is
// unhealthy (circuit fully open).
func (c *Client) SetFallback(fn FallbackFunc) {
	c.fallbackMu.Lock()
	defer c.fallbackMu.Unlock()
	c.fallback = fn
}

func (c *Client) getFallback() FallbackFunc {
	c.fallbackMu.RLock()
	defer c.fallbackMu.RUnlock()
	return c.fallback
}

// HealthyEndpoints returns a snapshot of currently healthy endpoints.
func (c *Client) HealthyEndpoints() []string {
	var out []string
	for _, ep := range c.cfg.Endpoints {
		if c.health[ep].Load() {
			out = append(out, ep)
		}
	}
	return out
}

// Chat performs a chat completion request with retry, load balancing, and
// failover. The returned error is an *observability.AppError on failure.
func (c *Client) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	var lastErr error
	for attempt := 0; attempt <= c.cfg.MaxRetries; attempt++ {
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt); err != nil {
				return ChatResponse{}, observability.WrapError(ErrCodeNetwork, "chat canceled during backoff", err)
			}
		}

		ep, err := c.pickEndpoint()
		if err != nil {
			// Circuit fully open: try fallback once, no point retrying.
			if fb := c.getFallback(); fb != nil {
				resp, fbErr := fb(ctx, req)
				if fbErr == nil {
					c.metric.results.WithLabelValues("success").Inc()
					return resp, nil
				}
				return ChatResponse{}, observability.WrapError(ErrCodeNoFallbackResult, "fallback handler failed", fbErr)
			}
			c.metric.results.WithLabelValues("failure").Inc()
			return ChatResponse{}, err
		}

		resp, retryable, err := c.doChat(ctx, ep, req)
		if err == nil {
			c.metric.results.WithLabelValues("success").Inc()
			return resp, nil
		}
		lastErr = err
		if !retryable {
			c.metric.results.WithLabelValues("failure").Inc()
			return ChatResponse{}, err
		}
	}
	c.metric.results.WithLabelValues("failure").Inc()
	return ChatResponse{}, observability.WrapError(ErrCodeNetwork,
		fmt.Sprintf("chat failed after %d attempts", c.cfg.MaxRetries+1), lastErr)
}

// pickEndpoint returns the next healthy endpoint in round-robin order, or an
// AppError with ErrCodeAllUnhealthy when the circuit is fully open.
func (c *Client) pickEndpoint() (string, error) {
	healthy := c.HealthyEndpoints()
	if len(healthy) == 0 {
		return "", observability.NewAppError(ErrCodeAllUnhealthy, "no healthy model endpoint").
			WithContext("endpoints", fmt.Sprint(len(c.cfg.Endpoints)))
	}
	n := c.rr.Add(1)
	return healthy[int(n-1)%len(healthy)], nil
}

// doChat performs a single HTTP attempt against one endpoint. retryable is
// true for network errors and 5xx responses, false for 4xx.
func (c *Client) doChat(ctx context.Context, endpoint string, req ChatRequest) (ChatResponse, bool, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return ChatResponse{}, false, observability.WrapError(ErrCodeClientError, "marshal request", err)
	}

	attemptCtx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(attemptCtx, http.MethodPost,
		endpoint+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return ChatResponse{}, false, observability.WrapError(ErrCodeClientError, "build request", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	c.metric.inflight.Inc()
	start := time.Now()
	httpResp, err := c.http.Do(httpReq)
	elapsed := time.Since(start).Seconds()
	c.metric.inflight.Dec()

	if err != nil {
		c.metric.latency.WithLabelValues(endpoint, "failure").Observe(elapsed)
		return ChatResponse{}, true, observability.WrapError(ErrCodeNetwork, "call model endpoint", err).
			WithContext("endpoint", endpoint)
	}
	defer httpResp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(httpResp.Body, 8<<20))
	if err != nil {
		c.metric.latency.WithLabelValues(endpoint, "failure").Observe(elapsed)
		return ChatResponse{}, true, observability.WrapError(ErrCodeNetwork, "read response body", err).
			WithContext("endpoint", endpoint)
	}

	switch {
	case httpResp.StatusCode >= 500:
		c.metric.latency.WithLabelValues(endpoint, "failure").Observe(elapsed)
		return ChatResponse{}, true, observability.NewAppError(ErrCodeServerError,
				fmt.Sprintf("endpoint returned %d", httpResp.StatusCode)).
			WithContext("endpoint", endpoint).
			WithContext("status", fmt.Sprint(httpResp.StatusCode))
	case httpResp.StatusCode >= 400:
		c.metric.latency.WithLabelValues(endpoint, "failure").Observe(elapsed)
		return ChatResponse{}, false, observability.NewAppError(ErrCodeClientError,
				fmt.Sprintf("endpoint returned %d: %s", httpResp.StatusCode, truncate(respBody, 256))).
			WithContext("endpoint", endpoint).
			WithContext("status", fmt.Sprint(httpResp.StatusCode))
	}

	var resp ChatResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		c.metric.latency.WithLabelValues(endpoint, "failure").Observe(elapsed)
		return ChatResponse{}, false, observability.WrapError(ErrCodeInvalidResponse, "decode response", err).
			WithContext("endpoint", endpoint)
	}
	c.metric.latency.WithLabelValues(endpoint, "success").Observe(elapsed)
	return resp, false, nil
}

// sleepBackoff waits for the exponential backoff of the given (1-based)
// retry attempt, honoring ctx cancellation.
func sleepBackoff(ctx context.Context, attempt int) error {
	d := retryInitialBackoff
	for i := 1; i < attempt; i++ {
		d = time.Duration(float64(d) * retryFactor)
		if d >= retryMaxBackoff {
			d = retryMaxBackoff
			break
		}
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
