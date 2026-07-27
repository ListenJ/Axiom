package agent

import (
	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// Metrics bundles the Prometheus collectors of the agent module. All
// methods are safe to call on a nil *Metrics, so tests and small
// integrations can opt out of instrumentation.
type Metrics struct {
	// Module is the standard module metric set from observability.
	Module *observability.ModuleMetrics

	// QueueLength is the number of tasks waiting for capacity.
	QueueLength prometheus.Gauge
	// AgentTasks is the number of running tasks per agent.
	AgentTasks *prometheus.GaugeVec
	// AgentUtilization is the accounted CPU utilization per agent (0..1).
	AgentUtilization *prometheus.GaugeVec
	// Retries counts task-level retry attempts.
	Retries prometheus.Counter
	// AgentRestarts counts agent-level restarts after failed health checks.
	AgentRestarts prometheus.Counter
	// Failovers counts node-level failovers.
	Failovers prometheus.Counter
	// ScaleEvents counts autoscaler decisions, labeled by direction.
	ScaleEvents *prometheus.CounterVec
}

// NewMetrics creates and registers the agent module metrics on reg. A nil
// reg uses prometheus.DefaultRegisterer; duplicate registration reuses the
// existing collectors via observability.SafeRegister.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	if reg == nil {
		reg = prometheus.DefaultRegisterer
	}
	m := &Metrics{Module: observability.NewModuleMetrics(reg, "agentd")}
	m.QueueLength = observability.SafeRegister(reg, prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "agentd_queue_length",
		Help: "Number of tasks waiting in the scheduler queue.",
	})).(prometheus.Gauge)
	m.AgentTasks = observability.SafeRegister(reg, prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "agentd_agent_tasks",
		Help: "Number of running tasks per agent.",
	}, []string{"agent"})).(*prometheus.GaugeVec)
	m.AgentUtilization = observability.SafeRegister(reg, prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "agentd_agent_utilization",
		Help: "Accounted CPU utilization per agent (0..1).",
	}, []string{"agent"})).(*prometheus.GaugeVec)
	m.Retries = observability.SafeRegister(reg, prometheus.NewCounter(prometheus.CounterOpts{
		Name: "agentd_retries_total",
		Help: "Total task-level retry attempts.",
	})).(prometheus.Counter)
	m.AgentRestarts = observability.SafeRegister(reg, prometheus.NewCounter(prometheus.CounterOpts{
		Name: "agentd_agent_restarts_total",
		Help: "Total agent restarts after failed health checks.",
	})).(prometheus.Counter)
	m.Failovers = observability.SafeRegister(reg, prometheus.NewCounter(prometheus.CounterOpts{
		Name: "agentd_failovers_total",
		Help: "Total node-level failovers.",
	})).(prometheus.Counter)
	m.ScaleEvents = observability.SafeRegister(reg, prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "agentd_scale_events_total",
		Help: "Total autoscaler decisions, labeled by direction (up/down).",
	}, []string{"direction"})).(*prometheus.CounterVec)
	return m
}

func (m *Metrics) setQueueLength(n int) {
	if m != nil {
		m.QueueLength.Set(float64(n))
	}
}

func (m *Metrics) observeAgent(id string, tasks int, utilization float64) {
	if m != nil {
		m.AgentTasks.WithLabelValues(id).Set(float64(tasks))
		m.AgentUtilization.WithLabelValues(id).Set(utilization)
	}
}

func (m *Metrics) incRetry() {
	if m != nil {
		m.Retries.Inc()
	}
}

func (m *Metrics) incRestart() {
	if m != nil {
		m.AgentRestarts.Inc()
	}
}

func (m *Metrics) incFailover() {
	if m != nil {
		m.Failovers.Inc()
	}
}

func (m *Metrics) incScale(direction string) {
	if m != nil {
		m.ScaleEvents.WithLabelValues(direction).Inc()
	}
}
