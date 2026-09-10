package search

import (
	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// Metrics is the search module's metric set: the standard module metrics
// (request QPS/latency/errors via observability.ModuleMetrics) plus
// search-specific collectors. Queries report through ObserveRequest, so
// searchd_requests_total is the QPS source and
// searchd_request_duration_seconds the latency histogram.
type Metrics struct {
	*observability.ModuleMetrics

	buildSeconds    prometheus.Histogram
	cowSwaps        prometheus.Counter
	lockWaitSeconds prometheus.Histogram
	lockErrors      prometheus.Counter
	activeQueries   prometheus.Gauge

	partialQueries     prometheus.Counter
	remoteFanout       *prometheus.CounterVec
	remoteFanoutErrors *prometheus.CounterVec
}

// newMetrics registers all collectors on reg, tolerating duplicate
// registration via observability.SafeRegister.
func newMetrics(reg prometheus.Registerer, module string) *Metrics {
	m := &Metrics{ModuleMetrics: observability.NewModuleMetrics(reg, module)}
	prefix := module + "_"
	m.buildSeconds = observability.SafeRegister(reg, prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    prefix + "index_build_duration_seconds",
		Help:    "Time to build the full inverted index.",
		Buckets: prometheus.ExponentialBuckets(0.01, 4, 8),
	})).(prometheus.Histogram)
	m.cowSwaps = observability.SafeRegister(reg, prometheus.NewCounter(prometheus.CounterOpts{
		Name: prefix + "cow_swaps_total",
		Help: "Number of copy-on-write index snapshot swaps.",
	})).(prometheus.Counter)
	m.lockWaitSeconds = observability.SafeRegister(reg, prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    prefix + "lock_acquire_seconds",
		Help:    "Time spent waiting to acquire the index-update lock (contention source).",
		Buckets: prometheus.ExponentialBuckets(0.0001, 4, 10),
	})).(prometheus.Histogram)
	m.lockErrors = observability.SafeRegister(reg, prometheus.NewCounter(prometheus.CounterOpts{
		Name: prefix + "lock_errors_total",
		Help: "Number of failed lock acquisitions (timeouts and backend errors).",
	})).(prometheus.Counter)
	m.activeQueries = observability.SafeRegister(reg, prometheus.NewGauge(prometheus.GaugeOpts{
		Name: prefix + "active_queries",
		Help: "Number of queries currently executing.",
	})).(prometheus.Gauge)
	m.partialQueries = observability.SafeRegister(reg, prometheus.NewCounter(prometheus.CounterOpts{
		Name: prefix + "partial_queries_total",
		Help: "Number of cluster queries answered with degraded (partial) results.",
	})).(prometheus.Counter)
	m.remoteFanout = observability.SafeRegister(reg, prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: prefix + "remote_fanout_total",
		Help: "Number of RPC fan-outs to peer nodes, labeled by node ID.",
	}, []string{"node"})).(*prometheus.CounterVec)
	m.remoteFanoutErrors = observability.SafeRegister(reg, prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: prefix + "remote_fanout_errors_total",
		Help: "Number of failed RPC fan-outs to peer nodes, labeled by node ID.",
	}, []string{"node"})).(*prometheus.CounterVec)
	return m
}

func (m *Metrics) observeBuild(seconds float64)    { m.buildSeconds.Observe(seconds) }
func (m *Metrics) observeSwap()                    { m.cowSwaps.Inc() }
func (m *Metrics) observeLockWait(seconds float64) { m.lockWaitSeconds.Observe(seconds) }
func (m *Metrics) observeLockError()               { m.lockErrors.Inc() }
func (m *Metrics) activeInc()                      { m.activeQueries.Inc() }
func (m *Metrics) activeDec()                      { m.activeQueries.Dec() }
func (m *Metrics) incPartialQueries()              { m.partialQueries.Inc() }
func (m *Metrics) incRemoteFanout(node string)     { m.remoteFanout.WithLabelValues(node).Inc() }
func (m *Metrics) incRemoteFanoutError(node string) {
	m.remoteFanoutErrors.WithLabelValues(node).Inc()
}
