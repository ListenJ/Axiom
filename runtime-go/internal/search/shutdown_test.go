package search

import (
	"runtime"
	"testing"
	"time"
)

// TestEngineCloseStopsWorkers verifies Engine.Close stops the fixed worker
// pool goroutines (Step 7 graceful shutdown).
func TestEngineCloseStopsWorkers(t *testing.T) {
	before := runtime.NumGoroutine()
	for i := 0; i < 20; i++ {
		e := NewEngine(nil, 4)
		e.Close()
	}
	runtime.GC()
	time.Sleep(20 * time.Millisecond)
	after := runtime.NumGoroutine()
	if after > before+4 {
		t.Fatalf("engine worker leak: before=%d after=%d", before, after)
	}
}
