package observability

import (
	"context"
	"fmt"
	"log"
	"time"
)

// Severity classifies an alert.
type Severity int

const (
	SeverityInfo Severity = iota
	SeverityWarning
	SeverityCritical
)

func (s Severity) String() string {
	switch s {
	case SeverityInfo:
		return "INFO"
	case SeverityWarning:
		return "WARNING"
	case SeverityCritical:
		return "CRITICAL"
	default:
		return "UNKNOWN"
	}
}

// Alert is a fired alert instance.
type Alert struct {
	Rule     string
	Severity Severity
	Message  string
	Time     time.Time
}

// AlertRule declares a named condition that fires an alert when Condition
// returns true. Condition is evaluated on every AlertManager.Check.
type AlertRule struct {
	Name      string
	Severity  Severity
	Message   string
	Condition func() bool
}

// Alerter receives fired alerts. Implementations may page, log, or push to
// an alert manager.
type Alerter interface {
	Fire(alert Alert)
}

// LogAlerter is the default Alerter; it logs each alert with the standard
// library logger.
type LogAlerter struct {
	Logger *log.Logger // nil uses log.Default()
}

// Fire logs the alert.
func (a LogAlerter) Fire(alert Alert) {
	l := a.Logger
	if l == nil {
		l = log.Default()
	}
	l.Printf("[%s] %s: %s", alert.Severity, alert.Rule, alert.Message)
}

// AlertManager evaluates rules and fires alerts through an Alerter.
type AlertManager struct {
	alerter Alerter
	rules   []AlertRule
}

// NewAlertManager creates an AlertManager. A nil alerter uses LogAlerter.
func NewAlertManager(alerter Alerter, rules ...AlertRule) *AlertManager {
	if alerter == nil {
		alerter = LogAlerter{}
	}
	return &AlertManager{alerter: alerter, rules: rules}
}

// AddRule appends a rule.
func (m *AlertManager) AddRule(rule AlertRule) { m.rules = append(m.rules, rule) }

// Check evaluates every rule once and fires an alert for each whose
// Condition returns true. It returns the number of alerts fired.
func (m *AlertManager) Check() int {
	fired := 0
	for _, r := range m.rules {
		if r.Condition == nil || !r.Condition() {
			continue
		}
		m.alerter.Fire(Alert{
			Rule:     r.Name,
			Severity: r.Severity,
			Message:  r.Message,
			Time:     time.Now(),
		})
		fired++
	}
	return fired
}

// RecoveryLevel is the tiered recovery grade: L1 retry, L2 degrade,
// L3 switch over to a standby.
type RecoveryLevel int

const (
	// RecoveryRetry (L1) retries the failed operation with backoff.
	RecoveryRetry RecoveryLevel = iota + 1
	// RecoveryDegrade (L2) runs a degraded-mode handler instead.
	RecoveryDegrade
	// RecoverySwitchover (L3) switches over to a standby implementation.
	RecoverySwitchover
)

func (l RecoveryLevel) String() string {
	switch l {
	case RecoveryRetry:
		return "L1-RETRY"
	case RecoveryDegrade:
		return "L2-DEGRADE"
	case RecoverySwitchover:
		return "L3-SWITCHOVER"
	default:
		return "UNKNOWN"
	}
}

// RecoveryPolicy executes tiered recovery for a failed operation. op is the
// operation to retry at L1; level selects the recovery grade.
type RecoveryPolicy interface {
	Recover(ctx context.Context, level RecoveryLevel, op func(ctx context.Context) error) error
}

// SimpleRecovery is the default RecoveryPolicy.
//
// L1 retries op up to MaxRetries times with the given backoff; L2 invokes
// Degrade; L3 invokes Switchover. Missing handlers make the corresponding
// level return the last error unchanged.
type SimpleRecovery struct {
	MaxRetries int           // total attempts for L1 (minimum 1)
	Backoff    time.Duration // delay between L1 attempts
	Degrade    func(ctx context.Context) error
	Switchover func(ctx context.Context) error
}

// Recover executes the recovery strategy for the given level.
func (r SimpleRecovery) Recover(ctx context.Context, level RecoveryLevel, op func(ctx context.Context) error) error {
	switch level {
	case RecoveryRetry:
		attempts := r.MaxRetries
		if attempts < 1 {
			attempts = 1
		}
		var err error
		for i := 0; i < attempts; i++ {
			if i > 0 && r.Backoff > 0 {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(r.Backoff):
				}
			}
			if err = op(ctx); err == nil {
				return nil
			}
		}
		return err
	case RecoveryDegrade:
		if r.Degrade != nil {
			return r.Degrade(ctx)
		}
	case RecoverySwitchover:
		if r.Switchover != nil {
			return r.Switchover(ctx)
		}
	}
	return fmt.Errorf("no handler for recovery level %s", level)
}
