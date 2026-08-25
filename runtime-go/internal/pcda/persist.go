package pcda

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"runtime-go/internal/observability"
)

// walOp identifies the mutation kind of a WAL record.
const (
	walOpSubmit     = "submit"
	walOpTransition = "transition"
	walOpTerminal   = "terminal"
)

const (
	walFileName      = "pcda-wal.log"
	snapshotFileName = "pcda-snapshot.json"
)

// walRecord is one appended mutation. It carries the full cycle state so
// replay is a simple last-write-wins upsert per cycle.
type walRecord struct {
	Seq   uint64 `json:"seq"`
	Op    string `json:"op"`
	Cycle *Cycle `json:"cycle"`
}

// wal is an append-only write-ahead log. Appends are serialized and flushed
// to the OS immediately; fsync happens on Sync (periodic + shutdown), which
// bounds the crash-loss window to the sync interval, not to every operation.
type wal struct {
	mu  sync.Mutex
	f   *os.File
	buf *bufio.Writer
	enc *json.Encoder
	seq uint64
	dir string
}

// openWAL opens (creating if needed) the WAL file in dir for appending.
// The file is opened read-write (not O_APPEND) so it can be truncated after
// a snapshot; the single-writer design keeps the write offset at EOF.
func openWAL(dir string) (*wal, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, walFileName), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		_ = f.Close()
		return nil, err
	}
	buf := bufio.NewWriterSize(f, 64*1024)
	return &wal{f: f, buf: buf, enc: json.NewEncoder(buf), dir: dir}, nil
}

// Append writes one record and returns its sequence number.
func (w *wal) Append(op string, c *Cycle) (uint64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.seq++
	rec := walRecord{Seq: w.seq, Op: op, Cycle: c}
	if err := w.enc.Encode(&rec); err != nil {
		return 0, err
	}
	return w.seq, w.buf.Flush()
}

// Seq returns the last assigned sequence number.
func (w *wal) Seq() uint64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.seq
}

// setSeq fast-forwards the sequence counter after recovery.
func (w *wal) setSeq(seq uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if seq > w.seq {
		w.seq = seq
	}
}

// Sync flushes buffered data and fsyncs the file.
func (w *wal) Sync() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.buf.Flush(); err != nil {
		return err
	}
	return w.f.Sync()
}

// TruncateIfUnchanged resets the WAL to empty when no records were appended
// after expectSeq (i.e. the snapshot at expectSeq covers everything).
func (w *wal) TruncateIfUnchanged(expectSeq uint64) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.seq != expectSeq {
		return nil // new records arrived; keep the log
	}
	if err := w.buf.Flush(); err != nil {
		return err
	}
	if err := w.f.Truncate(0); err != nil {
		return err
	}
	if _, err := w.f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	w.buf.Reset(w.f)
	w.enc = json.NewEncoder(w.buf)
	return nil
}

// Close syncs and closes the WAL.
func (w *wal) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.buf.Flush(); err != nil {
		_ = w.f.Close()
		return err
	}
	return w.f.Close()
}

// replayWAL reads records with Seq > afterSeq in order, invoking apply for
// each. It returns the maximum sequence number seen in the file.
func replayWAL(dir string, afterSeq uint64, apply func(op string, c *Cycle)) (uint64, error) {
	f, err := os.Open(filepath.Join(dir, walFileName))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()

	var maxSeq uint64
	dec := json.NewDecoder(bufio.NewReader(f))
	for {
		var rec walRecord
		err := dec.Decode(&rec)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// A torn tail write after a crash is expected: stop replay at
			// the last complete record instead of failing recovery.
			break
		}
		if rec.Seq > maxSeq {
			maxSeq = rec.Seq
		}
		if rec.Seq <= afterSeq || rec.Cycle == nil {
			continue
		}
		apply(rec.Op, rec.Cycle)
	}
	return maxSeq, nil
}

// snapshot is the full serialized engine state at a WAL sequence boundary.
type snapshot struct {
	LastSeq uint64   `json:"last_seq"`
	Cycles  []*Cycle `json:"cycles"`
}

// writeSnapshot atomically writes snap to dir (temp file + rename).
func writeSnapshot(dir string, snap *snapshot) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, snapshotFileName+".tmp")
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, snapshotFileName))
}

// readSnapshot loads the snapshot from dir; a missing snapshot is not an
// error and returns nil, nil.
func readSnapshot(dir string) (*snapshot, error) {
	data, err := os.ReadFile(filepath.Join(dir, snapshotFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snap snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

// Snapshot serializes the full engine state to DataDir and truncates the
// WAL when it contains no records beyond the snapshot boundary. It is a
// no-op when persistence is disabled.
func (e *Engine) Snapshot() error {
	if e.wal == nil {
		return nil
	}
	snap := &snapshot{LastSeq: e.wal.Seq()}
	e.cycles.Range(func(_, v any) bool {
		st := v.(*cycleState)
		st.mu.RLock()
		snap.Cycles = append(snap.Cycles, cloneCycle(&st.snap))
		st.mu.RUnlock()
		return true
	})
	if err := writeSnapshot(e.dataDir, snap); err != nil {
		return observability.WrapError(ErrCodePersist, "write snapshot", err)
	}
	if err := e.wal.TruncateIfUnchanged(snap.LastSeq); err != nil {
		return observability.WrapError(ErrCodePersist, "truncate WAL", err)
	}
	return nil
}

// Recover rebuilds engine state from the latest snapshot plus WAL replay.
// In-flight cycles are restored to the cycles registry and stage table;
// Start re-enqueues them at their recorded stage. Recovery is idempotent
// and may be called on a fresh engine only.
func (e *Engine) Recover() error {
	if e.dataDir == "" {
		return nil
	}
	snap, err := readSnapshot(e.dataDir)
	if err != nil {
		return observability.WrapError(ErrCodePersist, "read snapshot", err)
	}
	var afterSeq uint64
	if snap != nil {
		afterSeq = snap.LastSeq
		for _, c := range snap.Cycles {
			e.restoreCycle(c)
		}
	}
	maxSeq, err := replayWAL(e.dataDir, afterSeq, func(op string, c *Cycle) {
		e.restoreCycle(c)
	})
	if err != nil {
		return observability.WrapError(ErrCodePersist, "replay WAL", err)
	}
	if maxSeq > afterSeq {
		afterSeq = maxSeq
	}
	e.wal.setSeq(afterSeq)
	e.metrics.recoveries.Inc()
	return nil
}

// restoreCycle upserts one recovered cycle into the registry and the 2PC
// stage table.
func (e *Engine) restoreCycle(c *Cycle) {
	st := &cycleState{snap: *cloneCycle(c)}
	e.cycles.Store(c.ID, st)
	e.store.Seed(c.ID, c.Stage)
}

// snapshotLoop writes periodic snapshots until the engine context ends.
func (e *Engine) snapshotLoop(interval time.Duration) {
	defer e.wg.Done()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-t.C:
			if err := e.Snapshot(); err != nil {
				log.Printf("pcda.persist.snapshot_failed: %v", err)
			}
		}
	}
}

// walSyncLoop fsyncs the WAL once per second to bound the crash-loss window.
func (e *Engine) walSyncLoop() {
	defer e.wg.Done()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-t.C:
			if err := e.wal.Sync(); err != nil {
				log.Printf("pcda.persist.wal_sync_failed: %v", err)
			}
		}
	}
}
