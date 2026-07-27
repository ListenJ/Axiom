package distrib

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Registry holds the cluster node list and a per-node atomic health flag.
// All methods are safe for concurrent use.
type Registry struct {
	nodes []Node
	self  string
	// health maps node ID to its atomic health flag; every node starts healthy.
	health map[string]*atomic.Bool

	metrics *Metrics

	client *http.Client

	mu      sync.Mutex
	cancel  context.CancelFunc
	running bool
	wg      sync.WaitGroup
}

// NewRegistry builds a Registry from the given nodes. selfID identifies the
// local node; if it does not match any node ID, Self returns the zero Node
// and Others returns all nodes.
func NewRegistry(nodes []Node, selfID string) *Registry {
	r := &Registry{
		nodes:  append([]Node(nil), nodes...),
		self:   selfID,
		health: make(map[string]*atomic.Bool, len(nodes)),
		client: &http.Client{},
	}
	for _, n := range nodes {
		flag := &atomic.Bool{}
		flag.Store(true)
		r.health[n.ID] = flag
	}
	return r
}

// WithMetrics wires a Metrics sink into the registry: health gauge flips and
// heartbeat outcomes are recorded from then on. It returns the registry for
// chaining.
func (r *Registry) WithMetrics(m *Metrics) *Registry {
	r.metrics = m
	for _, n := range r.nodes {
		m.SetNodeHealthy(n.ID, true)
	}
	return r
}

// Self returns the local node, or the zero Node if selfID matches nothing.
func (r *Registry) Self() Node {
	for _, n := range r.nodes {
		if n.ID == r.self {
			return n
		}
	}
	return Node{}
}

// Others returns every node except the local one, in list order.
func (r *Registry) Others() []Node {
	out := make([]Node, 0, len(r.nodes))
	for _, n := range r.nodes {
		if n.ID != r.self {
			out = append(out, n)
		}
	}
	return out
}

// Healthy returns the nodes currently marked healthy, in list order.
func (r *Registry) Healthy() []Node {
	out := make([]Node, 0, len(r.nodes))
	for _, n := range r.nodes {
		if r.IsHealthy(n.ID) {
			out = append(out, n)
		}
	}
	return out
}

// IsHealthy reports whether the node with the given ID is currently healthy.
// Unknown IDs report false.
func (r *Registry) IsHealthy(id string) bool {
	flag, ok := r.health[id]
	return ok && flag.Load()
}

// MarkHealthy marks the node healthy. Unknown IDs are ignored.
func (r *Registry) MarkHealthy(id string) {
	r.setHealthy(id, true)
}

// MarkUnhealthy marks the node unhealthy. Unknown IDs are ignored.
func (r *Registry) MarkUnhealthy(id string) {
	r.setHealthy(id, false)
}

// setHealthy flips the flag only on actual transitions, so callers can
// invoke it repeatedly without triggering duplicate logs or metric updates.
func (r *Registry) setHealthy(id string, healthy bool) {
	flag, ok := r.health[id]
	if !ok {
		return
	}
	if flag.Swap(healthy) == healthy {
		return // no transition
	}
	if r.metrics != nil {
		r.metrics.SetNodeHealthy(id, healthy)
	}
}

// StartHeartbeat launches a background loop that probes every non-self node
// at {Addr}/healthz every interval. A probe uses its own timeout. A 2xx
// response marks the node healthy, anything else unhealthy; the flag is only
// updated on transitions, so a flapping node produces one log/metric update
// per flip, and a recovered node is automatically marked healthy again.
//
// The loop stops when ctx is cancelled or Stop is called. Calling
// StartHeartbeat while a loop is already running is a no-op.
func (r *Registry) StartHeartbeat(ctx context.Context, interval, timeout time.Duration) {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return
	}
	r.running = true
	hctx, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.mu.Unlock()

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			r.probeAll(hctx, timeout)
			select {
			case <-hctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

// Stop terminates a running heartbeat loop and waits for it to finish. It is
// safe to call when no loop is running.
func (r *Registry) Stop() {
	r.mu.Lock()
	if !r.running {
		r.mu.Unlock()
		return
	}
	r.cancel()
	r.running = false
	r.mu.Unlock()
	r.wg.Wait()
}

// probeAll probes every non-self node once, concurrently.
func (r *Registry) probeAll(ctx context.Context, timeout time.Duration) {
	var wg sync.WaitGroup
	for _, n := range r.Others() {
		wg.Add(1)
		go func(node Node) {
			defer wg.Done()
			r.probe(ctx, node, timeout)
		}(n)
	}
	wg.Wait()
}

// probe performs a single health check against one node and applies the
// result to its health flag.
func (r *Registry) probe(ctx context.Context, node Node, timeout time.Duration) {
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	url := node.Addr + "/healthz"
	req, err := http.NewRequestWithContext(pctx, http.MethodGet, url, nil)
	if err != nil {
		r.applyProbe(node, false, err)
		return
	}
	resp, err := r.client.Do(req)
	if err != nil {
		// A probe aborted by shutdown must not flip the health flag.
		if ctx.Err() != nil {
			return
		}
		r.applyProbe(node, false, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	ok := resp.StatusCode >= 200 && resp.StatusCode < 300
	if !ok {
		r.applyProbe(node, false, fmt.Errorf("healthz returned %s", resp.Status))
		return
	}
	r.applyProbe(node, true, nil)
}

// applyProbe records the probe outcome in metrics and flips the health flag,
// logging only on transitions.
func (r *Registry) applyProbe(node Node, ok bool, cause error) {
	if r.metrics != nil {
		outcome := "ok"
		if !ok {
			outcome = "fail"
		}
		r.metrics.IncHeartbeat(node.ID, outcome)
	}
	was := r.IsHealthy(node.ID)
	r.setHealthy(node.ID, ok)
	if was != ok {
		if ok {
			log.Printf("distrib: node %s recovered (%s)", node.ID, node.Addr)
		} else {
			log.Printf("distrib: node %s unhealthy (%s): %v", node.ID, node.Addr, cause)
		}
	}
}
