package pcda

import (
	"sync/atomic"
)

// ringCell is one slot of the ring buffer. The sequence number implements the
// Vyukov bounded MPMC protocol: a cell is writable when seq == pos and
// readable when seq == pos+1.
type ringCell struct {
	seq atomic.Uint64
	val any
}

// ring is a bounded lock-free MPMC queue backed by a ring buffer. Producers
// and consumers claim slots with CAS; there are no locks on the data path.
//
// Enqueue fails fast (returns false) when the ring is full instead of
// blocking, so callers decide whether to spin, drop, or apply backpressure.
type ring struct {
	cells []ringCell
	mask  uint64
	head  atomic.Uint64 // next dequeue position
	tail  atomic.Uint64 // next enqueue position
}

// newRing creates a ring with at least capacity slots. The capacity is
// rounded up to the next power of two so indexing can use a bitmask.
func newRing(capacity int) *ring {
	n := 1
	for n < capacity {
		n <<= 1
	}
	r := &ring{cells: make([]ringCell, n), mask: uint64(n - 1)}
	for i := range r.cells {
		r.cells[i].seq.Store(uint64(i))
	}
	return r
}

// Enqueue inserts v. It reports false when the ring is full.
func (r *ring) Enqueue(v any) bool {
	for {
		pos := r.tail.Load()
		cell := &r.cells[pos&r.mask]
		seq := cell.seq.Load()
		switch dif := int64(seq) - int64(pos); {
		case dif == 0:
			// Cell is free; try to claim this position.
			if r.tail.CompareAndSwap(pos, pos+1) {
				cell.val = v
				cell.seq.Store(pos + 1) // publish
				return true
			}
		case dif < 0:
			return false // full
		default:
			// Another producer claimed pos first; reload and retry.
		}
	}
}

// Dequeue removes and returns the oldest value. It reports false when the
// ring is empty.
func (r *ring) Dequeue() (any, bool) {
	for {
		pos := r.head.Load()
		cell := &r.cells[pos&r.mask]
		seq := cell.seq.Load()
		switch dif := int64(seq) - int64(pos+1); {
		case dif == 0:
			// Cell is ready; try to claim this position.
			if r.head.CompareAndSwap(pos, pos+1) {
				v := cell.val
				cell.val = nil
				cell.seq.Store(pos + r.mask + 1) // free for reuse
				return v, true
			}
		case dif < 0:
			return nil, false // empty
		default:
			// Another consumer claimed pos first; reload and retry.
		}
	}
}

// Len returns the approximate number of queued items. It may briefly
// over- or under-report under concurrency and is meant for metrics and
// scaling decisions, not synchronization.
func (r *ring) Len() int {
	tail := r.tail.Load()
	head := r.head.Load()
	if tail < head {
		return 0
	}
	n := tail - head
	if n > uint64(len(r.cells)) {
		return len(r.cells)
	}
	return int(n)
}

// Cap returns the ring capacity in slots.
func (r *ring) Cap() int { return len(r.cells) }
