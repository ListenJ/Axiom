// Command pcdad runs the PDCA engine as an HTTP daemon.
//
// Endpoints:
//
//	POST /cycles       submit a cycle (JSON: id, priority, payload)
//	GET  /cycles/{id}  query cycle status
//	POST /tx/prepare   2PC participant endpoint (body: Transition JSON)
//	POST /tx/commit    2PC participant endpoint
//	POST /tx/abort     2PC participant endpoint
//	GET  /healthz      liveness probe
//	GET  /metrics      Prometheus metrics
//
// The /tx/* endpoints let a Coordinator on another node drive two-phase
// commits against this process's in-memory participant, enabling real
// cross-machine 2PC in a two-node deployment.
//
// The listen address comes from PCDAD_ADDR (default ":9101"); the
// snapshot/WAL directory from PCDAD_DATA_DIR (default "./pcda-data");
// PCDAD_NODE_ID optionally tags log lines with a node identifier.
// On SIGINT/SIGTERM the daemon shuts down gracefully, writing a final
// snapshot before exit.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"runtime-go/internal/netutil"
	"runtime-go/internal/observability"
	"runtime-go/internal/pcda"
)

// submitRequest is the POST /cycles wire shape.
type submitRequest struct {
	ID       string            `json:"id,omitempty"`
	Priority pcda.Priority     `json:"priority,omitempty"`
	Payload  map[string]string `json:"payload,omitempty"`
}

// submitResponse is the accepted-cycle reply.
type submitResponse struct {
	ID string `json:"id"`
}

// server wires the HTTP surface to the engine.
type server struct {
	engine *pcda.Engine
}

func main() {
	addr := os.Getenv("PCDAD_ADDR")
	if addr == "" {
		addr = ":9101"
	}
	dataDir := os.Getenv("PCDAD_DATA_DIR")
	if dataDir == "" {
		dataDir = "./pcda-data"
	}
	nodeID := os.Getenv("PCDAD_NODE_ID")
	if nodeID == "" {
		nodeID = "node-1"
	}

	engine := pcda.NewEngine(pcda.Config{
		DataDir:           dataDir,
		SnapshotInterval:  30 * time.Second,
		AutoscaleInterval: time.Second,
	}, prometheus.DefaultRegisterer)

	ctx := context.Background()
	if err := engine.Start(ctx); err != nil {
		log.Fatalf("pcdad: start engine: %v", err)
	}

	s := &server{engine: engine}
	tx := pcda.NewTxHandler(engine.Store())
	mux := http.NewServeMux()
	mux.HandleFunc("POST /cycles", s.handleSubmit)
	mux.HandleFunc("GET /cycles/{id}", s.handleGet)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.Handle("POST /tx/prepare", tx)
	mux.Handle("POST /tx/commit", tx)
	mux.Handle("POST /tx/abort", tx)
	mux.Handle("GET /metrics", promhttp.Handler())

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	// P2-12b：多 acceptor 并发监听（PCDAD_LISTENERS，Linux SO_REUSEPORT）
	pcdCtx, pcdStop := context.WithCancel(context.Background())
	go func() {
		<-sig
		pcdStop()
	}()
	log.Printf("pcdad[%s]: listening on %s, data dir %s", nodeID, addr, dataDir)
	if err := netutil.ServeAll(pcdCtx, httpSrv, addr, "PCDAD_LISTENERS", fmt.Sprintf("pcdad[%s]", nodeID)); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("pcdad: serve: %v", err)
	}

	<-sig
	log.Println("pcdad: shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("pcdad: http shutdown: %v", err)
	}
	// Engine shutdown writes the final snapshot and closes the WAL.
	if err := engine.Shutdown(shutdownCtx); err != nil {
		log.Printf("pcdad: engine shutdown: %v", err)
	}
	log.Println("pcdad: bye")
}

// handleSubmit accepts a new cycle.
func (s *server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	var req submitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, observability.NewAppError("PCDAD_BAD_JSON", "invalid request body"))
		return
	}
	if req.ID == "" {
		req.ID = newID()
	}
	c := pcda.AcquireCycle()
	c.ID = req.ID
	c.Priority = req.Priority
	c.Payload = req.Payload
	if err := s.engine.Submit(c); err != nil {
		var appErr *observability.AppError
		if errors.As(err, &appErr) && appErr.Code == pcda.ErrCodeCycleExists {
			writeError(w, http.StatusConflict, appErr)
			return
		}
		if errors.As(err, &appErr) && appErr.Code == pcda.ErrCodeQueueFull {
			writeError(w, http.StatusServiceUnavailable, appErr)
			return
		}
		writeError(w, http.StatusInternalServerError, observability.WrapError("PCDAD_SUBMIT", "submit failed", err))
		return
	}
	writeJSON(w, http.StatusAccepted, submitResponse{ID: req.ID})
}

// handleGet returns the published state of one cycle.
func (s *server) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c, ok := s.engine.Cycle(id)
	if !ok {
		writeError(w, http.StatusNotFound, observability.NewAppError(pcda.ErrCodeNotFound, "cycle not found").
			WithContext("cycle_id", id))
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// handleHealth is the liveness probe.
func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// writeJSON serializes v with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError renders an AppError as JSON.
func writeError(w http.ResponseWriter, status int, err *observability.AppError) {
	writeJSON(w, status, err)
}

// newID generates a random hex cycle ID.
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand never fails on supported platforms; fall back to time.
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b[:])
}
