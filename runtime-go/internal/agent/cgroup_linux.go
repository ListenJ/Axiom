//go:build linux

package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// cgroupPeriodUsec is the cgroup v2 cpu.max period used when translating a
// CPU quota in cores to quota/period microseconds.
const cgroupPeriodUsec = 100000

// CgroupLimiter is the Linux ResourceLimiter backed by cgroup v2. For each
// id it creates a cgroup under Root and writes memory.max and cpu.max; it
// additionally keeps the same usage accounting as the stub so scheduler
// capacity checks behave identically on all platforms.
type CgroupLimiter struct {
	// Root is the parent cgroup directory under /sys/fs/cgroup (or a test
	// directory). It must exist and be writable.
	Root string

	mu     sync.Mutex
	quotas map[string]ResourceQuota
	usage  map[string]ResourceUsage
}

// NewCgroupLimiter creates a limiter writing cgroups under root.
func NewCgroupLimiter(root string) *CgroupLimiter {
	return &CgroupLimiter{
		Root:   root,
		quotas: make(map[string]ResourceQuota),
		usage:  make(map[string]ResourceUsage),
	}
}

// Apply creates the cgroup for id and writes its limits. NetworkBps is
// accepted but not enforced (see ResourceQuota documentation).
func (l *CgroupLimiter) Apply(id string, q ResourceQuota) error {
	dir := filepath.Join(l.Root, sanitizeCgroupName(id))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("agent: create cgroup: %w", err)
	}
	if q.MemoryBytes > 0 {
		if err := os.WriteFile(filepath.Join(dir, "memory.max"),
			[]byte(strconv.FormatInt(q.MemoryBytes, 10)), 0o644); err != nil {
			return fmt.Errorf("agent: write memory.max: %w", err)
		}
	}
	if q.CPUCores > 0 {
		quota := int64(q.CPUCores * cgroupPeriodUsec)
		val := strconv.FormatInt(quota, 10) + " " + strconv.Itoa(cgroupPeriodUsec)
		if err := os.WriteFile(filepath.Join(dir, "cpu.max"), []byte(val), 0o644); err != nil {
			return fmt.Errorf("agent: write cpu.max: %w", err)
		}
	}
	l.mu.Lock()
	l.quotas[id] = q
	l.mu.Unlock()
	return nil
}

// Remove deletes the cgroup directory and the accounting records for id.
func (l *CgroupLimiter) Remove(id string) error {
	l.mu.Lock()
	delete(l.quotas, id)
	delete(l.usage, id)
	l.mu.Unlock()
	dir := filepath.Join(l.Root, sanitizeCgroupName(id))
	if err := os.Remove(dir); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("agent: remove cgroup: %w", err)
	}
	return nil
}

// Acquire accounts usage against id's quota, rejecting acquisitions that
// would exceed it with ErrOverQuota.
func (l *CgroupLimiter) Acquire(id string, u ResourceUsage) error {
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
func (l *CgroupLimiter) Release(id string, u ResourceUsage) {
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
func (l *CgroupLimiter) Usage(id string) ResourceUsage {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.usage[id]
}

// NewPlatformLimiter returns the platform's default ResourceLimiter. On
// Linux that is a cgroup v2 limiter writing under
// /sys/fs/cgroup/agentd (requires write permission on the cgroup tree;
// inject an AccountingLimiter via ClusterConfig.Limiter to opt out).
func NewPlatformLimiter() ResourceLimiter {
	return NewCgroupLimiter("/sys/fs/cgroup/agentd")
}

// sanitizeCgroupName strips characters that are unsafe in a cgroup path.
func sanitizeCgroupName(id string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			return r
		default:
			return '_'
		}
	}, id)
}
