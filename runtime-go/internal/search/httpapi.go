package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/pprof"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"runtime-go/internal/distrib"
	"runtime-go/internal/observability"
)

// HTTPHandler returns the searchd HTTP API:
//
//	POST   /documents       bulk-upsert a JSON array of Document
//	DELETE /documents/{id}  tombstone one document
//	GET    /search?q=...&limit=N
//	GET    /stats           engine counters snapshot
//	GET    /healthz         liveness probe
//	GET    /metrics         Prometheus exposition
//	GET    /cluster         cluster membership, health and local shard range
//	POST   /internal/query  peer RPC: query the given local shards only
//	POST   /internal/docs   peer RPC: apply upserts/deletes locally
//
// The /internal/* endpoints never fan out to other nodes; they exist so a
// cluster peer can serve exactly the shards it owns.
func (e *Engine) HTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /documents", e.handlePostDocuments)
	mux.HandleFunc("DELETE /documents/{id}", e.handleDeleteDocument)
	mux.HandleFunc("GET /search", e.handleSearch)
	mux.HandleFunc("GET /stats", e.handleStats)
	mux.HandleFunc("GET /healthz", e.handleHealthz)
	mux.HandleFunc("GET /cluster", e.handleCluster)
	mux.HandleFunc("POST /internal/query", e.handleInternalQuery)
	mux.HandleFunc("POST /internal/docs", e.handleInternalDocs)
	mux.Handle("GET /metrics", promhttp.HandlerFor(e.reg.gat, promhttp.HandlerOpts{}))
	// pprof for production profiling (CPU/heap/goroutine) — read-only.
	mux.HandleFunc("GET /debug/pprof/", pprof.Index)
	mux.HandleFunc("GET /debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("GET /debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
	return mux
}

type postDocumentsResponse struct {
	Upserted int `json:"upserted"`
}

func (e *Engine) handlePostDocuments(w http.ResponseWriter, r *http.Request) {
	var docs []Document
	if err := json.NewDecoder(r.Body).Decode(&docs); err != nil {
		writeError(w, observability.WrapError(ErrCodeBadRequest, "invalid JSON body", err), http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
	}
	if err := e.Update(ctx, docs, nil); err != nil {
		writeError(w, err, statusForError(err))
		return
	}
	writeJSON(w, http.StatusOK, postDocumentsResponse{Upserted: len(docs)})
}

func (e *Engine) handleDeleteDocument(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, observability.NewAppError(ErrCodeBadRequest, "missing document id"), http.StatusBadRequest)
		return
	}
	if err := e.Update(r.Context(), nil, []string{id}); err != nil {
		writeError(w, err, statusForError(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (e *Engine) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit := 10
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			limit = n
		}
	}
	start := time.Now()
	hits, partial, err := e.SearchDetailed(r.Context(), q, limit)
	if err != nil {
		writeError(w, err, statusForError(err))
		return
	}
	writeSearchJSON(w, hits, time.Since(start).Milliseconds(), partial)
}

// searchJSONBufPool recycles response buffers for the hand-rolled search
// serializers below (reflection-free: ~45% of handler CPU was encoding/json).
var searchJSONBufPool = sync.Pool{New: func() any { b := make([]byte, 0, 4096); return &b }}

// appendHits serializes a Hit slice as a JSON array without reflection.
func appendHits(buf []byte, hits []Hit) []byte {
	buf = append(buf, '[')
	for i, h := range hits {
		if i > 0 {
			buf = append(buf, ',')
		}
		buf = append(buf, `{"id":`...)
		buf = strconv.AppendQuote(buf, h.ID)
		buf = append(buf, `,"title":`...)
		buf = strconv.AppendQuote(buf, h.Title)
		buf = append(buf, `,"score":`...)
		buf = strconv.AppendFloat(buf, h.Score, 'f', -1, 64)
		buf = append(buf, '}')
	}
	return append(buf, ']')
}

// writeSearchJSON writes the /search response body from a pooled buffer.
func writeSearchJSON(w http.ResponseWriter, hits []Hit, tookMs int64, partial bool) {
	bp := searchJSONBufPool.Get().(*[]byte)
	buf := (*bp)[:0]
	buf = append(buf, `{"hits":`...)
	buf = appendHits(buf, hits)
	buf = append(buf, `,"took_ms":`...)
	buf = strconv.AppendInt(buf, tookMs, 10)
	if partial {
		buf = append(buf, `,"partial":true`...)
	}
	buf = append(buf, '}', '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf)
	*bp = buf
	searchJSONBufPool.Put(bp)
}

// internalQueryRequest is the peer RPC payload of POST /internal/query.
type internalQueryRequest struct {
	Shards []int  `json:"shards"`
	Query  string `json:"query"`
	Limit  int    `json:"limit"`
}

// internalQueryResponse decodes the per-node Top-K returned by a peer.
type internalQueryResponse struct {
	Hits []Hit `json:"hits"`
}

// handleInternalQuery answers a peer's shard-scoped query against the local
// index only. It never fans out, which keeps cluster queries cycle-free.
func (e *Engine) handleInternalQuery(w http.ResponseWriter, r *http.Request) {
	// P2-12：二进制热路径——仅在收到二进制请求时回二进制（老客户端 JSON 不变）
	if r.Header.Get("Content-Type") == queryBinContentType {
		req, err := decodeQueryBinReq(r.Body)
		if err != nil {
			writeError(w, observability.WrapError(ErrCodeBadRequest, "invalid binary body", err), http.StatusBadRequest)
			return
		}
		hits, err := e.searchLocalShards(r.Context(), req.Query, req.Shards, req.Limit)
		if err != nil {
			writeError(w, err, statusForError(err))
			return
		}
		w.Header().Set("Content-Type", queryBinContentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(appendQueryBinResp(nil, hits))
		return
	}
	var req internalQueryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, observability.WrapError(ErrCodeBadRequest, "invalid JSON body", err), http.StatusBadRequest)
		return
	}
	hits, err := e.searchLocalShards(r.Context(), req.Query, req.Shards, req.Limit)
	if err != nil {
		writeError(w, err, statusForError(err))
		return
	}
	writeHitsJSON(w, hits)
}

// writeHitsJSON writes the {"hits":[...]} peer-RPC body from a pooled buffer.
func writeHitsJSON(w http.ResponseWriter, hits []Hit) {
	bp := searchJSONBufPool.Get().(*[]byte)
	buf := (*bp)[:0]
	buf = append(buf, `{"hits":`...)
	buf = appendHits(buf, hits)
	buf = append(buf, '}', '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf)
	*bp = buf
	searchJSONBufPool.Put(bp)
}

// internalDocsRequest is the peer RPC payload of POST /internal/docs.
type internalDocsRequest struct {
	Upserts []Document `json:"upserts"`
	Deletes []string   `json:"deletes"`
}

// internalDocsResponse reports how many operations were applied locally.
type internalDocsResponse struct {
	Upserted int `json:"upserted"`
	Deleted  int `json:"deleted"`
}

// handleInternalDocs applies a peer-routed batch to the local index. The
// coordinating node already holds the DistLock for the whole batch, so this
// handler only serializes against other local swaps (updateMu inside
// applyLocal) and never fans out.
func (e *Engine) handleInternalDocs(w http.ResponseWriter, r *http.Request) {
	var req internalDocsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, observability.WrapError(ErrCodeBadRequest, "invalid JSON body", err), http.StatusBadRequest)
		return
	}
	e.applyLocal(req.Upserts, req.Deletes)
	writeJSON(w, http.StatusOK, internalDocsResponse{Upserted: len(req.Upserts), Deleted: len(req.Deletes)})
}

// clusterNodeInfo is one member entry of the GET /cluster response.
type clusterNodeInfo struct {
	ID      string `json:"id"`
	Addr    string `json:"addr"`
	Role    string `json:"role,omitempty"`
	Self    bool   `json:"self,omitempty"`
	Healthy bool   `json:"healthy"`
}

// clusterResponse describes membership, health and the local node's shard
// ownership. In single-node mode only mode and num_shards are meaningful.
type clusterResponse struct {
	Mode        string            `json:"mode"` // "cluster" or "single"
	NumShards   int               `json:"num_shards"`
	OwnedShards []int             `json:"owned_shards,omitempty"`
	Nodes       []clusterNodeInfo `json:"nodes,omitempty"`
}

func (e *Engine) handleCluster(w http.ResponseWriter, r *http.Request) {
	resp := clusterResponse{Mode: "single", NumShards: e.numShards()}
	if c := e.cluster; c != nil {
		resp.Mode = "cluster"
		resp.OwnedShards = c.ownedShards(e.numShards())
		self := c.reg.Self()
		for _, n := range append([]distrib.Node{self}, c.reg.Others()...) {
			resp.Nodes = append(resp.Nodes, clusterNodeInfo{
				ID:      n.ID,
				Addr:    n.Addr,
				Role:    n.Role,
				Self:    n.ID == self.ID,
				Healthy: c.reg.IsHealthy(n.ID),
			})
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (e *Engine) handleStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, e.Snapshot())
}

func (e *Engine) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ErrCodeBadRequest is the AppError code for malformed HTTP requests.
const ErrCodeBadRequest = "BAD_REQUEST"

// statusForError maps AppError codes to HTTP statuses.
func statusForError(err error) int {
	if ae, ok := err.(*observability.AppError); ok {
		switch ae.Code {
		case ErrCodeQueryParse, ErrCodeBadRequest:
			return http.StatusBadRequest
		case ErrCodeLockTimeout:
			return http.StatusServiceUnavailable
		}
	}
	return http.StatusInternalServerError
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if ae, ok := err.(*observability.AppError); ok {
		if data, jerr := ae.ToJSON(); jerr == nil {
			_, _ = w.Write(data)
			return
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
