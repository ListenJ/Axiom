package distrib

import (
	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// Metrics holds the Prometheus collectors for the distrib primitives.
// Metric names are stable API consumed by dashboards and alerts:
//
//	distrib_node_healthy{node}          gauge   — 1 when the node is healthy
//	distrib_heartbeats_total{node,outcome} counter — outcome is "ok" or "fail"
//	distrib_rpc_duration_seconds{node,method} histogram — outbound RPC latency
//	distrib_rpc_errors_total{node}      counter — failed outbound RPCs
type Metrics struct {
	nodeHealthy *prometheus.GaugeVec
	heartbeats  *prometheus.CounterVec
	rpcDuration *prometheus.HistogramVec
	rpcErrors   *prometheus.CounterVec
}

// NewMetrics registers the distrib collectors on reg via
// observability.SafeRegister, so duplicate registration reuses the existing
// collectors and never panics. A nil reg uses prometheus.DefaultRegisterer.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	return &Metrics{
		nodeHealthy: observability.SafeRegister(reg, prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "distrib_node_healthy",
			Help: "Whether a cluster node is currently healthy (1) or not (0).",
		}, []string{"node"})).(*prometheus.GaugeVec),
		heartbeats: observability.SafeRegister(reg, prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "distrib_heartbeats_total",
			Help: "Total heartbeat probes, labeled by outcome (ok/fail).",
		}, []string{"node", "outcome"})).(*prometheus.CounterVec),
		rpcDuration: observability.SafeRegister(reg, prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "distrib_rpc_duration_seconds",
			Help:    "Outbound RPC latency distribution per peer node and HTTP method.",
			Buckets: prometheus.DefBuckets,
		}, []string{"node", "method"})).(*prometheus.HistogramVec),
		rpcErrors: observability.SafeRegister(reg, prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "distrib_rpc_errors_total",
			Help: "Total failed outbound RPCs per peer node.",
		}, []string{"node"})).(*prometheus.CounterVec),
	}
}

// SetNodeHealthy records the current health of a node as 1 or 0.
func (m *Metrics) SetNodeHealthy(node string, healthy bool) {
	v := 0.0
	if healthy {
		v = 1
	}
	m.nodeHealthy.WithLabelValues(node).Set(v)
}

// IncHeartbeat records one heartbeat probe outcome ("ok" or "fail").
func (m *Metrics) IncHeartbeat(node, outcome string) {
	m.heartbeats.WithLabelValues(node, outcome).Inc()
}

// ObserveRPCDuration records the latency of one outbound RPC in seconds.
func (m *Metrics) ObserveRPCDuration(node, method string, seconds float64) {
	m.rpcDuration.WithLabelValues(node, method).Observe(seconds)
}

// IncRPCError records one failed outbound RPC against a node.
func (m *Metrics) IncRPCError(node string) {
	m.rpcErrors.WithLabelValues(node).Inc()
}
