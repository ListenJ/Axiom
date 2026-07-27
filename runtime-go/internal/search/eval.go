package search

import "strings"

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

// eval evaluates a condition-tree node against the shard and returns the
// matching document bitmap. Posting lists of positive (non-negated) leaf
// terms are appended to leaves for later scoring. AND children are expected
// to arrive pre-sorted by the optimizer (most selective first); evaluation
// short-circuits on an empty intermediate bitmap.
func (s *shardIndex) eval(n Node, alive *bitmap, negated bool, leaves *[][]posting) *bitmap {
	switch t := n.(type) {
	case Term:
		b, lists := s.evalTerm(t)
		if !negated {
			*leaves = append(*leaves, lists...)
		}
		return b
	case And:
		var res *bitmap
		for _, c := range t.Children {
			cb := s.eval(c, alive, negated, leaves)
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
			res = newBitmap(int(s.maxDoc))
		}
		return res
	case Or:
		res := newBitmap(int(s.maxDoc))
		for _, c := range t.Children {
			res.or(s.eval(c, alive, negated, leaves))
		}
		return res
	case Not:
		res := alive.clone()
		res.andNot(s.eval(t.Child, alive, true, leaves))
		return res
	}
	return newBitmap(int(s.maxDoc))
}

// evalTerm evaluates a single term condition: exact token match, field
// scoped match, or prefix-fuzzy expansion (capped at maxPrefixTerms).
// Multi-token values (e.g. CJK text tokenizing to several bigrams) are
// intersected, i.e. treated as a phrase-like AND.
func (s *shardIndex) evalTerm(t Term) (*bitmap, [][]posting) {
	b := newBitmap(int(s.maxDoc))
	var lists [][]posting

	if t.Prefix {
		pre := t.Value
		if t.Field != "" {
			pre = fieldKey(t.Field, t.Value)
		}
		matched := 0
		for k, p := range s.terms {
			if !strings.HasPrefix(k, pre) {
				continue
			}
			if t.Field == "" && strings.Contains(k, fieldSep) {
				continue // bare terms never match field-scoped keys
			}
			lists = append(lists, p)
			setBits(b, p)
			if matched++; matched >= maxPrefixTerms {
				break
			}
		}
		return b, lists
	}

	toks := Tokenize(t.Value)
	for i, tok := range toks {
		key := tok
		if t.Field != "" {
			key = fieldKey(t.Field, tok)
		}
		p := s.terms[key]
		if i == 0 {
			setBits(b, p)
		} else {
			tb := newBitmap(int(s.maxDoc))
			setBits(tb, p)
			b.and(tb)
			if b.isZero() {
				lists = append(lists, p)
				return b, lists
			}
		}
		lists = append(lists, p)
	}
	return b, lists
}

// topK scores every candidate in res (sum of term frequencies over the
// positive leaf posting lists) and keeps the k best.
func (s *shardIndex) topK(res *bitmap, leaves [][]posting, k int) []scoredDoc {
	h := docHeap{}
	res.iter(func(num uint32) {
		var score float64
		for _, l := range leaves {
			score += tfOf(l, num)
		}
		pushTopK(&h, scoredDoc{num: num, score: score}, k)
	})
	out := make([]scoredDoc, len(h))
	copy(out, h)
	return out
}
