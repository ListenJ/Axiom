package modelclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func writeChatOK(w http.ResponseWriter) {
	_ = json.NewEncoder(w).Encode(ChatResponse{
		Choices: []Choice{{Index: 0, Message: Message{Role: "assistant", Content: "ok"}}},
	})
}

// TestMaxConcurrentBounded proves Chat calls are capped by Config.MaxConcurrent.
func TestMaxConcurrentBounded(t *testing.T) {
	var inflight, maxInflight atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inflight.Add(1)
		for {
			m := maxInflight.Load()
			if cur <= m || maxInflight.CompareAndSwap(m, cur) {
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
		inflight.Add(-1)
		writeChatOK(w)
	}))
	defer srv.Close()

	c := NewClient(Config{
		Endpoints:      []string{srv.URL},
		HealthInterval: time.Hour,
		MaxConcurrent:  4,
	}, nil)
	defer c.Close()

	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.Chat(context.Background(), ChatRequest{
				Model:    "m",
				Messages: []Message{{Role: "user", Content: "hi"}},
			})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("chat: %v", err)
		}
	}
	if got := maxInflight.Load(); got > 4 {
		t.Fatalf("max inflight %d exceeds MaxConcurrent 4", got)
	}
}

// TestHealthProbeSingleFlight proves overlapping probeAll calls do not
// stampede the endpoint (at most one probe cycle in flight).
func TestHealthProbeSingleFlight(t *testing.T) {
	var inflight, maxInflight atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inflight.Add(1)
		for {
			m := maxInflight.Load()
			if cur <= m || maxInflight.CompareAndSwap(m, cur) {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
		inflight.Add(-1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient(Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour}, nil)
	defer c.Close()

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.probeAll()
		}()
	}
	wg.Wait()
	if got := maxInflight.Load(); got > 1 {
		t.Fatalf("overlapping health probes: max=%d, want <= 1", got)
	}
}
