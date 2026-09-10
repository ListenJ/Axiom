// Package search implements a concurrently searchable, sharded inverted
// index with copy-on-write updates, a cost-based query optimizer, a
// distributed-lock abstraction, and Prometheus observability.
//
// The index is split into N shards keyed by a hash of the document ID and is
// built in parallel by a worker pool. Reads are completely lock-free: the
// Engine holds the current *Index in an atomic.Pointer and updates build a
// copy of the affected shards before swapping it in, so a new or modified
// document is visible to queries as soon as Update returns. Deletes use
// tombstones.
//
// Queries are parsed into a condition tree (AND / OR / NOT, field-scoped and
// prefix-fuzzy terms), reordered by a cost model based on document
// frequency, then fanned out to all shards in parallel. Each shard returns
// its local Top-K and the per-shard heaps are merged into a global Top-K.
package search
