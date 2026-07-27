// Package distrib provides shared distributed-systems primitives for the
// runtime-go modules (pcda, agent, search): node configuration, a health
// registry with heartbeat probing, a JSON RPC helper, and Prometheus metrics.
//
// The package is designed for two-node (primary/replica) deployments where
// node lists are injected via environment variables as JSON.
package distrib

import (
	"encoding/json"
	"fmt"

	"runtime-go/internal/observability"
)

// Stable machine-readable error codes produced by this package.
const (
	// ErrCodeConfig marks node configuration / parsing errors.
	ErrCodeConfig = "DISTRIB_CONFIG_ERROR"
	// ErrCodeRPC marks RPC transport and remote failure errors.
	ErrCodeRPC = "DISTRIB_RPC_ERROR"
)

// Node describes a single cluster member. Addr is a base URL such as
// "http://192.168.0.150:9103". Role is free-form text (e.g. "primary",
// "replica") and may be empty.
type Node struct {
	ID   string `json:"id"`
	Addr string `json:"addr"`
	Role string `json:"role,omitempty"`
}

// ParseNodes parses a JSON array of nodes, typically injected through an
// environment variable. It validates that every node has a non-empty ID and
// Addr, that IDs are unique, and that at least one node is present. All
// failures are returned as *observability.AppError with code
// ErrCodeConfig.
func ParseNodes(jsonStr string) ([]Node, error) {
	var nodes []Node
	if err := json.Unmarshal([]byte(jsonStr), &nodes); err != nil {
		return nil, observability.WrapError(ErrCodeConfig, "invalid nodes JSON", err)
	}
	if len(nodes) == 0 {
		return nil, observability.NewAppError(ErrCodeConfig, "nodes list is empty")
	}
	seen := make(map[string]struct{}, len(nodes))
	for i, n := range nodes {
		if n.ID == "" {
			return nil, observability.NewAppError(ErrCodeConfig, "node ID is empty").
				WithContext("index", fmt.Sprintf("%d", i))
		}
		if n.Addr == "" {
			return nil, observability.NewAppError(ErrCodeConfig, "node Addr is empty").
				WithContext("id", n.ID)
		}
		if _, dup := seen[n.ID]; dup {
			return nil, observability.NewAppError(ErrCodeConfig, "duplicate node ID").
				WithContext("id", n.ID)
		}
		seen[n.ID] = struct{}{}
	}
	return nodes, nil
}
