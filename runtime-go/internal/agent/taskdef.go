// Package agent implements the multi-agent task scheduling framework:
// versioned task definitions, cgroup-based resource isolation, EMA-based
// least-load scheduling, three-tier failure recovery, autoscaling, and
// Prometheus monitoring.
package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
)

// ResourceRequirements declares the resources a task needs to run.
type ResourceRequirements struct {
	// MemoryBytes is the memory limit for the task.
	MemoryBytes int64 `json:"memory_bytes"`
	// CPUCores is the CPU quota in cores (may be fractional).
	CPUCores float64 `json:"cpu_cores"`
	// NetworkBps is the desired network IO bandwidth in bytes/sec.
	// The field is carried through the API for scheduling decisions, but
	// bandwidth enforcement is not implemented by any ResourceLimiter yet.
	NetworkBps int64 `json:"network_bps,omitempty"`
}

// TaskDefinition describes a schedulable kind of task.
type TaskDefinition struct {
	// Name is the unique, human-readable identifier of the definition.
	Name string `json:"name"`
	// Type classifies the task (e.g. "shell", "http", "llm").
	Type string `json:"type"`
	// Params holds arbitrary task parameters.
	Params map[string]string `json:"params,omitempty"`
	// Resources declares the resource footprint of one task instance.
	Resources ResourceRequirements `json:"resources"`
	// Idempotent declares whether re-running the task is safe. Only
	// idempotent tasks are retried by the task-level recovery layer.
	Idempotent bool `json:"idempotent"`
}

// TaskDefVersion is one immutable version of a TaskDefinition.
type TaskDefVersion struct {
	// Def is the definition content at this version.
	Def TaskDefinition `json:"def"`
	// Version is the 1-based, monotonically increasing version number.
	Version int `json:"version"`
	// Hash is the SHA-256 of the canonical JSON encoding of Def.
	Hash string `json:"hash"`
	// CreatedAt records when this version was created.
	CreatedAt time.Time `json:"created_at"`
}

// Sentinel errors returned by ConfigStore implementations.
var (
	ErrTaskDefNotFound = errors.New("agent: task definition not found")
	ErrVersionNotFound = errors.New("agent: task definition version not found")
	ErrInvalidTaskDef  = errors.New("agent: invalid task definition")
)

// ConfigStore abstracts the configuration center that persists versioned
// task definitions. The REST API and the scheduler both go through this
// interface; MemoryConfigStore is the built-in implementation.
type ConfigStore interface {
	// Put creates a new definition or appends a new version to an
	// existing one, returning the stored version.
	Put(def TaskDefinition) (TaskDefVersion, error)
	// Get returns the current version of name.
	Get(name string) (TaskDefVersion, error)
	// GetVersion returns a specific historical version of name.
	GetVersion(name string, version int) (TaskDefVersion, error)
	// Versions returns the full version history of name, oldest first.
	Versions(name string) ([]TaskDefVersion, error)
	// Rollback appends a new version whose content is copied from the
	// given historical version, making it current.
	Rollback(name string, version int) (TaskDefVersion, error)
	// List returns the current version of every definition, sorted by
	// name.
	List() []TaskDefVersion
	// Delete removes a definition and its entire history.
	Delete(name string) error
}

// MemoryConfigStore is an in-memory ConfigStore keeping the full version
// history of every task definition.
type MemoryConfigStore struct {
	mu       sync.RWMutex
	versions map[string][]TaskDefVersion
	now      func() time.Time
}

// NewMemoryConfigStore creates an empty in-memory store.
func NewMemoryConfigStore() *MemoryConfigStore {
	return &MemoryConfigStore{
		versions: make(map[string][]TaskDefVersion),
		now:      time.Now,
	}
}

// Put implements ConfigStore.
func (s *MemoryConfigStore) Put(def TaskDefinition) (TaskDefVersion, error) {
	if def.Name == "" || def.Type == "" {
		return TaskDefVersion{}, ErrInvalidTaskDef
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v := TaskDefVersion{
		Def:       def,
		Version:   len(s.versions[def.Name]) + 1,
		Hash:      hashDefinition(def),
		CreatedAt: s.now(),
	}
	s.versions[def.Name] = append(s.versions[def.Name], v)
	return v, nil
}

// Get implements ConfigStore.
func (s *MemoryConfigStore) Get(name string) (TaskDefVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	hist := s.versions[name]
	if len(hist) == 0 {
		return TaskDefVersion{}, ErrTaskDefNotFound
	}
	return hist[len(hist)-1], nil
}

// GetVersion implements ConfigStore.
func (s *MemoryConfigStore) GetVersion(name string, version int) (TaskDefVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	hist := s.versions[name]
	if len(hist) == 0 {
		return TaskDefVersion{}, ErrTaskDefNotFound
	}
	if version < 1 || version > len(hist) {
		return TaskDefVersion{}, ErrVersionNotFound
	}
	return hist[version-1], nil
}

// Versions implements ConfigStore.
func (s *MemoryConfigStore) Versions(name string) ([]TaskDefVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	hist := s.versions[name]
	if len(hist) == 0 {
		return nil, ErrTaskDefNotFound
	}
	out := make([]TaskDefVersion, len(hist))
	copy(out, hist)
	return out, nil
}

// Rollback implements ConfigStore.
func (s *MemoryConfigStore) Rollback(name string, version int) (TaskDefVersion, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	hist := s.versions[name]
	if len(hist) == 0 {
		return TaskDefVersion{}, ErrTaskDefNotFound
	}
	if version < 1 || version > len(hist) {
		return TaskDefVersion{}, ErrVersionNotFound
	}
	src := hist[version-1]
	v := TaskDefVersion{
		Def:       src.Def,
		Version:   len(hist) + 1,
		Hash:      src.Hash,
		CreatedAt: s.now(),
	}
	s.versions[name] = append(hist, v)
	return v, nil
}

// List implements ConfigStore.
func (s *MemoryConfigStore) List() []TaskDefVersion {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]TaskDefVersion, 0, len(s.versions))
	for _, hist := range s.versions {
		out = append(out, hist[len(hist)-1])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Def.Name < out[j].Def.Name })
	return out
}

// Delete implements ConfigStore.
func (s *MemoryConfigStore) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.versions[name]) == 0 {
		return ErrTaskDefNotFound
	}
	delete(s.versions, name)
	return nil
}

// hashDefinition returns the SHA-256 of the canonical JSON encoding of def.
func hashDefinition(def TaskDefinition) string {
	// encoding/json sorts map keys, so the encoding is deterministic.
	data, _ := json.Marshal(def)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
