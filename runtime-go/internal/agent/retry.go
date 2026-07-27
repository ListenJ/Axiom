package agent

import (
	"context"
	"time"
)

// RetryPolicy configures the task-level failure recovery layer: retries
// with exponential backoff.
type RetryPolicy struct {
	// InitialInterval is the delay before the first retry.
	InitialInterval time.Duration
	// Multiplier grows the delay after each failed attempt.
	Multiplier float64
	// MaxInterval caps the backoff delay.
	MaxInterval time.Duration
	// MaxAttempts is the total number of attempts (minimum 1).
	MaxAttempts int
	// Sleep waits between attempts; nil uses a context-aware timer.
	// Tests inject a fake to avoid real delays.
	Sleep func(ctx context.Context, d time.Duration) error
}

// DefaultRetryPolicy returns the standard policy: 100ms initial interval,
// multiplier 2, 30s cap, 3 attempts.
func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		InitialInterval: 100 * time.Millisecond,
		Multiplier:      2,
		MaxInterval:     30 * time.Second,
		MaxAttempts:     3,
	}
}

// Retry runs op with exponential backoff until it succeeds or the attempts
// are exhausted. Non-idempotent operations run exactly once, since
// re-execution would be unsafe. onRetry, if set, is invoked before each
// retry with the 1-based retry number (e.g. for metrics).
func Retry(ctx context.Context, p RetryPolicy, idempotent bool, op func(ctx context.Context) error, onRetry func(attempt int)) error {
	if p.InitialInterval <= 0 {
		p.InitialInterval = 100 * time.Millisecond
	}
	if p.Multiplier <= 0 {
		p.Multiplier = 2
	}
	if p.MaxInterval <= 0 {
		p.MaxInterval = 30 * time.Second
	}
	if p.MaxAttempts < 1 {
		p.MaxAttempts = 1
	}
	if p.Sleep == nil {
		p.Sleep = sleepContext
	}
	if !idempotent {
		return op(ctx)
	}

	delay := p.InitialInterval
	var err error
	for attempt := 1; attempt <= p.MaxAttempts; attempt++ {
		if err = op(ctx); err == nil {
			return nil
		}
		if attempt == p.MaxAttempts {
			break
		}
		if onRetry != nil {
			onRetry(attempt)
		}
		if serr := p.Sleep(ctx, delay); serr != nil {
			return serr
		}
		delay = time.Duration(float64(delay) * p.Multiplier)
		if delay > p.MaxInterval {
			delay = p.MaxInterval
		}
	}
	return err
}

// sleepContext waits for d or until ctx is done.
func sleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
