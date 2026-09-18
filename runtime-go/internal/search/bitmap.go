package search

import "math/bits"

// bitmap is a fixed-capacity bit set over document numbers, used as the
// intermediate representation of query evaluation inside a shard. All
// logical ops are word-parallel and allocation-free after construction.
type bitmap struct {
	w []uint64
}

// newBitmap returns a bitmap able to hold bits [0, n).
func newBitmap(n int) *bitmap {
	return &bitmap{w: make([]uint64, (n+63)/64)}
}

// clone returns a copy of b sharing no backing memory.
func (b *bitmap) clone() *bitmap {
	w := make([]uint64, len(b.w))
	copy(w, b.w)
	return &bitmap{w: w}
}

// set marks bit i, growing the backing store if needed. Callers must own
// the bitmap (fresh or cloned); shared bitmaps are never grown in place.
func (b *bitmap) set(i uint32) {
	if w := int(i / 64); w >= len(b.w) {
		b.w = append(b.w, make([]uint64, w-len(b.w)+1)...)
	}
	b.w[i/64] |= 1 << (i % 64)
}

// clear unmarks bit i.
func (b *bitmap) clear(i uint32) {
	if int(i/64) < len(b.w) {
		b.w[i/64] &^= 1 << (i % 64)
	}
}

// and intersects b with o in place, truncating to the smaller width.
func (b *bitmap) and(o *bitmap) {
	n := min(len(b.w), len(o.w))
	for i := 0; i < n; i++ {
		b.w[i] &= o.w[i]
	}
	for i := n; i < len(b.w); i++ {
		b.w[i] = 0
	}
}

// or unions b with o in place.
func (b *bitmap) or(o *bitmap) {
	n := min(len(b.w), len(o.w))
	for i := 0; i < n; i++ {
		b.w[i] |= o.w[i]
	}
}

// andNot removes the bits of o from b in place.
func (b *bitmap) andNot(o *bitmap) {
	n := min(len(b.w), len(o.w))
	for i := 0; i < n; i++ {
		b.w[i] &^= o.w[i]
	}
}

// isZero reports whether no bit is set.
func (b *bitmap) isZero() bool {
	for _, w := range b.w {
		if w != 0 {
			return false
		}
	}
	return true
}

// has reports whether bit i is set.
func (b *bitmap) has(i uint32) bool {
	w := int(i / 64)
	return w < len(b.w) && b.w[w]&(1<<(i%64)) != 0
}

// count returns the number of set bits.
func (b *bitmap) count() int {
	n := 0
	for _, w := range b.w {
		n += bits.OnesCount64(w)
	}
	return n
}

// bitmapArena hands out bitmaps backed by reusable word slices, so query
// evaluation does not allocate a fresh backing array for every intermediate
// result. All bitmaps obtained from an arena become invalid on reset; an
// arena serves a single goroutine at a time.
type bitmapArena struct {
	bufs [][]uint64
	used int
}

// reset makes every previously handed-out bitmap available for reuse.
func (a *bitmapArena) reset() { a.used = 0 }

// words returns a zeroed word slice of length n, reusing arena buffers.
func (a *bitmapArena) words(n int) []uint64 {
	if a.used < len(a.bufs) && cap(a.bufs[a.used]) >= n {
		w := a.bufs[a.used][:n]
		clear(w)
		a.used++
		return w
	}
	w := make([]uint64, n)
	if a.used < len(a.bufs) {
		a.bufs[a.used] = w
	} else {
		a.bufs = append(a.bufs, w)
	}
	a.used++
	return w
}

// new returns a zeroed bitmap able to hold bits [0, n).
func (a *bitmapArena) new(n int) *bitmap {
	return &bitmap{w: a.words((n + 63) / 64)}
}

// cloneOf returns an arena-owned copy of b.
func (a *bitmapArena) cloneOf(b *bitmap) *bitmap {
	w := a.words(len(b.w))
	copy(w, b.w)
	return &bitmap{w: w}
}
