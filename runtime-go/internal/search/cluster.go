package search

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"sync"
	"time"

	"runtime-go/internal/distrib"
)

// clusterState holds the cluster-mode wiring: the node registry (membership
// and health) and the HTTP client used for peer RPC. When an Engine has a
// non-nil cluster it only builds and holds index data for the shards it
// owns; the remaining shards are served by their owning nodes.
type clusterState struct {
	reg       *distrib.Registry
	client    *http.Client
	numShards int
}

// WithCluster enables cluster mode: shard ownership is derived from reg and
// the engine holds only its own shards' data (numShards slots globally).
// A nil registry leaves the engine in single-node mode.
func WithCluster(reg *distrib.Registry, numShards int) Option {
	return func(e *Engine) {
		if reg == nil {
			return
		}
		if numShards < 1 {
			numShards = 1
		}
		e.cluster = &clusterState{
			reg:       reg,
			client:    distrib.DefaultClient(10 * time.Second),
			numShards: numShards,
		}
	}
}

// sortedNodes returns all cluster members sorted by ID. The lexicographic
// order is identical on every node, so all nodes compute the same shard
// ownership. The view is deliberately stable: it does not shrink when a
// peer is unhealthy, so a down node's shards stay owned by it and queries
// degrade to partial instead of silently re-routing ownership.
func (c *clusterState) sortedNodes() []distrib.Node {
	nodes := append([]distrib.Node{c.reg.Self()}, c.reg.Others()...)
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	return nodes
}

// shardOwner returns the node owning shard: all members sorted by ID,
// indexed by shard % len(nodes). The same view drives both query fan-out
// and write routing, so a document is always looked up where it was written.
func (c *clusterState) shardOwner(shard int) distrib.Node {
	return ownerOf(c.sortedNodes(), shard)
}

// ownerOf maps a shard onto a member of an already-sorted node view. Callers
// on hot paths (per-shard query fan-out, per-document write routing) should
// sort once via sortedNodes and reuse the slice instead of paying a sort per
// shard/document.
func ownerOf(nodes []distrib.Node, shard int) distrib.Node {
	return nodes[shard%len(nodes)]
}

// owns reports whether the local node currently owns shard.
func (c *clusterState) owns(shard int) bool {
	return c.shardOwner(shard).ID == c.reg.Self().ID
}

// ownsNode is owns() against a pre-sorted node view (see ownerOf).
func (c *clusterState) ownsNode(sorted []distrib.Node, shard int) bool {
	return ownerOf(sorted, shard).ID == c.reg.Self().ID
}

// ownedShards returns the indices of the shards the local node owns out of
// numShards, in ascending order.
func (c *clusterState) ownedShards(numShards int) []int {
	sorted := c.sortedNodes()
	out := make([]int, 0, numShards)
	for i := 0; i < numShards; i++ {
		if c.ownsNode(sorted, i) {
			out = append(out, i)
		}
	}
	return out
}

// numShards returns the global shard count of the current index.
func (e *Engine) numShards() int { return len(e.idx.Load().shards) }

// applyLocal applies upserts and deletes to the local index via the
// copy-on-write swap. It never routes remotely; updateMu serializes local
// read-modify-write swaps so a direct /internal/docs call cannot lose an
// update against a cluster-routed one.
func (e *Engine) applyLocal(upserts []Document, deletes []string) {
	e.updateMu.Lock()
	defer e.updateMu.Unlock()
	next := func() uint32 { return e.num.Add(1) - 1 }
	e.idx.Store(e.idx.Load().apply(upserts, deletes, next))
	e.swaps.Add(1)
	e.m.observeSwap()
}

// clusterUpdate routes every upsert/delete to the owner of its document's
// shard: local shards go through the local COW path, remote shards are
// grouped per node and shipped with one POST /internal/docs each. The
// caller (Update) already holds the DistLock, so the whole batch is one
// serialized "global update".
func (e *Engine) clusterUpdate(ctx context.Context, upserts []Document, deletes []string) error {
	c := e.cluster
	self := c.reg.Self().ID
	n := e.numShards()
	sorted := c.sortedNodes()

	var localUp []Document
	var localDel []string
	remoteUp := make(map[string][]Document)
	remoteDel := make(map[string][]string)
	nodes := make(map[string]distrib.Node)

	route := func(id string) (string, bool) {
		owner := ownerOf(sorted, shardOfID(id, n))
		if owner.ID == self {
			return "", true
		}
		nodes[owner.ID] = owner
		return owner.ID, false
	}
	for _, d := range upserts {
		if id, local := route(d.ID); local {
			localUp = append(localUp, d)
		} else {
			remoteUp[id] = append(remoteUp[id], d)
		}
	}
	for _, id := range deletes {
		if nid, local := route(id); local {
			localDel = append(localDel, id)
		} else {
			remoteDel[nid] = append(remoteDel[nid], id)
		}
	}

	if len(localUp)+len(localDel) > 0 {
		e.applyLocal(localUp, localDel)
	}

	peerIDs := make([]string, 0, len(nodes))
	for id := range nodes {
		peerIDs = append(peerIDs, id)
	}
	sort.Strings(peerIDs)

	var wg sync.WaitGroup
	var mu sync.Mutex
	var errs []error
	for _, id := range peerIDs {
		node := nodes[id]
		req := internalDocsRequest{Upserts: remoteUp[id], Deletes: remoteDel[id]}
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.m.incRemoteFanout(node.ID)
			pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			var out internalDocsResponse
			if err := distrib.DoJSON(pctx, c.client, http.MethodPost,
				node.Addr+"/internal/docs", req, &out); err != nil {
				e.m.incRemoteFanoutError(node.ID)
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return errors.Join(errs...)
}

// clusterSearch fans the query out to every shard: locally owned shards run
// on the worker pool, remote shards are grouped per owning node and queried
// with one POST /internal/query each (5s timeout). All partial Top-K lists
// merge into one global Top-K. partial reports degraded results: an
// unhealthy peer (its shard data is unreachable) or a failed RPC.
func (e *Engine) clusterSearch(ctx context.Context, idx *Index, node Node, query string, limit int) ([]Hit, bool, error) {
	c := e.cluster
	self := c.reg.Self().ID

	local := make([]int, 0, len(idx.shards))
	remoteShards := make(map[string][]int)
	nodes := make(map[string]distrib.Node)
	sorted := c.sortedNodes()
	for i := range idx.shards {
		owner := ownerOf(sorted, i)
		if owner.ID == self {
			local = append(local, i)
		} else {
			remoteShards[owner.ID] = append(remoteShards[owner.ID], i)
			nodes[owner.ID] = owner
		}
	}

	hits, err := e.searchShards(ctx, idx, node, local, limit)
	if err != nil {
		return nil, false, err
	}

	peerIDs := make([]string, 0, len(remoteShards))
	for id := range remoteShards {
		peerIDs = append(peerIDs, id)
	}
	sort.Strings(peerIDs)

	// Skip shards owned by unhealthy peers: their data is unreachable, so
	// the query degrades to partial instead of wasting the RPC timeout.
	partial := false
	healthy := make([]string, 0, len(peerIDs))
	for _, id := range peerIDs {
		if c.reg.IsHealthy(id) {
			healthy = append(healthy, id)
		} else {
			partial = true
		}
	}

	type peerResult struct {
		node string
		hits []Hit
		err  error
	}
	ch := make(chan peerResult, len(healthy))
	for _, id := range healthy {
		node := nodes[id]
		req := internalQueryRequest{Shards: remoteShards[id], Query: query, Limit: limit}
		go func() {
			e.m.incRemoteFanout(node.ID)
			qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			var out internalQueryResponse
			err := distrib.DoJSON(qctx, c.client, http.MethodPost,
				node.Addr+"/internal/query", req, &out)
			ch <- peerResult{node: node.ID, hits: out.Hits, err: err}
		}()
	}
	for range healthy {
		res := <-ch
		if res.err != nil {
			e.m.incRemoteFanoutError(res.node)
			partial = true
			continue
		}
		hits = append(hits, res.hits...)
	}

	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].ID < hits[j].ID
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	if partial {
		e.m.incPartialQueries()
	}
	return hits, partial, nil
}

// searchLocalShards executes query against the given local shards only. It
// backs the /internal/query endpoint and never fans out to other nodes.
func (e *Engine) searchLocalShards(ctx context.Context, query string, shards []int, limit int) ([]Hit, error) {
	if limit <= 0 {
		limit = 10
	}
	idx := e.idx.Load()
	node, err := e.compiledNode(query, idx)
	if err != nil {
		return nil, err
	}
	valid := make([]int, 0, len(shards))
	for _, sh := range shards {
		if sh >= 0 && sh < len(idx.shards) {
			valid = append(valid, sh)
		}
	}
	return e.searchShards(ctx, idx, node, valid, limit)
}
