package search

// DocFreq implements Stats for the cost-based optimizer: it estimates how
// many documents a term condition matches by summing posting-list lengths
// across shards. Prefix terms sum all matching expansions; multi-token
// exact terms use the rarest token (intersection estimate).
func (idx *Index) DocFreq(field, value string, prefix bool) int {
	total := 0
	if prefix {
		pre := value
		if field != "" {
			pre = fieldKey(field, value)
		}
		for _, sh := range idx.shards {
			for _, p := range sh.prefixPostings(pre, field == "", maxPrefixTerms) {
				total += len(p)
			}
		}
		return total
	}
	toks := Tokenize(value)
	best := -1
	for _, tok := range toks {
		key := tok
		if field != "" {
			key = fieldKey(field, tok)
		}
		df := 0
		for _, sh := range idx.shards {
			df += len(sh.terms[key])
		}
		if best < 0 || df < best {
			best = df
		}
	}
	if best < 0 {
		return 0
	}
	return best
}

// TotalDocs implements Stats.
func (idx *Index) TotalDocs() int { return idx.docs }
