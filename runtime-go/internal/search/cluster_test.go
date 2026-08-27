package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"runtime-go/internal/distrib"
)

// clusterTestShards is the global shard count used by the cluster tests:
// small enough to keep ownership math obvious, large enough for both nodes
// to own several shards.
const clusterTestShards = 8

// clusterTestNode is one searchd instance wired to an httptest server on a
// pre-bound address, so both nodes' registries can list each other before
// either server starts.
type clusterTestNode struct {
	id   string
	addr string
	reg  *distrib.Registry
	eng  *Engine
	srv  *httptest.Server

	internalQueries atomic.Int32 // /internal/query calls received
	internalDocs    atomic.Int32 // /internal/docs calls received
}

// handler counts peer-RPC calls and delegates to the engine's HTTP API.
func (tn *clusterTestNode) handler() http.Handler {
	h := tn.eng.HTTPHandler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/query":
			tn.internalQueries.Add(1)
		case "/internal/docs":
			tn.internalDocs.Add(1)
		}
		h.ServeHTTP(w, r)
	})
}

// serveOn starts (or restarts) the node's HTTP server on listener l.
func (tn *clusterTestNode) serveOn(t *testing.T, l net.Listener) {
	t.Helper()
	tn.srv = httptest.NewUnstartedServer(tn.handler())
	tn.srv.Listener = l
	tn.srv.Start()
}

// startCluster launches two cluster-mode searchd instances (n1, n2) with
// mutually registered addresses.
func startCluster(t *testing.T) (a, b *clusterTestNode) {
	t.Helper()
	la, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen n1: %v", err)
	}
	lb, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen n2: %v", err)
	}
	nodes := []distrib.Node{
		{ID: "n1", Addr: "http://" + la.Addr().String()},
		{ID: "n2", Addr: "http://" + lb.Addr().String()},
	}
	a = newClusterTestNode(t, nodes, "n1")
	b = newClusterTestNode(t, nodes, "n2")
	a.serveOn(t, la)
	b.serveOn(t, lb)
	t.Cleanup(func() {
		a.srv.Close()
		b.srv.Close()
	})
	return a, b
}

func newClusterTestNode(t *testing.T, nodes []distrib.Node, selfID string) *clusterTestNode {
	t.Helper()
	tn := &clusterTestNode{id: selfID}
	for _, n := range nodes {
		if n.ID == selfID {
			tn.addr = n.Addr
		}
	}
	tn.reg = distrib.NewRegistry(nodes, selfID)
	tn.eng = NewEngine(newTestRegistry(t), clusterTestShards, WithCluster(tn.reg, clusterTestShards))
	return tn
}

// postDocuments bulk-upserts docs through the public HTTP API of the node at
// addr, exercising the full cluster write-routing path.
func postDocuments(t *testing.T, addr string, docs []Document) {
	t.Helper()
	raw, err := json.Marshal(docs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(addr+"/documents", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("post documents: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("post documents: status %s", resp.Status)
	}
}

// scoredDocs builds docs whose relevance to "shared" is strictly increasing,
// so Top-K selection is tie-free and deterministic across topologies.
func scoredDocs(n int) []Document {
	docs := make([]Document, n)
	for i := range docs {
		docs[i] = Document{
			ID:    fmt.Sprintf("doc-%03d", i),
			Title: fmt.Sprintf("unique-%03d", i),
			Body:  strings.Repeat("shared ", i+1) + fmt.Sprintf("unique-%03d", i),
		}
	}
	return docs
}

func TestClusterWriteRouting(t *testing.T) {
	a, b := startCluster(t)

	docs := genDocs(400)
	postDocuments(t, a.addr, docs)

	got := a.eng.DocCount() + b.eng.DocCount()
	if got != len(docs) {
		t.Fatalf("total docs across cluster = %d, want %d", got, len(docs))
	}
	for _, tn := range []*clusterTestNode{a, b} {
		dc := tn.eng.DocCount()
		if dc < len(docs)/4 || dc > 3*len(docs)/4 {
			t.Fatalf("node %s holds %d docs, want roughly half of %d", tn.id, dc, len(docs))
		}
	}

	// Every document lives exactly on the node owning its shard.
	for _, d := range docs {
		owner := a.eng.cluster.shardOwner(shardOfID(d.ID, clusterTestShards)).ID
		holder, other := a, b
		if owner == b.id {
			holder, other = b, a
		}
		if _, ok := holder.eng.idx.Load().ids[d.ID]; !ok {
			t.Fatalf("doc %s (owner %s) missing on node %s", d.ID, owner, holder.id)
		}
		if _, ok := other.eng.idx.Load().ids[d.ID]; ok {
			t.Fatalf("doc %s (owner %s) unexpectedly present on node %s", d.ID, owner, other.id)
		}
	}
}

// searchResponse mirrors the /search JSON body for decoding in tests.
type searchResponse struct {
	Hits    []Hit `json:"hits"`
	TookMs  int64 `json:"took_ms"`
	Partial bool  `json:"partial,omitempty"`
}

func TestClusterQueryMerge(t *testing.T) {
	a, b := startCluster(t)

	docs := scoredDocs(60)
	postDocuments(t, a.addr, docs)

	ref := NewEngine(newTestRegistry(t), clusterTestShards)
	mustBuild(t, ref, docs)

	queries := []string{"shared", "shared AND unique-007", "unique-020 OR unique-040"}
	for _, q := range queries {
		want := mustSearch(t, ref, q, 10)

		// Engine-level query on node a.
		gotA := mustSearch(t, a.eng, q, 10)
		if fmt.Sprint(gotA) != fmt.Sprint(want) {
			t.Fatalf("query %q via node n1:\n got %v\nwant %v", q, gotA, want)
		}

		// HTTP-level query on node b (the node that received no writes).
		u := b.addr + "/search?" + url.Values{"q": {q}, "limit": {"10"}}.Encode()
		resp, err := http.Get(u)
		if err != nil {
			t.Fatalf("get /search: %v", err)
		}
		var sr searchResponse
		if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
			t.Fatalf("decode: %v", err)
		}
		_ = resp.Body.Close()
		if sr.Partial {
			t.Fatalf("query %q via node n2 reported partial", q)
		}
		if fmt.Sprint(sr.Hits) != fmt.Sprint(want) {
			t.Fatalf("query %q via node n2:\n got %v\nwant %v", q, sr.Hits, want)
		}
	}
}

func TestClusterNodeDownPartial(t *testing.T) {
	a, b := startCluster(t)

	docs := scoredDocs(60)
	postDocuments(t, a.addr, docs)

	full, partial, err := a.eng.SearchDetailed(context.Background(), "shared", 10)
	if err != nil || partial {
		t.Fatalf("baseline: hits=%d partial=%v err=%v", len(full), partial, err)
	}

	// Kill node n2: RPCs to it now fail, so queries must degrade to partial
	// while still returning the locally owned data.
	b.srv.Close()
	degraded, partial, err := a.eng.SearchDetailed(context.Background(), "shared", 10)
	if err != nil {
		t.Fatalf("degraded search: %v", err)
	}
	if !partial {
		t.Fatal("expected partial=true while n2 is down")
	}
	if len(degraded) == 0 {
		t.Fatal("expected locally owned hits while n2 is down")
	}
	for _, h := range degraded {
		owner := a.eng.cluster.shardOwner(shardOfID(h.ID, clusterTestShards)).ID
		if owner != a.id {
			t.Fatalf("hit %s belongs to down node %s but was returned", h.ID, owner)
		}
	}

	// The unhealthy-skip path must also mark partial without even attempting
	// the RPC (health flag driven by the heartbeat in production).
	a.reg.MarkUnhealthy(b.id)
	before := b.internalQueries.Load()
	if _, partial, err = a.eng.SearchDetailed(context.Background(), "shared", 10); err != nil || !partial {
		t.Fatalf("unhealthy-skip: partial=%v err=%v", partial, err)
	}
	if b.internalQueries.Load() != before {
		t.Fatal("query fanned out to a node already marked unhealthy")
	}

	// Recover: restart n2 on the same address and mark it healthy (the
	// heartbeat's job in production).
	l, err := net.Listen("tcp", strings.TrimPrefix(b.addr, "http://"))
	if err != nil {
		t.Fatalf("re-listen n2: %v", err)
	}
	b.serveOn(t, l)
	a.reg.MarkHealthy(b.id)

	restored, partial, err := a.eng.SearchDetailed(context.Background(), "shared", 10)
	if err != nil || partial {
		t.Fatalf("restored: partial=%v err=%v", partial, err)
	}
	if fmt.Sprint(restored) != fmt.Sprint(full) {
		t.Fatalf("restored hits differ:\n got %v\nwant %v", restored, full)
	}

	// The partial-query counter recorded the degradation.
	mfs, err := a.eng.reg.gat.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	found := false
	for _, mf := range mfs {
		if mf.GetName() != "searchd_partial_queries_total" {
			continue
		}
		found = true
		if mf.GetMetric()[0].GetCounter().GetValue() < 1 {
			t.Fatal("searchd_partial_queries_total was not incremented")
		}
	}
	if !found {
		t.Fatal("searchd_partial_queries_total not exposed")
	}
}

func TestClusterNoDoubleFanout(t *testing.T) {
	a, b := startCluster(t)

	docs := scoredDocs(60)
	postDocuments(t, a.addr, docs)

	a.internalQueries.Store(0)
	b.internalQueries.Store(0)
	a.internalDocs.Store(0)
	b.internalDocs.Store(0)

	_ = mustSearch(t, a.eng, "shared", 10)

	// All remote shards live on n2, so exactly one grouped /internal/query
	// call must reach n2, and n2 must not loop anything back to n1.
	if got := b.internalQueries.Load(); got != 1 {
		t.Fatalf("n2 received %d /internal/query calls, want 1", got)
	}
	if got := a.internalQueries.Load(); got != 0 {
		t.Fatalf("n1 received %d /internal/query calls, want 0 (no loopback)", got)
	}
	if got := b.internalDocs.Load(); got != 0 {
		t.Fatalf("n2 received %d /internal/docs calls during search, want 0", got)
	}
}

func TestClusterEndpoint(t *testing.T) {
	a, _ := startCluster(t)

	resp, err := http.Get(a.addr + "/cluster")
	if err != nil {
		t.Fatalf("get /cluster: %v", err)
	}
	var cr clusterResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = resp.Body.Close()

	if cr.Mode != "cluster" {
		t.Fatalf("mode = %q, want cluster", cr.Mode)
	}
	if cr.NumShards != clusterTestShards {
		t.Fatalf("num_shards = %d, want %d", cr.NumShards, clusterTestShards)
	}
	if len(cr.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2", len(cr.Nodes))
	}
	for _, n := range cr.Nodes {
		if !n.Healthy {
			t.Fatalf("node %s reported unhealthy", n.ID)
		}
	}
	// n1 sorts before n2, so n1 owns the even shards.
	wantOwned := []int{0, 2, 4, 6}
	if fmt.Sprint(cr.OwnedShards) != fmt.Sprint(wantOwned) {
		t.Fatalf("owned_shards = %v, want %v", cr.OwnedShards, wantOwned)
	}

	// Single-node engines report mode "single".
	single := NewEngine(newTestRegistry(t), 4)
	srv := httptest.NewServer(single.HTTPHandler())
	defer srv.Close()
	resp, err = http.Get(srv.URL + "/cluster")
	if err != nil {
		t.Fatalf("get /cluster (single): %v", err)
	}
	cr = clusterResponse{}
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		t.Fatalf("decode (single): %v", err)
	}
	_ = resp.Body.Close()
	if cr.Mode != "single" || cr.NumShards != 4 {
		t.Fatalf("single-node /cluster = %+v", cr)
	}
}

func TestSingleNodeSearchResponseShape(t *testing.T) {
	// Single-node mode keeps the pre-cluster response shape: no partial key.
	e := NewEngine(newTestRegistry(t), 8)
	mustBuild(t, e, []Document{{ID: "x", Body: "hello world"}})
	srv := httptest.NewServer(e.HTTPHandler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/search?q=hello")
	if err != nil {
		t.Fatalf("get /search: %v", err)
	}
	raw := new(bytes.Buffer)
	_, _ = raw.ReadFrom(resp.Body)
	_ = resp.Body.Close()
	if bytes.Contains(raw.Bytes(), []byte("partial")) {
		t.Fatalf("single-node response contains partial key: %s", raw)
	}
}
