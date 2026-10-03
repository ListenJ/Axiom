package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/pprof"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

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
//	GET    /cluster         single-machine mode and shard count
func (e *Engine) HTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /documents", e.handlePostDocuments)
	mux.HandleFunc("DELETE /documents/{id}", e.handleDeleteDocument)
	mux.HandleFunc("GET /search", e.handleSearch)
	mux.HandleFunc("GET /stats", e.handleStats)
	mux.HandleFunc("GET /healthz", e.handleHealthz)
	mux.HandleFunc("GET /cluster", e.handleCluster)
	mux.Handle("GET /metrics", promhttp.HandlerFor(e.reg.gat, promhttp.HandlerOpts{}))
	// pprof for production profiling (CPU/heap/goroutine) — read-only,
	// mounted only when DEBUG_PPROF=1 so it is off by default.
	if os.Getenv("DEBUG_PPROF") == "1" {
		mux.HandleFunc("GET /debug/pprof/", pprof.Index)
		mux.HandleFunc("GET /debug/pprof/cmdline", pprof.Cmdline)
		mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
		mux.HandleFunc("GET /debug/pprof/symbol", pprof.Symbol)
		mux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
	}
	return mux
}

type postDocumentsResponse struct {
	Upserted int `json:"upserted"`
}

// searchResponse mirrors the /search JSON body for tests and clients.
type searchResponse struct {
	Hits    []Hit `json:"hits"`
	TookMs  int64 `json:"took_ms"`
	Partial bool  `json:"partial,omitempty"`
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

// clusterResponse describes single-machine mode and local shard ownership.
type clusterResponse struct {
	Mode        string `json:"mode"` // always "single" after 2026-10-03 multi-machine retirement
	NumShards   int    `json:"num_shards"`
	OwnedShards []int  `json:"owned_shards,omitempty"`
}

func (e *Engine) handleCluster(w http.ResponseWriter, r *http.Request) {
	n := e.numShards()
	owned := make([]int, n)
	for i := range owned {
		owned[i] = i
	}
	writeJSON(w, http.StatusOK, clusterResponse{Mode: "single", NumShards: n, OwnedShards: owned})
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
