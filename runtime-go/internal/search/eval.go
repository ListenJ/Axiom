package search

import (
	"math/bits"
	"sort"
)

// tfOf returns the term frequency of doc in a doc-ordered posting list,
// or 0 when the doc is absent.
func tfOf(p []posting, doc uint32) int32 {
	i := sort.Search(len(p), func(i int) bool { return p[i].doc >= doc })
	if i < len(p) && p[i].doc == doc {
		return p[i].tf
	}
	return 0
}

// aliveMask returns a bitmap with a bit set for every non-tombstoned
// document in the shard. It is maintained incrementally under copy-on-write
// (build sets all bits, deletes clear them), so queries pay nothing to
// obtain it. Callers must treat the returned bitmap as read-only.
func (s *shardIndex) aliveMask() *bitmap {
	return s.alive
}

// setBits marks every doc number of the posting list in b.
func setBits(b *bitmap, p []posting) {
	for _, post := range p {
		b.set(post.doc)
	}
}

// leaf is one positive (non-negated) leaf term's contribution to scoring:
// the doc-ordered posting list (bitmap evaluation and board scoring), plus
// — only for single-token exact terms — the tf-ordered copy used by the
// Top-K early-exit fast path.
type leaf struct {
	posts []posting
	byTF  []posting
}

// eval evaluates a condition-tree node against the shard and returns the
// matching document bitmap. Posting lists of positive (non-negated) leaf
// terms are appended to leaves for later scoring. AND children are expected
// to arrive pre-sorted by the optimizer (most selective first); evaluation
// short-circuits on an empty intermediate bitmap. All intermediate bitmaps
// come from ar and stay valid until the arena is reset.
func (s *shardIndex) eval(n Node, alive *bitmap, negated bool, leaves *[]leaf, ar *bitmapArena) *bitmap {
	switch t := n.(type) {
	case Term:
		b, lists := s.evalTerm(t, ar)
		if !negated {
			*leaves = append(*leaves, lists...)
		}
		return b
	case And:
		var res *bitmap
		for _, c := range t.Children {
			cb := s.eval(c, alive, negated, leaves, ar)
			if res == nil {
				res = cb
			} else {
				res.and(cb)
			}
			if res.isZero() {
				break
			}
		}
		if res == nil {
			res = ar.new(int(s.maxDoc))
		}
		return res
	case Or:
		res := ar.new(int(s.maxDoc))
		for _, c := range t.Children {
			res.or(s.eval(c, alive, negated, leaves, ar))
		}
		return res
	case Not:
		res := ar.cloneOf(alive)
		res.andNot(s.eval(t.Child, alive, true, leaves, ar))
		return res
	}
	return ar.new(int(s.maxDoc))
}

// evalTerm evaluates a single term condition: exact token match, field
// scoped match, or prefix-fuzzy expansion (capped at maxPrefixTerms).
// Multi-token values (e.g. CJK text tokenizing to several bigrams) are
// intersected, i.e. treated as a phrase-like AND.
func (s *shardIndex) evalTerm(t Term, ar *bitmapArena) (*bitmap, []leaf) {
	b := ar.new(int(s.maxDoc))
	var lists []leaf

	if t.Prefix {
		pre := t.Value
		if t.Field != "" {
			pre = fieldKey(t.Field, t.Value)
		}
		for _, p := range s.prefixPostings(pre, t.Field == "", maxPrefixTerms) {
			setBits(b, p)
			lists = append(lists, leaf{posts: p})
		}
		return b, lists
	}

	toks := t.toks
	if toks == nil {
		toks = Tokenize(t.Value) // Term built outside ParseQuery
	}
	for i, tok := range toks {
		key := tok
		if t.Field != "" {
			key = fieldKey(t.Field, tok)
		}
		p := s.terms[key]
		if i == 0 {
			setBits(b, p)
		} else {
			tb := ar.new(int(s.maxDoc))
			setBits(tb, p)
			b.and(tb)
			if b.isZero() {
				lists = append(lists, leaf{posts: p})
				return b, lists
			}
		}
		lists = append(lists, leaf{posts: p, byTF: s.termsTF[key]})
	}
	return b, lists
}

// topK scores every candidate in res (sum of term frequencies over the
// positive leaf posting lists) and keeps the k best. Three strategies,
// all exact and equivalent:
//   - single exact term: walk the tf-ordered list and stop after k accepts;
//   - very selective multi-leaf: binary-search each candidate in every list;
//   - general multi-leaf: merge-join — candidates ascend through res while a
//     monotonic pointer per list advances once per posting at most.
//   - wide expansions (prefix-fuzzy, >16 lists): one score-board sweep,
//     since candidates × leaves would be quadratic.
//
// The score board survives for wide expansions and the rare single-leaf
// fill scan, where scored docs cannot fill k (e.g. pure NOT queries, whose
// candidates all score 0).
func (s *shardIndex) topK(res *bitmap, leaves []leaf, k int, board *scoreBoard) []scoredDoc {
	if k <= 0 {
		return nil
	}
	h := make([]scoredDoc, 0, min(k, int(s.maxDoc)))
	if len(leaves) == 1 {
		l := leaves[0]
		if l.byTF != nil {
			// Single exact term: scores are the posting list's term
			// frequencies, and byTF is ordered by (tf desc, doc asc), so
			// once k candidates are accepted nothing later in the list can
			// displace them — stop early.
			for _, p := range l.byTF {
				if res.has(p.doc) {
					offerTopK(&h, scoredDoc{num: p.doc, score: float64(p.tf)}, k)
					if len(h) >= k {
						return h
					}
				}
			}
		} else {
			// Single leaf without a tf-ordered list (prefix expansion):
			// scores are the posting list's term frequencies, so no
			// accumulation board is needed.
			for _, p := range l.posts {
				if res.has(p.doc) {
					offerTopK(&h, scoredDoc{num: p.doc, score: float64(p.tf)}, k)
				}
			}
			if len(h) >= k {
				return h
			}
		}
		// Rare: not enough scored docs — stamp the leaf's docs so the fill
		// scan below can offer the remaining (zero-score) candidates.
		board.reset(int(s.maxDoc))
		for _, p := range l.posts {
			board.add(p.doc, 0)
		}
	} else {
		if len(leaves) > 16 {
			// Wide expansions (prefix-fuzzy): candidates × leaves would be
			// quadratic, so sweep every posting into the score board once.
			board.reset(int(s.maxDoc))
			for _, l := range leaves {
				for _, p := range l.posts {
					board.add(p.doc, float64(p.tf))
				}
			}
			for _, num := range board.touched {
				if res.has(num) {
					offerTopK(&h, scoredDoc{num: num, score: board.get(num)}, k)
				}
			}
			if len(h) >= k {
				return h
			}
			fillZeroScore(res, board, &h, k)
			return h
		}
		total := 0
		for _, l := range leaves {
			total += len(l.posts)
		}
		if res.count()*len(leaves)*25 < total {
			// Very selective (multi-token CJK, tight AND): score each
			// candidate by binary-searching the doc-ordered leaf lists
			// instead of sweeping every posting. Every res candidate is
			// offered, so no fill scan is needed.
			for wi, w := range res.w {
				for w != 0 {
					j := bits.TrailingZeros64(w)
					num := uint32(wi*64 + j)
					w &= w - 1
					var score float64
					for _, l := range leaves {
						score += float64(tfOf(l.posts, num))
					}
					offerTopK(&h, scoredDoc{num: num, score: score}, k)
				}
			}
			return h
		}
		// General case: merge-join. Candidates ascend through res; each
		// list's pointer only moves forward, so every posting is visited
		// at most once with sequential (prefetch-friendly) access, and no
		// score-board traffic is needed at all.
		var ptrBuf [16]int
		ptrs := ptrBuf[:]
		if len(leaves) > len(ptrBuf) {
			ptrs = make([]int, len(leaves))
		} else {
			ptrs = ptrs[:len(leaves)]
		}
		for wi, w := range res.w {
			for w != 0 {
				j := bits.TrailingZeros64(w)
				num := uint32(wi*64 + j)
				w &= w - 1
				var score float64
				for i, l := range leaves {
					p := l.posts
					pi := ptrs[i]
					for pi < len(p) && p[pi].doc < num {
						pi++
					}
					ptrs[i] = pi
					if pi < len(p) && p[pi].doc == num {
						score += float64(p[pi].tf)
					}
				}
				offerTopK(&h, scoredDoc{num: num, score: score}, k)
			}
		}
		return h
	}
	// Single-leaf only: not enough scored docs — fill with zero-score
	// candidates, exactly as scanning every res bit would have.
	fillZeroScore(res, board, &h, k)
	return h
}

// fillZeroScore offers every res candidate not stamped on the score board
// with score 0, in doc order. Used when scored docs cannot fill k.
func fillZeroScore(res *bitmap, board *scoreBoard, h *[]scoredDoc, k int) {
	for wi, w := range res.w {
		for w != 0 {
			j := bits.TrailingZeros64(w)
			num := uint32(wi*64 + j)
			w &= w - 1
			if board.stamp[num] != board.gen {
				offerTopK(h, scoredDoc{num: num}, k)
			}
		}
	}
}
