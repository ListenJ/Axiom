package pcda

import (
	"context"
	"strconv"
	"testing"
	"time"
)

// BenchmarkEngineThroughput measures end-to-end engine throughput: cycles
// are submitted at StagePlan and flow through all four stages (pass-through
// handlers) until completion. It reports cycles/sec as a custom metric.
func BenchmarkEngineThroughput(b *testing.B) {
	cfg := Config{
		WorkersPerStage: 8,
		BatchSize:       64,
		BatchWait:       200 * time.Microsecond,
		QueueCapacity:   65536,
		MaxRetries:      0,
	}
	e := NewEngine(cfg, nil)
	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		b.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	b.ResetTimer()
	start := time.Now()
	for i := 0; i < b.N; i++ {
		c := AcquireCycle()
		c.ID = strconv.Itoa(i)
		for {
			if err := e.Submit(c); err == nil {
				break
			}
			// Backpressure: queue saturated, wait for drain.
			time.Sleep(10 * time.Microsecond)
		}
	}
	for e.Stats().InFlight > 0 {
		time.Sleep(100 * time.Microsecond)
	}
	elapsed := time.Since(start)
	b.StopTimer()
	b.ReportMetric(float64(b.N)/elapsed.Seconds(), "cycles/sec")
}

// BenchmarkRingMPMC measures raw lock-free ring throughput with paired
// producers and consumers.
func BenchmarkRingMPMC(b *testing.B) {
	q := newRing(4096)
	b.SetParallelism(4)
	b.ResetTimer()
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
				q.Dequeue()
			}
		}
	}()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			for !q.Enqueue(struct{}{}) {
			}
		}
	})
	close(done)
}

// BenchmarkLaneQueueDequeue measures priority-lane dequeue cost.
func BenchmarkLaneQueueDequeue(b *testing.B) {
	q := newLaneQueue(65536)
	c := &Cycle{ID: "x", Priority: PriorityNormal}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for !q.Enqueue(c) {
			q.Dequeue()
		}
		q.Dequeue()
	}
}

// BenchmarkTwoPC measures coordinator commit cost with one in-memory
// participant.
func BenchmarkTwoPC(b *testing.B) {
	coord := NewCoordinator()
	p := NewMemoryParticipant()
	p.Seed("c", StagePlan)
	tx := Transition{CycleID: "c", From: StagePlan, To: StageDo}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := coord.Run(tx, p); err != nil {
			b.Fatalf("run: %v", err)
		}
		tx.From, tx.To = tx.To, tx.From
	}
}
