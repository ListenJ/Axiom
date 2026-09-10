package agent

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// NewHandler returns the HTTP API of the agent module:
//
//	POST /task-defs                     create a definition or append a version
//	GET  /task-defs                     list current versions
//	GET  /task-defs/{name}              get the current version
//	GET  /task-defs/{name}/versions     list the full version history
//	POST /task-defs/{name}/rollback     roll back to a historical version
//	POST /tasks                         submit a task instance
//	POST /internal/run                  execute a task posted by a peer node
//	GET  /agents                        list agent scheduling state
//	GET  /cluster                       cluster status snapshot (with node health in multi-node mode)
//	GET  /healthz                       liveness probe
//	GET  /metrics                       Prometheus metrics
func NewHandler(c *Cluster) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /task-defs", c.handlePutTaskDef)
	mux.HandleFunc("GET /task-defs", c.handleListTaskDefs)
	mux.HandleFunc("GET /task-defs/{name}", c.handleGetTaskDef)
	mux.HandleFunc("GET /task-defs/{name}/versions", c.handleTaskDefVersions)
	mux.HandleFunc("POST /task-defs/{name}/rollback", c.handleRollbackTaskDef)
	mux.HandleFunc("POST /tasks", c.handleSubmitTask)
	mux.HandleFunc("POST /internal/run", c.handleInternalRun)
	mux.HandleFunc("GET /agents", c.handleAgents)
	mux.HandleFunc("GET /cluster", c.handleCluster)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("GET /metrics", promhttp.Handler())
	return mux
}

func (c *Cluster) handlePutTaskDef(w http.ResponseWriter, r *http.Request) {
	var def TaskDefinition
	if !decodeJSON(w, r, &def) {
		return
	}
	v, err := c.Store.Put(def)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, v)
}

func (c *Cluster) handleListTaskDefs(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, c.Store.List())
}

func (c *Cluster) handleGetTaskDef(w http.ResponseWriter, r *http.Request) {
	v, err := c.Store.Get(r.PathValue("name"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (c *Cluster) handleTaskDefVersions(w http.ResponseWriter, r *http.Request) {
	vs, err := c.Store.Versions(r.PathValue("name"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

func (c *Cluster) handleRollbackTaskDef(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Version int `json:"version"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	v, err := c.Store.Rollback(r.PathValue("name"), body.Version)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (c *Cluster) handleSubmitTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DefName string            `json:"def_name"`
		Version int               `json:"version,omitempty"`
		Params  map[string]string `json:"params,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	t, res, queued, err := c.SubmitTask(r.Context(), body.DefName, body.Version, body.Params)
	if err != nil {
		writeError(w, err)
		return
	}
	status := http.StatusOK
	if queued {
		status = http.StatusAccepted
	}
	writeJSON(w, status, map[string]any{
		"task":   t,
		"queued": queued,
		"result": res,
	})
}

// handleInternalRun executes a task posted by a peer node's RemoteAgent
// through the local scheduling and execution path. When no local agent has
// capacity it answers 503 so the peer's retry layer can try again later.
func (c *Cluster) handleInternalRun(w http.ResponseWriter, r *http.Request) {
	var t Task
	if !decodeJSON(w, r, &t) {
		return
	}
	res, queued, err := c.RunTask(r.Context(), t)
	if err != nil {
		writeError(w, err)
		return
	}
	if queued {
		http.Error(w, "no local agent capacity", http.StatusServiceUnavailable)
		return
	}
	if c.Metrics != nil {
		c.Metrics.RemoteRuns.Inc()
	}
	writeJSON(w, http.StatusOK, res)
}

func (c *Cluster) handleAgents(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, c.Scheduler.Agents())
}

func (c *Cluster) handleCluster(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, c.Status())
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, ErrTaskDefNotFound), errors.Is(err, ErrVersionNotFound):
		status = http.StatusNotFound
	case errors.Is(err, ErrInvalidTaskDef):
		status = http.StatusBadRequest
	}
	http.Error(w, err.Error(), status)
}
