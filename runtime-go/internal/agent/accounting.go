package agent

import "sync"

// AccountingLimiter is a pure-accounting ResourceLimiter: it performs no OS
// level isolation, only records quotas and accounted usage, and rejects
// acquisitions that would exceed the quota. It is the default on non-Linux
// platforms (see NewPlatformLimiter) and is used on every platform for
// tests and for capacity checks that do not need kernel enforcement.
type AccountingLimiter struct {
	mu     sync.Mutex
	quotas map[string]ResourceQuota
	usage  map[string]ResourceUsage
}

// NewAccountingLimiter creates an empty accounting limiter.
func NewAccountingLimiter() *AccountingLimiter {
	return &AccountingLimiter{
		quotas: make(map[string]ResourceQuota),
		usage:  make(map[string]ResourceUsage),
	}
}

// Apply records the quota for id. NetworkBps is accepted but not enforced
// (see ResourceQuota documentation).
func (l *AccountingLimiter) Apply(id string, q ResourceQuota) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.quotas[id] = q
	return nil
}

// Remove drops the quota and usage records for id. It is idempotent.
func (l *AccountingLimiter) Remove(id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.quotas, id)
	delete(l.usage, id)
	return nil
}

// Acquire accounts usage against id's quota, rejecting acquisitions that
// would exceed it with ErrOverQuota.
func (l *AccountingLimiter) Acquire(id string, u ResourceUsage) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	q, ok := l.quotas[id]
	if !ok {
		return ErrUnknownLimit
	}
	cur := l.usage[id]
	if (q.MemoryBytes > 0 && cur.MemoryBytes+u.MemoryBytes > q.MemoryBytes) ||
		(q.CPUCores > 0 && cur.CPUCores+u.CPUCores > q.CPUCores) {
		return ErrOverQuota
	}
	cur.MemoryBytes += u.MemoryBytes
	cur.CPUCores += u.CPUCores
	l.usage[id] = cur
	return nil
}

// Release frees previously acquired usage, clamping at zero.
func (l *AccountingLimiter) Release(id string, u ResourceUsage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cur := l.usage[id]
	cur.MemoryBytes -= u.MemoryBytes
	if cur.MemoryBytes < 0 {
		cur.MemoryBytes = 0
	}
	cur.CPUCores -= u.CPUCores
	if cur.CPUCores < 0 {
		cur.CPUCores = 0
	}
	l.usage[id] = cur
}

// Usage returns the current accounted usage of id.
func (l *AccountingLimiter) Usage(id string) ResourceUsage {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.usage[id]
}
