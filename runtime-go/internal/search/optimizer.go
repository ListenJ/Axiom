package search

import "sort"

// Stats provides the corpus statistics the cost model needs.
type Stats interface {
	// DocFreq estimates how many documents a term condition matches.
	DocFreq(field, value string, prefix bool) int
	// TotalDocs returns the live document count.
	TotalDocs() int
}

// estimate approximates the number of documents a node matches, which the
// optimizer uses as the execution cost of that subtree.
func estimate(n Node, s Stats) float64 {
	switch t := n.(type) {
	case Term:
		return float64(s.DocFreq(t.Field, t.Value, t.Prefix)) + 1
	case And:
		best := float64(s.TotalDocs()) + 1
		for _, c := range t.Children {
			if e := estimate(c, s); e < best {
				best = e
			}
		}
		return best
	case Or:
		sum := 0.0
		for _, c := range t.Children {
			sum += estimate(c, s)
		}
		return sum
	case Not:
		return float64(s.TotalDocs()) - estimate(t.Child, s) + 1
	}
	return float64(s.TotalDocs()) + 1
}

// Optimize reorders the condition tree for cheaper evaluation: children of
// every AND node are sorted by ascending estimated match count so the most
// selective condition runs first and evaluation can short-circuit as soon
// as the intermediate bitmap becomes empty. The tree is rewritten in place
// and returned for chaining.
func Optimize(n Node, s Stats) Node {
	switch t := n.(type) {
	case And:
		for i := range t.Children {
			t.Children[i] = Optimize(t.Children[i], s)
		}
		sort.SliceStable(t.Children, func(i, j int) bool {
			return estimate(t.Children[i], s) < estimate(t.Children[j], s)
		})
		return t
	case Or:
		for i := range t.Children {
			t.Children[i] = Optimize(t.Children[i], s)
		}
		return t
	case Not:
		t.Child = Optimize(t.Child, s)
		return t
	}
	return n
}
