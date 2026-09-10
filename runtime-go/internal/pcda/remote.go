package pcda

import (
	"context"
	"net/http"
	"time"

	"runtime-go/internal/distrib"
)

// DefaultRemoteParticipantTimeout is the default per-phase timeout for
// RemoteParticipant RPCs.
const DefaultRemoteParticipantTimeout = 5 * time.Second

// RemoteParticipant is a Participant proxying a pcdad instance on another
// node: Prepare, Commit and Abort are forwarded to the peer's
// POST {addr}/tx/prepare|/tx/commit|/tx/abort endpoints with the
// Transition as JSON body. A non-2xx reply is a NO vote / phase failure,
// so the coordinator's abort logic applies unchanged across machines.
type RemoteParticipant struct {
	addr   string
	client *http.Client
}

// NewRemoteParticipant creates a remote participant proxy targeting the
// pcdad instance at addr (a base URL such as "http://${LAN_NODE_N1}:9101").
// A timeout <= 0 uses DefaultRemoteParticipantTimeout.
func NewRemoteParticipant(addr string, timeout time.Duration) *RemoteParticipant {
	if timeout <= 0 {
		timeout = DefaultRemoteParticipantTimeout
	}
	return &RemoteParticipant{addr: addr, client: distrib.DefaultClient(timeout)}
}

// Prepare implements Participant.
func (r *RemoteParticipant) Prepare(tx Transition) error {
	return r.post("/tx/prepare", tx)
}

// Commit implements Participant.
func (r *RemoteParticipant) Commit(tx Transition) error {
	return r.post("/tx/commit", tx)
}

// Abort implements Participant.
func (r *RemoteParticipant) Abort(tx Transition) error {
	return r.post("/tx/abort", tx)
}

func (r *RemoteParticipant) post(path string, tx Transition) error {
	return distrib.DoJSON(context.Background(), r.client, http.MethodPost, r.addr+path, tx, nil)
}
