package search

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// idsOnDistinctShards returns count IDs hashing to pairwise distinct shards.
func idsOnDistinctShards(numShards, count int) []string {
	seen := make(map[int]bool)
	var ids []string
	for i := 0; len(ids) < count; i++ {
		id := fmt.Sprintf("sharddoc-%d", i)
		sh := shardOfID(id, numShards)
		if !seen[sh] {
			seen[sh] = true
			ids = append(ids, id)
		}
	}
	return ids
}

// TestTopKMergeAcrossShards verifies the per-shard Top-K heaps merge into a
// correct global Top-K ordered by score.
func TestTopKMergeAcrossShards(t *testing.T) {
	const shards = 8
	ids := idsOnDistinctShards(shards, 4)
	repeat := func(word string, n int) string {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = word
		}
		return strings.Join(parts, " ")
	}
	docs := []Document{
		{ID: ids[0], Body: repeat("apple", 3)},
		{ID: ids[1], Body: repeat("apple", 30)},
		{ID: ids[2], Body: repeat("apple", 10)},
		{ID: ids[3], Body: repeat("apple", 1)},
	}
	e := NewEngine(newTestRegistry(t), shards)
	mustBuild(t, e, docs)

	hits := mustSearch(t, e, "apple", 2)
	if len(hits) != 2 {
		t.Fatalf("top-2: got %d hits", len(hits))
	}
	if hits[0].ID != ids[1] || hits[1].ID != ids[2] {
		t.Fatalf("top-2 order: got [%s %s], want [%s %s]",
			hits[0].ID, hits[1].ID, ids[1], ids[2])
	}
	if hits[0].Score <= hits[1].Score {
		t.Fatalf("scores not descending: %+v", hits)
	}

	hits = mustSearch(t, e, "apple", 10)
	if len(hits) != 4 {
		t.Fatalf("full ranking: got %d hits, want 4", len(hits))
	}
	wantOrder := []string{ids[1], ids[2], ids[0], ids[3]}
	for i, id := range wantOrder {
		if hits[i].ID != id {
			t.Fatalf("rank %d: got %s, want %s (all=%+v)", i, hits[i].ID, id, hits)
		}
	}
}

// TestConcurrentReadWrite hammers the engine with parallel readers and
// writers; run with -race it proves the read path is lock-free and safe.
func TestConcurrentReadWrite(t *testing.T) {
	e := NewEngine(newTestRegistry(t), 16, WithLock(NewMemLock()))
	mustBuild(t, e, genDocs(500))
	ctx := context.Background()

	var wg sync.WaitGroup
	for w := 0; w < 3; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				doc := Document{
					ID:    fmt.Sprintf("writer-%d-doc-%d", w, i%10),
					Body:  fmt.Sprintf("concurrent writer %d payload iteration %d", w, i),
					Title: "writer",
				}
				if err := e.Update(ctx, []Document{doc}, nil); err != nil {
					t.Errorf("update: %v", err)
					return
				}
				if i%7 == 0 {
					_ = e.Update(ctx, nil, []string{fmt.Sprintf("writer-%d-doc-%d", w, i%10)})
				}
			}
		}(w)
	}
	for r := 0; r < 6; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				if _, err := e.Search(ctx, "concurrent OR w0001 -w0002", 5); err != nil {
					t.Errorf("search: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

// TestHTTPAPI exercises the HTTP surface end to end.
func TestHTTPAPI(t *testing.T) {
	e := NewEngine(newTestRegistry(t), 8)
	srv := httptest.NewServer(e.HTTPHandler())
	defer srv.Close()

	body := `[{"id":"h1","title":"hello world","body":"golang search engine","fields":{"lang":"go"}}]`
	resp, err := http.Post(srv.URL+"/documents", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("post status %d", resp.StatusCode)
	}

	resp, err = http.Get(srv.URL + "/search?q=lang:go&limit=5")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	defer resp.Body.Close()
	var sr searchResponse
	if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(sr.Hits) != 1 || sr.Hits[0].ID != "h1" {
		t.Fatalf("http search: %+v", sr)
	}

	resp, err = http.Get(srv.URL + "/search?q=" + "OR")
	if err != nil {
		t.Fatalf("search bad query: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad query status %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/documents/h1", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status %d", resp.StatusCode)
	}

	resp, err = http.Get(srv.URL + "/search?q=golang")
	if err != nil {
		t.Fatalf("search after delete: %v", err)
	}
	resp.Body.Close()

	for _, path := range []string{"/stats", "/healthz", "/metrics"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("get %s: status %d", path, resp.StatusCode)
		}
	}
}
