package agent

import "errors"

// ResourceQuota declares the limits applied to one entity (agent or task).
type ResourceQuota struct {
	// MemoryBytes is the memory ceiling in bytes (cgroup memory.max).
	MemoryBytes int64 `json:"memory_bytes"`
	// CPUCores is the CPU quota in cores (translated to cgroup cpu.max).
	CPUCores float64 `json:"cpu_cores"`
	// NetworkBps is the network IO bandwidth limit in bytes/sec.
	//
	// The parameter is part of the interface contract and is propagated
	// to implementations, but bandwidth enforcement is intentionally NOT
	// implemented: cgroup v2 has no unified network IO knob (it requires
	// eBPF or tc integration), so implementations must document the field
	// as accepted-but-unenforced until such integration lands.
	NetworkBps int64 `json:"network_bps,omitempty"`
}

// ResourceUsage is an accounted resource consumption amount.
type ResourceUsage struct {
	MemoryBytes int64   `json:"memory_bytes"`
	CPUCores    float64 `json:"cpu_cores"`
}

// Errors returned by ResourceLimiter implementations.
var (
	// ErrOverQuota is returned when an acquisition would exceed the quota.
	ErrOverQuota = errors.New("agent: resource quota exceeded")
	// ErrUnknownLimit is returned when no quota was applied for the ID.
	ErrUnknownLimit = errors.New("agent: no resource limit for id")
)

// ResourceLimiter isolates and accounts the resources of agents and tasks.
//
// On Linux the cgroup v2 implementation (cgroup_linux.go) enforces memory
// and CPU limits through /sys/fs/cgroup; on other platforms the stub
// implementation (cgroup_stub.go) degrades to pure accounting: it records
// quotas and usage and rejects acquisitions that would exceed the quota.
type ResourceLimiter interface {
	// Apply sets the resource quota for id, creating the underlying
	// isolation unit (cgroup) if the implementation has one.
	Apply(id string, q ResourceQuota) error
	// Remove tears down the quota and isolation unit for id.
	Remove(id string) error
	// Acquire accounts usage against id's quota. It returns ErrOverQuota
	// if the acquisition would exceed the quota, leaving usage unchanged.
	Acquire(id string, u ResourceUsage) error
	// Release frees previously acquired usage for id.
	Release(id string, u ResourceUsage)
	// Usage returns the current accounted usage of id.
	Usage(id string) ResourceUsage
}
