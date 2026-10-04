package modelclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func benchChatServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(ChatResponse{
			ID: "bench", Object: "chat.completion", Model: "bench",
			Choices: []Choice{{Index: 0, Message: Message{Role: "assistant", Content: "ok"}, FinishReason: "stop"}},
			Usage:   Usage{PromptTokens: 1, CompletionTokens: 1, TotalTokens: 2},
		})
	}))
}

// BenchmarkChatConcurrent measures bounded-concurrency Chat throughput.
func BenchmarkChatConcurrent(b *testing.B) {
	srv := benchChatServer()
	defer srv.Close()
	c := NewClient(Config{
		Endpoints:      []string{srv.URL},
		HealthInterval: time.Hour,
		MaxConcurrent:  64,
	}, nil)
	defer c.Close()
	req := ChatRequest{Model: "bench", Messages: []Message{{Role: "user", Content: "hi"}}}
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := c.Chat(context.Background(), req); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// BenchmarkProbeAllSingleFlight measures probes actually issued per probeAll
// call under concurrent invocation (single-flight should keep it well below 1).
func BenchmarkProbeAllSingleFlight(b *testing.B) {
	var probes atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probes.Add(1)
		time.Sleep(time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := NewClient(Config{Endpoints: []string{srv.URL}, HealthInterval: time.Hour}, nil)
	defer c.Close()
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			c.probeAll()
		}
	})
	b.StopTimer()
	b.ReportMetric(float64(probes.Load())/float64(b.N), "probes/op")
}
