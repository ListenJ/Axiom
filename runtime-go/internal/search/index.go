package search

import (
	"hash/fnv"
	"maps"
	"slices"
	"sort"
	"strings"
	"sync"
)

// Document is the unit of indexing.
type Document struct {
	ID     string            `json:"id"`
	Title  string            `json:"title"`
	Body   string            `json:"body"`
	Fields map[string]string `json:"fields,omitempty"`
}

// Hit is a single search result.
type Hit struct {
	ID    string  `json:"id"`
	Title string  `json:"title"`
	Score float64 `json:"score"`
}

// fieldSep separates the field name from the token inside a field-scoped
// index key; it cannot appear in a token produced by Tokenize.
const fieldSep = "\x00"

// fieldKey builds the index key for token inside a named field.
func fieldKey(field, token string) string { return field + fieldSep + token }

// maxPrefixTerms caps how many distinct index terms a prefix-fuzzy term may
// expand into, bounding worst-case query cost.
const maxPrefixTerms = 512

// posting records one occurrence of a term in a document.
type posting struct {
	doc uint32
	tf  int32
}

// lessPosting orders postings by (tf desc, doc asc): the strongest, lowest
// numbered document first. Top-K relies on this order for early exit.
func lessPosting(a, b posting) bool {
	if a.tf != b.tf {
		return a.tf > b.tf
	}
	return a.doc < b.doc
}

// sortPostings sorts a posting list in place by lessPosting.
func sortPostings(l []posting) {
	sort.Slice(l, func(i, j int) bool { return lessPosting(l[i], l[j]) })
}

// storedDoc is the per-document payload kept for result rendering.
type storedDoc struct {
	id    string
	title string
}

// shardIndex is one immutable shard of the inverted index. It is never
// mutated after construction; updates clone it (see Index.apply).
type shardIndex struct {
	terms    map[string][]posting // posting lists sorted by doc number
	termsTF  map[string][]posting // same lists, sorted by (tf desc, doc asc)
	termKeys []string             // sorted keys of terms, for prefix expansion
	docs     map[uint32]storedDoc // doc number -> stored payload
	tomb     map[uint32]struct{}  // tombstoned (deleted/superseded) doc numbers
	maxDoc   uint32               // exclusive upper bound of doc numbers
	alive    *bitmap              // non-tombstoned docs; maintained under COW
}

// prefixPostings returns the posting lists of up to max term keys having
// prefix pre, in ascending key order. When bare is true, field-scoped keys
// never match (a bare term only sees the title+body term space). The sorted
// termKeys slice turns expansion into a binary search plus a short scan
// instead of a full terms-map walk.
func (s *shardIndex) prefixPostings(pre string, bare bool, max int) [][]posting {
	var lists [][]posting
	for i := sort.SearchStrings(s.termKeys, pre); i < len(s.termKeys); i++ {
		k := s.termKeys[i]
		if !strings.HasPrefix(k, pre) {
			break // sorted: the prefix range is contiguous
		}
		if bare && strings.Contains(k, fieldSep) {
			continue
		}
		lists = append(lists, s.terms[k])
		if len(lists) >= max {
			break
		}
	}
	return lists
}

// Index is an immutable snapshot of the whole sharded index.
type Index struct {
	shards []*shardIndex
	ids    map[string]uint32 // external ID -> doc number
	docs   int               // live (non-tombstoned) document count
}

// shardOfID maps a document ID to its shard.
func shardOfID(id string, numShards int) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return int(h.Sum32() % uint32(numShards))
}

// docTerms extracts the index keys of d with their term frequencies. Title
// and body tokens share the bare term space; title tokens are additionally
// indexed under the "title" field and Fields entries under their own name.
func docTerms(d Document) map[string]int32 {
	counts := make(map[string]int32, 16)
	for _, tok := range Tokenize(d.Title + " " + d.Body) {
		counts[tok]++
	}
	for _, tok := range Tokenize(d.Title) {
		counts[fieldKey("title", tok)]++
	}
	for f, v := range d.Fields {
		f = strings.ToLower(f)
		for _, tok := range Tokenize(v) {
			counts[fieldKey(f, tok)]++
		}
	}
	return counts
}

type numberedDoc struct {
	num uint32
	doc Document
}

// buildShard builds one shard from its pre-assigned documents. Because doc
// numbers are assigned in input order before sharding, posting lists come
// out sorted by doc number regardless of scheduling; termsTF holds a second
// copy of each list sorted by (tf desc, doc asc) for the single-term Top-K
// early-exit fast path (see topK).
func buildShard(nds []numberedDoc) *shardIndex {
	s := &shardIndex{
		terms:   make(map[string][]posting),
		termsTF: make(map[string][]posting),
		docs:    make(map[uint32]storedDoc, len(nds)),
		tomb:    make(map[uint32]struct{}),
	}
	for _, nd := range nds {
		s.docs[nd.num] = storedDoc{id: nd.doc.ID, title: nd.doc.Title}
		if nd.num >= s.maxDoc {
			s.maxDoc = nd.num + 1
		}
		for term, tf := range docTerms(nd.doc) {
			s.terms[term] = append(s.terms[term], posting{doc: nd.num, tf: tf})
		}
	}
	for term, l := range s.terms {
		c := slices.Clone(l)
		sortPostings(c)
		s.termsTF[term] = c
	}
	s.alive = newBitmap(int(s.maxDoc))
	for num := range s.docs {
		s.alive.set(num)
	}
	s.termKeys = make([]string, 0, len(s.terms))
	for k := range s.terms {
		s.termKeys = append(s.termKeys, k)
	}
	sort.Strings(s.termKeys)
	return s
}

// BuildIndex builds a sharded inverted index over docs in parallel.
//
// Doc numbers are assigned in input order (duplicate IDs: first occurrence
// wins) so the result is deterministic and independent of workers. Each
// shard is built by a single goroutine drawn from a pool of workers.
func BuildIndex(docs []Document, numShards, workers int) *Index {
	if numShards < 1 {
		numShards = 1
	}
	if workers < 1 {
		workers = 1
	}
	groups := make([][]numberedDoc, numShards)
	ids := make(map[string]uint32, len(docs))
	for i := range docs {
		d := docs[i]
		if _, dup := ids[d.ID]; dup {
			continue
		}
		num := uint32(len(ids))
		ids[d.ID] = num
		sh := shardOfID(d.ID, numShards)
		groups[sh] = append(groups[sh], numberedDoc{num: num, doc: d})
	}

	idx := &Index{shards: make([]*shardIndex, numShards), ids: ids, docs: len(ids)}
	tasks := make(chan int, numShards)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for sh := range tasks {
				idx.shards[sh] = buildShard(groups[sh])
			}
		}()
	}
	for sh := range groups {
		tasks <- sh
	}
	close(tasks)
	wg.Wait()
	return idx
}

// apply returns a new Index with the given upserts and deletes applied,
// leaving idx untouched (copy-on-write). Only shards that actually change
// are cloned; untouched shards are shared with the old snapshot. nextNum
// must return monotonically increasing, previously unused doc numbers.
//
// Deletes are tombstones: posting entries are kept and filtered at query
// time, which makes updates cheap at the cost of some retained memory.
func (idx *Index) apply(upserts []Document, deletes []string, nextNum func() uint32) *Index {
	c := &Index{shards: make([]*shardIndex, len(idx.shards)), ids: maps.Clone(idx.ids)}
	copy(c.shards, idx.shards)

	// cloneShard lazily clones shard sh on first write.
	cloneShard := func(sh int) *shardIndex {
		if c.shards[sh] == idx.shards[sh] {
			s := idx.shards[sh]
			c.shards[sh] = &shardIndex{
				terms:    maps.Clone(s.terms),
				termsTF:  maps.Clone(s.termsTF),
				termKeys: slices.Clone(s.termKeys),
				docs:     maps.Clone(s.docs),
				tomb:     maps.Clone(s.tomb),
				maxDoc:   s.maxDoc,
				alive:    s.alive.clone(),
			}
		}
		return c.shards[sh]
	}

	for _, id := range deletes {
		num, ok := c.ids[id]
		if !ok {
			continue
		}
		sh := cloneShard(shardOfID(id, len(c.shards)))
		sh.tomb[num] = struct{}{}
		sh.alive.clear(num)
		delete(c.ids, id)
	}

	for i := range upserts {
		d := upserts[i]
		sh := cloneShard(shardOfID(d.ID, len(c.shards)))
		if old, ok := c.ids[d.ID]; ok {
			sh.tomb[old] = struct{}{}
			sh.alive.clear(old)
		}
		num := nextNum()
		c.ids[d.ID] = num
		sh.docs[num] = storedDoc{id: d.ID, title: d.Title}
		if num >= sh.maxDoc {
			sh.maxDoc = num + 1
		}
		sh.alive.set(num)
		for term, tf := range docTerms(d) {
			old := sh.terms[term]
			if old == nil { // new term key: keep termKeys sorted
				i := sort.SearchStrings(sh.termKeys, term)
				sh.termKeys = slices.Insert(sh.termKeys, i, term)
			}
			np := make([]posting, len(old), len(old)+1)
			copy(np, old)
			sh.terms[term] = append(np, posting{doc: num, tf: tf})
			// Insert into the tf-ordered copy keeping the (tf desc, doc asc)
			// order the Top-K fast path relies on.
			oldTF := sh.termsTF[term]
			np2 := posting{doc: num, tf: tf}
			pos := sort.Search(len(oldTF), func(i int) bool { return lessPosting(np2, oldTF[i]) })
			nl := make([]posting, len(oldTF)+1)
			copy(nl, oldTF[:pos])
			nl[pos] = np2
			copy(nl[pos+1:], oldTF[pos:])
			sh.termsTF[term] = nl
		}
	}
	c.docs = len(c.ids)
	return c
}
