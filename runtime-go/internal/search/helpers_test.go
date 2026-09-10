package search

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// newTestRegistry returns an isolated Prometheus registry so tests never
// collide on collector registration.
func newTestRegistry(t *testing.T) *prometheus.Registry {
	t.Helper()
	return prometheus.NewRegistry()
}

func mustBuild(t *testing.T, e *Engine, docs []Document) {
	t.Helper()
	if err := e.Build(context.Background(), docs); err != nil {
		t.Fatalf("build: %v", err)
	}
}

func mustSearch(t *testing.T, e *Engine, q string, limit int) []Hit {
	t.Helper()
	hits, err := e.Search(context.Background(), q, limit)
	if err != nil {
		t.Fatalf("search %q: %v", q, err)
	}
	return hits
}

// hitIDs extracts result IDs as a set.
func hitIDs(hits []Hit) map[string]bool {
	m := make(map[string]bool, len(hits))
	for _, h := range hits {
		m[h.ID] = true
	}
	return m
}

// genDocs deterministically generates n synthetic documents. The word
// distribution is skewed: 80% of tokens come from the 200 most common words
// of a 5000-word vocabulary, so both rare and very frequent terms exist.
func genDocs(n int) []Document {
	r := rand.New(rand.NewSource(42))
	vocab := make([]string, 5000)
	for i := range vocab {
		vocab[i] = fmt.Sprintf("w%04d", i)
	}
	word := func() string {
		if r.Intn(100) < 80 {
			return vocab[r.Intn(200)]
		}
		return vocab[r.Intn(5000)]
	}
	docs := make([]Document, n)
	for i := 0; i < n; i++ {
		var title, body strings.Builder
		for j := 0; j < 3; j++ {
			title.WriteString(word())
			title.WriteByte(' ')
		}
		for j := 0; j < 40; j++ {
			body.WriteString(word())
			body.WriteByte(' ')
		}
		docs[i] = Document{
			ID:     fmt.Sprintf("doc-%d", i),
			Title:  title.String(),
			Body:   body.String(),
			Fields: map[string]string{"cat": fmt.Sprintf("c%d", r.Intn(10))},
		}
	}
	return docs
}
