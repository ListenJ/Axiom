package search

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
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
func (e *Engine) HTTPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /documents", e.handlePostDocuments)
	mux.HandleFunc("DELETE /documents/{id}", e.handleDeleteDocument)
	mux.HandleFunc("GET /search", e.handleSearch)
	mux.HandleFunc("GET /stats", e.handleStats)
	mux.HandleFunc("GET /healthz", e.handleHealthz)
	mux.Handle("GET /metrics", promhttp.HandlerFor(e.reg.gat, promhttp.HandlerOpts{}))
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

type searchResponse struct {
	Hits   []Hit `json:"hits"`
	TookMs int64 `json:"took_ms"`
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
	hits, err := e.Search(r.Context(), q, limit)
	if err != nil {
		writeError(w, err, statusForError(err))
		return
	}
	writeJSON(w, http.StatusOK, searchResponse{Hits: hits, TookMs: time.Since(start).Milliseconds()})
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
