package agent

import (
	"context"
	"net/http"
	"sync"
	"time"

	"runtime-go/internal/distrib"
)

// DefaultRemoteTimeout is the default per-call timeout for RemoteAgent RPCs.
const DefaultRemoteTimeout = 30 * time.Second

// RemoteAgent is an AgentProcess proxying an agentd instance on another
// node: Run is forwarded to POST {addr}/internal/run, Ping probes
// GET {addr}/healthz, and Stop is a no-op because the remote process
// lifecycle belongs to the peer node.
type RemoteAgent struct {
	id     string
	client *http.Client

	mu   sync.RWMutex
	node distrib.Node
}

// NewRemoteAgent creates a remote agent proxy with the given ID targeting
// node. A timeout <= 0 uses DefaultRemoteTimeout.
func NewRemoteAgent(id string, node distrib.Node, timeout time.Duration) *RemoteAgent {
	if timeout <= 0 {
		timeout = DefaultRemoteTimeout
	}
	return &RemoteAgent{id: id, node: node, client: distrib.DefaultClient(timeout)}
}

// RemoteAgentFactory returns an AgentFactory that builds RemoteAgent
// processes against node. Use it for clusters whose agents live on a peer.
func RemoteAgentFactory(node distrib.Node, timeout time.Duration) AgentFactory {
	return func(id string) AgentProcess { return NewRemoteAgent(id, node, timeout) }
}

// ID implements AgentProcess.
func (r *RemoteAgent) ID() string { return r.id }

// addr returns the current peer base URL.
func (r *RemoteAgent) addr() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.node.Addr
}

// Node returns the node the proxy currently targets.
func (r *RemoteAgent) Node() distrib.Node {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.node
}

// Retarget points the proxy at another node. The Cluster uses it during a
// node failover so an agent that lived on a lost primary keeps its ID (and
// its scheduling state) while its work moves to the standby node.
func (r *RemoteAgent) Retarget(node distrib.Node) {
	r.mu.Lock()
	r.node = node
	r.mu.Unlock()
}

// Ping implements AgentProcess by probing the peer's /healthz endpoint.
func (r *RemoteAgent) Ping(ctx context.Context) error {
	return distrib.DoJSON(ctx, r.client, http.MethodGet, r.addr()+"/healthz", nil, nil)
}

// Run implements AgentProcess by posting the task to the peer's
// /internal/run endpoint and decoding the returned TaskResult.
func (r *RemoteAgent) Run(ctx context.Context, t Task) (TaskResult, error) {
	var res TaskResult
	if err := distrib.DoJSON(ctx, r.client, http.MethodPost, r.addr()+"/internal/run", t, &res); err != nil {
		return TaskResult{}, err
	}
	return res, nil
}

// Stop implements AgentProcess as a no-op: the remote process lifecycle is
// managed by the peer node, not by this cluster.
func (r *RemoteAgent) Stop(context.Context) error { return nil }
