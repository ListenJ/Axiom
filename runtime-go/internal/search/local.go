package search

// numShards returns the current shard count of the local index snapshot.
func (e *Engine) numShards() int { return len(e.idx.Load().shards) }

// applyLocal applies upserts and deletes to the local index via the
// copy-on-write swap. updateMu serializes local read-modify-write swaps.
// (The cluster-routed update path was removed on 2026-10-03; this is the
// single-machine update core.)
func (e *Engine) applyLocal(upserts []Document, deletes []string) {
	e.updateMu.Lock()
	defer e.updateMu.Unlock()
	next := func() uint32 { return e.num.Add(1) - 1 }
	e.idx.Store(e.idx.Load().apply(upserts, deletes, next))
	e.swaps.Add(1)
	e.m.observeSwap()
}
