package agent

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRetrySucceedsAfterFailures(t *testing.T) {
	var calls int
	var delays []time.Duration
	p := RetryPolicy{
		InitialInterval: 100 * time.Millisecond,
		Multiplier:      2,
		MaxInterval:     30 * time.Second,
		MaxAttempts:     4,
		Sleep: func(_ context.Context, d time.Duration) error {
			delays = append(delays, d)
			return nil
		},
	}
	err := Retry(context.Background(), p, true, func(context.Context) error {
		calls++
		if calls < 3 {
			return errors.New("boom")
		}
		return nil
	}, nil)
	if err != nil {
		t.Fatalf("Retry: %v", err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond}
	if len(delays) != len(want) {
		t.Fatalf("delays = %v", delays)
	}
	for i := range want {
		if delays[i] != want[i] {
			t.Fatalf("delay[%d] = %v, want %v", i, delays[i], want[i])
		}
	}
}

func TestRetryExhaustsAttempts(t *testing.T) {
	var calls, retries int
	p := RetryPolicy{
		InitialInterval: time.Millisecond,
		Multiplier:      2,
		MaxInterval:     30 * time.Second,
		MaxAttempts:     3,
		Sleep:           func(context.Context, time.Duration) error { return nil },
	}
	err := Retry(context.Background(), p, true, func(context.Context) error {
		calls++
		return errors.New("always fails")
	}, func(attempt int) { retries++ })
	if err == nil {
		t.Fatal("expected error")
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
	if retries != 2 {
		t.Fatalf("onRetry calls = %d, want 2", retries)
	}
}

func TestRetryBackoffCapped(t *testing.T) {
	var delays []time.Duration
	p := RetryPolicy{
		InitialInterval: 10 * time.Second,
		Multiplier:      2,
		MaxInterval:     30 * time.Second,
		MaxAttempts:     4,
		Sleep: func(_ context.Context, d time.Duration) error {
			delays = append(delays, d)
			return nil
		},
	}
	Retry(context.Background(), p, true, func(context.Context) error {
		return errors.New("x")
	}, nil)
	want := []time.Duration{10 * time.Second, 20 * time.Second, 30 * time.Second}
	if len(delays) != len(want) {
		t.Fatalf("delays = %v", delays)
	}
	for i := range want {
		if delays[i] != want[i] {
			t.Fatalf("delay[%d] = %v, want %v (capped)", i, delays[i], want[i])
		}
	}
}

func TestRetryNonIdempotentRunsOnce(t *testing.T) {
	var calls int
	p := RetryPolicy{MaxAttempts: 5, Sleep: func(context.Context, time.Duration) error { return nil }}
	err := Retry(context.Background(), p, false, func(context.Context) error {
		calls++
		return errors.New("boom")
	}, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if calls != 1 {
		t.Fatalf("non-idempotent task ran %d times, want 1", calls)
	}
}

func TestRetryContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	p := RetryPolicy{
		InitialInterval: time.Hour,
		MaxAttempts:     5,
		Sleep: func(ctx context.Context, d time.Duration) error {
			cancel()
			return ctx.Err()
		},
	}
	err := Retry(ctx, p, true, func(context.Context) error { return errors.New("x") }, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestRetryDefaults(t *testing.T) {
	p := DefaultRetryPolicy()
	if p.InitialInterval != 100*time.Millisecond ||
		p.Multiplier != 2 ||
		p.MaxInterval != 30*time.Second {
		t.Fatalf("defaults = %+v", p)
	}
}
