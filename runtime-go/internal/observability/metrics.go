// Package observability provides shared observability infrastructure for all
// runtime-go modules: Prometheus metrics, structured errors, and alert /
// recovery primitives.
//
// The package is intentionally small: callers register a ModuleMetrics per
// module, report requests through ObserveRequest, and build domain errors
// with AppError. Alerting and recovery are expressed as tiny interfaces with
// simple default implementations.
package observability

import (
	"runtime"
	"strings"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

// ModuleMetrics is the standard metric set every runtime module exposes.
//
// All metric names are prefixed with the (sanitized) module name, e.g. a
// module "searchd" exposes searchd_requests_total, searchd_errors_total and
// so on.
type ModuleMetrics struct {
	module string

	requests    prometheus.Counter
	duration    prometheus.Histogram
	errors      *prometheus.CounterVec
	goroutines  prometheus.Gauge
	heapBytes   prometheus.Gauge
	registered  sync.Once
}

// NewModuleMetrics registers (or reuses, if already registered) the standard
// metric set for module on reg. A nil reg uses prometheus.DefaultRegisterer.
// Duplicate registration is tolerated via AlreadyRegisteredError, so calling
// this twice with the same module never panics.
func NewModuleMetrics(reg prometheus.Registerer, module string) *ModuleMetrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	m := &ModuleMetrics{module: module}
	m.registered.Do(func() { m.register(reg) })
	return m
}

func (m *ModuleMetrics) register(reg prometheus.Registerer) {
	prefix := sanitizeMetricName(m.module)

	m.requests = registerCounter(reg, prometheus.NewCounter(prometheus.CounterOpts{
		Name: prefix + "_requests_total",
		Help: "Total number of requests handled by the module (QPS source).",
	}))
	m.duration = registerHistogram(reg, prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    prefix + "_request_duration_seconds",
		Help:    "Request latency distribution; use histogram_quantile for p50/p95/p99.",
		Buckets: prometheus.DefBuckets,
	}))
	m.errors = registerCounterVec(reg, prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: prefix + "_errors_total",
		Help: "Total number of failed requests, labeled by error code.",
	}, []string{"code"}))
	m.goroutines = registerGauge(reg, prometheus.NewGauge(prometheus.GaugeOpts{
		Name: prefix + "_goroutines",
		Help: "Current number of goroutines in the process.",
	}))
	m.heapBytes = registerGauge(reg, prometheus.NewGauge(prometheus.GaugeOpts{
		Name: prefix + "_heap_bytes",
		Help: "Current heap memory allocated, in bytes.",
	}))

	m.SampleRuntime()
}

// ObserveRequest records one handled request. duration is the end-to-end
// latency; errCode is empty for success and a stable machine-readable code
// (e.g. AppError.Code) for failures.
func (m *ModuleMetrics) ObserveRequest(duration float64, errCode string) {
	m.requests.Inc()
	m.duration.Observe(duration)
	if errCode != "" {
		m.errors.WithLabelValues(errCode).Inc()
	}
}

// SampleRuntime refreshes the resource-utilization gauges (goroutine count
// and heap bytes) from runtime. Call it periodically, e.g. once per scrape
// interval or from a background ticker.
func (m *ModuleMetrics) SampleRuntime() {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	m.goroutines.Set(float64(runtime.NumGoroutine()))
	m.heapBytes.Set(float64(ms.HeapAlloc))
}

// sanitizeMetricName converts an arbitrary module name into a valid
// Prometheus metric name prefix.
func sanitizeMetricName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// register helpers tolerate duplicate registration by reusing the existing
// collector on AlreadyRegisteredError.

func registerCounter(reg prometheus.Registerer, c prometheus.Counter) prometheus.Counter {
	if err := reg.Register(c); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			return are.ExistingCollector.(prometheus.Counter)
		}
	}
	return c
}

func registerHistogram(reg prometheus.Registerer, h prometheus.Histogram) prometheus.Histogram {
	if err := reg.Register(h); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			return are.ExistingCollector.(prometheus.Histogram)
		}
	}
	return h
}

func registerCounterVec(reg prometheus.Registerer, cv *prometheus.CounterVec) *prometheus.CounterVec {
	if err := reg.Register(cv); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			return are.ExistingCollector.(*prometheus.CounterVec)
		}
	}
	return cv
}

func registerGauge(reg prometheus.Registerer, g prometheus.Gauge) prometheus.Gauge {
	if err := reg.Register(g); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			return are.ExistingCollector.(prometheus.Gauge)
		}
	}
	return g
}

func registerGaugeVec(reg prometheus.Registerer, gv *prometheus.GaugeVec) *prometheus.GaugeVec {
	if err := reg.Register(gv); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			return are.ExistingCollector.(*prometheus.GaugeVec)
		}
	}
	return gv
}

func registerHistogramVec(reg prometheus.Registerer, hv *prometheus.HistogramVec) *prometheus.HistogramVec {
	if err := reg.Register(hv); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			return are.ExistingCollector.(*prometheus.HistogramVec)
		}
	}
	return hv
}

// SafeRegister registers c on reg, tolerating duplicate registration by
// returning the previously registered collector. It lets other packages
// (e.g. modelclient) define module-specific collectors without panicking on
// re-registration. The returned collector must be type-asserted by the
// caller.
func SafeRegister(reg prometheus.Registerer, c prometheus.Collector) prometheus.Collector {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	if err := reg.Register(c); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			return are.ExistingCollector
		}
	}
	return c
}
