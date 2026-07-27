package pcda

import (
	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// metrics holds the pcda-specific Prometheus collectors. All collectors are
// registered through observability.SafeRegister, so constructing several
// engines against the same registry never panics.
type metrics struct {
	module *observability.ModuleMetrics

	stageProcessed *prometheus.CounterVec
	stageLatency   *prometheus.HistogramVec
	queueDepth     *prometheus.GaugeVec
	workerCount    *prometheus.GaugeVec
	batchSize      *prometheus.GaugeVec

	twoPCCommits prometheus.Counter
	twoPCAborts  prometheus.Counter

	cyclesCompleted prometheus.Counter
	cyclesFailed    prometheus.Counter
	recoveries      prometheus.Counter
}

// newMetrics registers the module metric set on reg (nil uses the default
// registerer).
func newMetrics(reg prometheus.Registerer) *metrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	cv := func(name, help string, labels ...string) *prometheus.CounterVec {
		return observability.SafeRegister(reg, prometheus.NewCounterVec(
			prometheus.CounterOpts{Name: name, Help: help}, labels)).(*prometheus.CounterVec)
	}
	hv := func(name, help string, labels ...string) *prometheus.HistogramVec {
		return observability.SafeRegister(reg, prometheus.NewHistogramVec(
			prometheus.HistogramOpts{Name: name, Help: help, Buckets: prometheus.DefBuckets}, labels)).(*prometheus.HistogramVec)
	}
	gv := func(name, help string, labels ...string) *prometheus.GaugeVec {
		return observability.SafeRegister(reg, prometheus.NewGaugeVec(
			prometheus.GaugeOpts{Name: name, Help: help}, labels)).(*prometheus.GaugeVec)
	}
	cnt := func(name, help string) prometheus.Counter {
		return observability.SafeRegister(reg, prometheus.NewCounter(
			prometheus.CounterOpts{Name: name, Help: help})).(prometheus.Counter)
	}

	return &metrics{
		module:          observability.NewModuleMetrics(reg, "pcda"),
		stageProcessed:  cv("pcda_stage_processed_total", "Cycles processed per stage.", "stage"),
		stageLatency:    hv("pcda_stage_latency_seconds", "Stage batch latency in seconds.", "stage"),
		queueDepth:      gv("pcda_queue_depth", "Current queue depth per stage.", "stage"),
		workerCount:     gv("pcda_workers", "Current worker count per stage.", "stage"),
		batchSize:       gv("pcda_batch_size", "Current batch size per stage.", "stage"),
		twoPCCommits:    cnt("pcda_2pc_commits_total", "2PC stage transitions committed."),
		twoPCAborts:     cnt("pcda_2pc_aborts_total", "2PC stage transitions aborted."),
		cyclesCompleted: cnt("pcda_cycles_completed_total", "Cycles that completed all four stages."),
		cyclesFailed:    cnt("pcda_cycles_failed_total", "Cycles aborted after retries and degrade."),
		recoveries:      cnt("pcda_recoveries_total", "Engine state recoveries from snapshot+WAL."),
	}
}

// observeStage records one processed batch at a stage.
func (m *metrics) observeStage(stage Stage, batchLen int, latencySec float64) {
	name := stage.String()
	m.stageProcessed.WithLabelValues(name).Add(float64(batchLen))
	m.stageLatency.WithLabelValues(name).Observe(latencySec)
}
