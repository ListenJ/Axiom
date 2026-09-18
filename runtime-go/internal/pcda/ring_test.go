package pcda

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestRingEnqueueDequeueFIFO(t *testing.T) {
	q := newRing(4)
	for i := 0; i < 4; i++ {
		if !q.Enqueue(i) {
			t.Fatalf("enqueue %d failed on non-full ring", i)
		}
	}
	if q.Enqueue(99) {
		t.Fatal("enqueue on full ring must fail")
	}
	for i := 0; i < 4; i++ {
		v, ok := q.Dequeue()
		if !ok || v.(int) != i {
			t.Fatalf("dequeue %d: got %v ok=%v", i, v, ok)
		}
	}
	if _, ok := q.Dequeue(); ok {
		t.Fatal("dequeue on empty ring must fail")
	}
}

func TestRingWrapAround(t *testing.T) {
	q := newRing(4)
	for round := 0; round < 100; round++ {
		for i := 0; i < 3; i++ {
			if !q.Enqueue(round*10 + i) {
				t.Fatalf("round %d enqueue %d failed", round, i)
			}
		}
		for i := 0; i < 3; i++ {
			v, ok := q.Dequeue()
			if !ok || v.(int) != round*10+i {
				t.Fatalf("round %d dequeue %d: got %v ok=%v", round, i, v, ok)
			}
		}
	}
}

func TestRingLen(t *testing.T) {
	q := newRing(8)
	if q.Len() != 0 {
		t.Fatalf("empty ring len = %d", q.Len())
	}
	q.Enqueue(1)
	q.Enqueue(2)
	if q.Len() != 2 {
		t.Fatalf("len after 2 enqueues = %d", q.Len())
	}
	q.Dequeue()
	if q.Len() != 1 {
		t.Fatalf("len after dequeue = %d", q.Len())
	}
}

func TestRingConcurrentMPMC(t *testing.T) {
	const (
		producers  = 8
		consumers  = 8
		perProduce = 5000
	)
	total := producers * perProduce
	q := newRing(1024)
	seen := make([]int64, total)
	var consumed atomic.Int64

	var wg sync.WaitGroup
	for p := 0; p < producers; p++ {
		wg.Add(1)
		go func(base int) {
			defer wg.Done()
			for i := 0; i < perProduce; i++ {
				v := base*perProduce + i
				for !q.Enqueue(v) {
				}
			}
		}(p)
	}
	for c := 0; c < consumers; c++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for consumed.Load() < int64(total) {
				v, ok := q.Dequeue()
				if !ok {
					continue
				}
				seen[v.(int)]++
				consumed.Add(1)
			}
		}()
	}
	wg.Wait()

	for i, n := range seen {
		if n != 1 {
			t.Fatalf("item %d consumed %d times", i, n)
		}
	}
}
