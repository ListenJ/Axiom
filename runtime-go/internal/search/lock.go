package search

import (
	"context"
	"sync"
	"time"

	"runtime-go/internal/observability"
)

// Error codes carried by AppError values from lock operations.
const (
	// ErrCodeLockTimeout indicates the lock could not be acquired before
	// the caller's context expired.
	ErrCodeLockTimeout = "LOCK_TIMEOUT"
	// ErrCodeLockError indicates a backend failure (e.g. Redis down).
	ErrCodeLockError = "LOCK_ERROR"
)

// UnlockFunc releases a previously acquired lock. It is idempotent.
type UnlockFunc func(ctx context.Context) error

// DistLock is a distributed mutual-exclusion lock with TTL-based crash
// safety: if the holder dies without unlocking, the lock is released
// automatically once ttl elapses. Callers signal acquisition failure by
// cancelling ctx, which yields an AppError with code LOCK_TIMEOUT.
type DistLock interface {
	Lock(ctx context.Context, key string, ttl time.Duration) (UnlockFunc, error)
}

// MemLock is an in-process DistLock for development and unit tests.
type MemLock struct {
	mu   sync.Mutex
	held map[string]*memHold
}

type memHold struct {
	released chan struct{}
	timer    *time.Timer
}

// NewMemLock creates an empty in-process lock.
func NewMemLock() *MemLock {
	return &MemLock{held: make(map[string]*memHold)}
}

// Lock acquires key, blocking until it is free, the previous holder's TTL
// expires, or ctx is done (LOCK_TIMEOUT).
func (m *MemLock) Lock(ctx context.Context, key string, ttl time.Duration) (UnlockFunc, error) {
	if ttl <= 0 {
		ttl = time.Minute
	}
	for {
		m.mu.Lock()
		h, taken := m.held[key]
		if !taken {
			h = &memHold{released: make(chan struct{})}
			h.timer = time.AfterFunc(ttl, func() { m.forceRelease(key, h) })
			m.held[key] = h
			m.mu.Unlock()
			var once sync.Once
			return func(context.Context) error {
				once.Do(func() { m.release(key, h) })
				return nil
			}, nil
		}
		ch := h.released
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, observability.NewAppError(ErrCodeLockTimeout, "timed out acquiring lock").
				WithContext("key", key)
		case <-ch:
		}
	}
}

// release frees key if h is still the current holder.
func (m *MemLock) release(key string, h *memHold) {
	m.mu.Lock()
	if cur, ok := m.held[key]; ok && cur == h {
		delete(m.held, key)
		h.timer.Stop()
		close(h.released)
	}
	m.mu.Unlock()
}

// forceRelease implements TTL expiry; it is a no-op if the lock was already
// released normally.
func (m *MemLock) forceRelease(key string, h *memHold) {
	m.mu.Lock()
	if cur, ok := m.held[key]; ok && cur == h {
		delete(m.held, key)
		close(h.released)
	}
	m.mu.Unlock()
}
