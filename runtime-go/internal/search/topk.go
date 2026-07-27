package search

import (
	"container/heap"
	"sort"
)

// scoredDoc is a candidate document with its score, identified by shard and
// doc number.
type scoredDoc struct {
	num   uint32
	shard int
	score float64
}

// docHeap is a min-heap of scoredDoc used to keep the current Top-K: the
// root is the weakest kept candidate. Ties evict the higher doc number
// first so results stay deterministic.
type docHeap []scoredDoc

func (h docHeap) Len() int { return len(h) }
func (h docHeap) Less(i, j int) bool {
	if h[i].score != h[j].score {
		return h[i].score < h[j].score
	}
	return h[i].num > h[j].num
}
func (h docHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *docHeap) Push(x any)   { *h = append(*h, x.(scoredDoc)) }
func (h *docHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

// pushTopK offers d to the Top-K heap h, evicting the weakest entry when the
// heap is full and d is strictly better.
func pushTopK(h *docHeap, d scoredDoc, k int) {
	if k <= 0 {
		return
	}
	if h.Len() < k {
		heap.Push(h, d)
		return
	}
	top := (*h)[0]
	if d.score > top.score || (d.score == top.score && d.num < top.num) {
		heap.Pop(h)
		heap.Push(h, d)
	}
}

// tfOf returns the term frequency of num in a posting list sorted by doc
// number, or 0 if absent.
func tfOf(p []posting, num uint32) float64 {
	i := sort.Search(len(p), func(i int) bool { return p[i].doc >= num })
	if i < len(p) && p[i].doc == num {
		return float64(p[i].tf)
	}
	return 0
}
