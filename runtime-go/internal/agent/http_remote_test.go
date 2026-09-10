package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"runtime-go/internal/distrib"
)

func TestInternalRunEndpoint(t *testing.T) {
	c := newTestCluster(t)
	h := NewHandler(c)

	// A peer-posted task executes on a local agent and returns its result.
	body := `{"id":"t-remote","def_name":"crawler","resources":{"memory_bytes":1024,"cpu_cores":0.5}}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/internal/run", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /internal/run = %d: %s", rec.Code, rec.Body)
	}
	var res TaskResult
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.TaskID != "t-remote" || res.PeakMemoryBytes != 1024 {
		t.Fatalf("result = %+v", res)
	}

	// A task no local agent can accommodate waits for capacity: the peer
	// gets 503 so its retry layer can try again later.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/internal/run",
		strings.NewReader(`{"id":"t-fat","def_name":"crawler","resources":{"memory_bytes":10995116277760,"cpu_cores":0.5}}`)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("oversized task = %d, want 503: %s", rec.Code, rec.Body)
	}

	// Malformed body → 400.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/internal/run", strings.NewReader(`{`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body = %d, want 400", rec.Code)
	}
}

func TestClusterEndpointNodeHealthView(t *testing.T) {
	stub := &remoteStub{t: t}
	srv := newRemoteStubServer(t, stub)
	nodes := []distrib.Node{
		{ID: "node-a", Addr: "http://127.0.0.1:1"},
		{ID: "node-b", Addr: srv.URL, Role: "primary"},
	}
	c := newRemoteCluster(t, "node-a", nodes, 1)
	h := NewHandler(c)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/cluster", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /cluster = %d", rec.Code)
	}
	var st ClusterStatus
	if err := json.NewDecoder(rec.Body).Decode(&st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(st.Nodes) != 2 {
		t.Fatalf("nodes = %+v, want 2 entries", st.Nodes)
	}
	byID := map[string]NodeStatus{}
	for _, n := range st.Nodes {
		byID[n.ID] = n
	}
	if !byID["node-a"].Self || !byID["node-a"].Healthy {
		t.Fatalf("node-a = %+v, want self+healthy", byID["node-a"])
	}
	if byID["node-b"].Role != "primary" || byID["node-b"].Self {
		t.Fatalf("node-b = %+v", byID["node-b"])
	}

	// Health flips are reflected in the view.
	c.Registry().MarkUnhealthy("node-b")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/cluster", nil))
	json.NewDecoder(rec.Body).Decode(&st)
	for _, n := range st.Nodes {
		if n.ID == "node-b" && n.Healthy {
			t.Fatalf("node-b should report unhealthy: %+v", st.Nodes)
		}
	}
}

// TestClusterEndpointSingleNodeUnchanged guards the regression contract:
// without Nodes the status payload carries no node view.
func TestClusterEndpointSingleNodeUnchanged(t *testing.T) {
	c := newTestCluster(t)
	h := NewHandler(c)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/cluster", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /cluster = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "nodes") {
		t.Fatalf("single-node status must not expose a nodes view: %s", rec.Body)
	}
}
