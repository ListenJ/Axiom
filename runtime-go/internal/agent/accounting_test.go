package agent

import (
	"errors"
	"testing"
)

func TestStubLimiterAccounting(t *testing.T) {
	l := NewAccountingLimiter()
	q := ResourceQuota{MemoryBytes: 100, CPUCores: 1.0, NetworkBps: 1024}
	if err := l.Apply("a1", q); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Within quota is accepted.
	if err := l.Acquire("a1", ResourceUsage{MemoryBytes: 60, CPUCores: 0.5}); err != nil {
		t.Fatalf("Acquire within quota: %v", err)
	}
	u := l.Usage("a1")
	if u.MemoryBytes != 60 || u.CPUCores != 0.5 {
		t.Fatalf("Usage = %+v", u)
	}

	// Exceeding the memory quota is rejected.
	err := l.Acquire("a1", ResourceUsage{MemoryBytes: 50, CPUCores: 0})
	if !errors.Is(err, ErrOverQuota) {
		t.Fatalf("Acquire over memory err = %v", err)
	}
	// Exceeding the CPU quota is rejected.
	err = l.Acquire("a1", ResourceUsage{MemoryBytes: 0, CPUCores: 0.6})
	if !errors.Is(err, ErrOverQuota) {
		t.Fatalf("Acquire over cpu err = %v", err)
	}
	// Rejected acquisitions leave usage unchanged.
	if got := l.Usage("a1"); got.MemoryBytes != 60 || got.CPUCores != 0.5 {
		t.Fatalf("Usage after reject = %+v", got)
	}

	// Release frees capacity.
	l.Release("a1", ResourceUsage{MemoryBytes: 60, CPUCores: 0.5})
	if got := l.Usage("a1"); got.MemoryBytes != 0 || got.CPUCores != 0 {
		t.Fatalf("Usage after release = %+v", got)
	}
	if err := l.Acquire("a1", ResourceUsage{MemoryBytes: 100, CPUCores: 1.0}); err != nil {
		t.Fatalf("Acquire after release: %v", err)
	}
}

func TestStubLimiterUnknownID(t *testing.T) {
	l := NewAccountingLimiter()
	if err := l.Acquire("ghost", ResourceUsage{MemoryBytes: 1}); !errors.Is(err, ErrUnknownLimit) {
		t.Fatalf("Acquire unknown err = %v", err)
	}
	if err := l.Remove("a1"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
}

func TestStubLimiterRemove(t *testing.T) {
	l := NewAccountingLimiter()
	l.Apply("a1", ResourceQuota{MemoryBytes: 100, CPUCores: 1})
	l.Acquire("a1", ResourceUsage{MemoryBytes: 10, CPUCores: 0.1})
	if err := l.Remove("a1"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if err := l.Acquire("a1", ResourceUsage{MemoryBytes: 1}); !errors.Is(err, ErrUnknownLimit) {
		t.Fatalf("Acquire after remove err = %v", err)
	}
}
