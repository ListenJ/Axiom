package search

// scoredDoc is a candidate document with its score, identified by shard and
// doc number.
type scoredDoc struct {
	num   uint32
	shard int
	score float64
}

// scoreBoard accumulates per-document scores by iterating posting lists
// directly, replacing per-candidate lookups. Generation stamps make reuse
// allocation-free: a slot holds a valid score only when its stamp equals the
// current generation, so no clearing is needed between queries. touched
// lists the doc numbers scored in the current generation, so Top-K only
// visits docs some posting list actually hit. A board is owned by one
// goroutine at a time (see scratch).
type scoreBoard struct {
	scores  []float64
	stamp   []uint32
	touched []uint32
	gen     uint32
}

// reset starts a new scoring generation for doc numbers [0, n).
func (b *scoreBoard) reset(n int) {
	if len(b.stamp) < n {
		b.scores = make([]float64, n)
		b.stamp = make([]uint32, n)
		b.gen = 0
	}
	b.gen++
	if b.gen == 0 { // wrapped: stale stamps may alias generation 0
		clear(b.stamp)
		b.gen = 1
	}
	b.touched = b.touched[:0]
}

// add adds tf to the score of doc.
func (b *scoreBoard) add(doc uint32, tf float64) {
	if b.stamp[doc] != b.gen {
		b.stamp[doc] = b.gen
		b.scores[doc] = tf
		b.touched = append(b.touched, doc)
		return
	}
	b.scores[doc] += tf
}

// get returns the accumulated score of doc, or 0 if untouched this
// generation.
func (b *scoreBoard) get(doc uint32) float64 {
	if b.stamp[doc] == b.gen {
		return b.scores[doc]
	}
	return 0
}

// lessScored orders the Top-K min-heap: the root is the weakest kept
// candidate. Ties evict the higher doc number first so results stay
// deterministic.
func lessScored(h []scoredDoc, i, j int) bool {
	if h[i].score != h[j].score {
		return h[i].score < h[j].score
	}
	return h[i].num > h[j].num
}

func siftUp(h []scoredDoc, i int) {
	for i > 0 {
		parent := (i - 1) / 2
		if !lessScored(h, i, parent) {
			break
		}
		h[i], h[parent] = h[parent], h[i]
		i = parent
	}
}

func siftDown(h []scoredDoc, i int) {
	for {
		l, r := 2*i+1, 2*i+2
		m := i
		if l < len(h) && lessScored(h, l, m) {
			m = l
		}
		if r < len(h) && lessScored(h, r, m) {
			m = r
		}
		if m == i {
			break
		}
		h[i], h[m] = h[m], h[i]
		i = m
	}
}

// offerTopK offers d to the Top-K heap h, evicting the weakest entry when the
// heap is full and d is strictly better. Unlike container/heap it works on a
// plain []scoredDoc, so nothing is boxed into an interface.
func offerTopK(h *[]scoredDoc, d scoredDoc, k int) {
	if k <= 0 {
		return
	}
	if len(*h) < k {
		*h = append(*h, d)
		siftUp(*h, len(*h)-1)
		return
	}
	top := (*h)[0]
	if d.score > top.score || (d.score == top.score && d.num < top.num) {
		(*h)[0] = d
		siftDown(*h, 0)
	}
}
