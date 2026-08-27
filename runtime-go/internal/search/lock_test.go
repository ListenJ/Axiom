package search

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"runtime-go/internal/observability"
)

// TestMemLockMutualExclusion proves a second acquirer blocks until the first
// holder unlocks.
func TestMemLockMutualExclusion(t *testing.T) {
	l := NewMemLock()
	ctx := context.Background()

	unlock, err := l.Lock(ctx, "k", time.Minute)
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}

	var acquired atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		u2, err := l.Lock(ctx, "k", time.Minute)
		if err != nil {
			t.Errorf("second lock: %v", err)
			return
		}
		acquired.Store(true)
		_ = u2(ctx)
	}()

	select {
	case <-done:
		t.Fatal("second lock acquired while first holder still holds it")
	case <-time.After(50 * time.Millisecond):
	}
	if acquired.Load() {
		t.Fatal("second lock reported acquired before unlock")
	}

	if err := unlock(ctx); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("second lock did not acquire after unlock")
	}
}

// TestMemLockTimeout proves acquisition failure surfaces as LOCK_TIMEOUT.
func TestMemLockTimeout(t *testing.T) {
	l := NewMemLock()
	ctx := context.Background()
	if _, err := l.Lock(ctx, "k", time.Minute); err != nil {
		t.Fatalf("first lock: %v", err)
	}

	tctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	_, err := l.Lock(tctx, "k", time.Minute)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	var ae *observability.AppError
	if !errors.As(err, &ae) || ae.Code != ErrCodeLockTimeout {
		t.Fatalf("error = %v, want AppError %s", err, ErrCodeLockTimeout)
	}
}

// TestMemLockTTLExpiry proves an abandoned lock is reclaimed after its TTL.
func TestMemLockTTLExpiry(t *testing.T) {
	l := NewMemLock()
	ctx := context.Background()
	if _, err := l.Lock(ctx, "k", 40*time.Millisecond); err != nil {
		t.Fatalf("first lock: %v", err)
	}
	// Never unlock; the TTL must free the key.
	tctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	unlock, err := l.Lock(tctx, "k", time.Minute)
	if err != nil {
		t.Fatalf("lock after TTL expiry: %v", err)
	}
	_ = unlock(ctx)
}

// TestMemLockUnlockIdempotent proves UnlockFunc can be called twice safely.
func TestMemLockUnlockIdempotent(t *testing.T) {
	l := NewMemLock()
	ctx := context.Background()
	unlock, err := l.Lock(ctx, "k", time.Minute)
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := unlock(ctx); err != nil {
		t.Fatalf("first unlock: %v", err)
	}
	if err := unlock(ctx); err != nil {
		t.Fatalf("second unlock: %v", err)
	}
}

// TestMemLockDifferentKeysIndependent proves locks on different keys do not
// block each other.
func TestMemLockDifferentKeysIndependent(t *testing.T) {
	l := NewMemLock()
	ctx := context.Background()
	if _, err := l.Lock(ctx, "a", time.Minute); err != nil {
		t.Fatalf("lock a: %v", err)
	}
	tctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	unlock, err := l.Lock(tctx, "b", time.Minute)
	if err != nil {
		t.Fatalf("lock b while holding a: %v", err)
	}
	_ = unlock(ctx)
}

// Compile-time guarantee that both implementations satisfy DistLock.
var (
	_ DistLock = (*MemLock)(nil)
	_ DistLock = (*RedisLock)(nil)
)
