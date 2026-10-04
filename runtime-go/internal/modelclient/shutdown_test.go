package modelclient

import (
	"runtime"
	"testing"
	"time"
)

// TestClientCloseIdempotent verifies repeated Close calls do not panic.
func TestClientCloseIdempotent(t *testing.T) {
	c := NewClient(Config{Endpoints: []string{"http://127.0.0.1:1"}, HealthInterval: time.Hour}, nil)
	c.Close()
	c.Close()
}

// TestClientCloseStopsHealthLoop verifies the health-loop goroutine exits on
// Close (Step 7 graceful shutdown).
func TestClientCloseStopsHealthLoop(t *testing.T) {
	before := runtime.NumGoroutine()
	for i := 0; i < 20; i++ {
		c := NewClient(Config{Endpoints: []string{"http://127.0.0.1:1"}, HealthInterval: time.Hour}, nil)
		c.Close()
	}
	runtime.GC()
	time.Sleep(20 * time.Millisecond)
	after := runtime.NumGoroutine()
	if after > before+4 {
		t.Fatalf("client health-loop leak: before=%d after=%d", before, after)
	}
}
