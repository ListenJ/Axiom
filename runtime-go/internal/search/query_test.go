package search

import (
	"context"
	"errors"
	"testing"

	"runtime-go/internal/observability"
)

// queryTestEngine builds a small engine over a fixed corpus covering every
// query-syntax feature.
func queryTestEngine(t *testing.T) *Engine {
	t.Helper()
	e := NewEngine(newTestRegistry(t), 8)
	mustBuild(t, e, []Document{
		{ID: "d1", Body: "alpha beta"},
		{ID: "d2", Body: "alpha gamma"},
		{ID: "d3", Body: "beta gamma"},
		{ID: "d4", Body: "delta", Fields: map[string]string{"lang": "go"}},
		{ID: "d5", Title: "Alphabet soup", Body: "epsilon"},
		{ID: "d6", Body: "知识图谱构建"},
	})
	return e
}

func TestQueryAND(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "alpha beta", 10))
	if len(got) != 1 || !got["d1"] {
		t.Fatalf("AND: got %v, want {d1}", got)
	}
}

func TestQueryOR(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "alpha OR gamma", 10))
	for _, id := range []string{"d1", "d2", "d3"} {
		if !got[id] {
			t.Fatalf("OR: missing %s in %v", id, got)
		}
	}
	if len(got) != 3 {
		t.Fatalf("OR: got %v, want exactly {d1,d2,d3}", got)
	}
}

func TestQueryNOT(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "alpha -beta", 10))
	if len(got) != 1 || !got["d2"] {
		t.Fatalf("NOT: got %v, want {d2}", got)
	}
}

func TestQueryNOTOnly(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "-alpha", 10))
	if got["d1"] || got["d2"] {
		t.Fatalf("NOT-only query returned excluded docs: %v", got)
	}
	if len(got) != 4 {
		t.Fatalf("NOT-only: got %v, want 4 docs", got)
	}
}

func TestQueryField(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "lang:go", 10))
	if len(got) != 1 || !got["d4"] {
		t.Fatalf("field query: got %v, want {d4}", got)
	}
}

func TestQueryTitleField(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "title:alphabet", 10))
	if len(got) != 1 || !got["d5"] {
		t.Fatalf("title field query: got %v, want {d5}", got)
	}
}

func TestQueryPrefix(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "alph*", 10))
	for _, id := range []string{"d1", "d2", "d5"} { // alpha, alpha, alphabet
		if !got[id] {
			t.Fatalf("prefix query: missing %s in %v", id, got)
		}
	}
}

func TestQueryCJKBigram(t *testing.T) {
	e := queryTestEngine(t)
	got := hitIDs(mustSearch(t, e, "知识", 10))
	if len(got) != 1 || !got["d6"] {
		t.Fatalf("CJK query: got %v, want {d6}", got)
	}
}

func TestQueryCombined(t *testing.T) {
	e := queryTestEngine(t)
	// (alpha AND gamma) OR (beta AND NOT alpha)
	got := hitIDs(mustSearch(t, e, "alpha gamma OR beta -alpha", 10))
	if !got["d2"] || !got["d3"] {
		t.Fatalf("combined query: got %v, want {d2,d3}", got)
	}
	if len(got) != 2 {
		t.Fatalf("combined query: got %v, want exactly 2 hits", got)
	}
}

func TestQueryParseErrors(t *testing.T) {
	e := queryTestEngine(t)
	cases := []string{"", "   ", "OR alpha", "alpha OR", "field:", "-", "a*bc"}
	for _, q := range cases {
		_, err := e.Search(context.Background(), q, 10)
		if err == nil {
			t.Fatalf("query %q: expected parse error", q)
		}
		var ae *observability.AppError
		if !errors.As(err, &ae) {
			t.Fatalf("query %q: error %v is not an AppError", q, err)
		}
		if ae.Code != ErrCodeQueryParse {
			t.Fatalf("query %q: error code %q, want %q", q, ae.Code, ErrCodeQueryParse)
		}
	}
}
