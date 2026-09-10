package pcda

import (
	"encoding/json"
	"io"
	"net/http"
)

// NewTxHandler exposes p over the participant side of the cross-machine
// 2PC protocol:
//
//	POST /tx/prepare   vote on a transition (body: Transition JSON)
//	POST /tx/commit    apply a prepared transition
//	POST /tx/abort     roll back a prepared transition
//
// Each endpoint decodes the Transition, invokes the corresponding
// Participant method, and answers 200 {"status":"ok"} on success; a
// participant error (e.g. a NO vote) is returned as 500 with the error
// text, which RemoteParticipant surfaces as a phase failure.
//
// In a two-node deployment the participant is typically a
// MemoryParticipant holding per-cycle stage state for this process.
func NewTxHandler(p Participant) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /tx/prepare", txPhaseHandler(p.Prepare))
	mux.HandleFunc("POST /tx/commit", txPhaseHandler(p.Commit))
	mux.HandleFunc("POST /tx/abort", txPhaseHandler(p.Abort))
	return mux
}

func txPhaseHandler(op func(Transition) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var tx Transition
		if err := json.NewDecoder(r.Body).Decode(&tx); err != nil {
			http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := op(tx); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	}
}
