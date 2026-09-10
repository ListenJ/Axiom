package search

import (
	"context"
	"runtime"
	"sort"
	"testing"
	"time"
)

// BenchmarkBuildIndex measures parallel index build throughput at 10k, 20k
// and 40k documents (16 shards, NumCPU workers) to demonstrate build time
// scales ~linearly with corpus size. docs/sec is reported as a custom
// metric.
func BenchmarkBuildIndex(b *testing.B) {
	for _, n := range []int{10_000, 20_000, 40_000} {
		docs := genDocs(n)
		b.Run(itoa(n), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				BuildIndex(docs, 16, runtime.NumCPU())
			}
			b.StopTimer()
			b.ReportMetric(float64(n)*float64(b.N)/b.Elapsed().Seconds(), "docs/sec")
		})
	}
}

func itoa(n int) string {
	switch n {
	case 10_000:
		return "10000"
	case 20_000:
		return "20000"
	default:
		return "40000"
	}
}

// benchDatasetDocs is the corpus size used by the query benchmarks and the
// p95 latency test below.
const benchDatasetDocs = 100_000

// benchEngine builds a 100k-document engine (16 shards) once for query
// benchmarks.
func benchEngine(b *testing.B) *Engine {
	b.Helper()
	e := NewEngine(nil, 16)
	if err := e.Build(context.Background(), genDocs(benchDatasetDocs)); err != nil {
		b.Fatalf("build: %v", err)
	}
	return e
}

// BenchmarkSearchSimple measures single-term query latency on 100k docs;
// ns/op converts directly to QPS per goroutine.
func BenchmarkSearchSimple(b *testing.B) {
	e := benchEngine(b)
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := e.Search(ctx, "w0042", 10); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkSearchComplex measures a complex combined query (AND + OR + NOT
// + field + prefix) on 100k docs.
func BenchmarkSearchComplex(b *testing.B) {
	e := benchEngine(b)
	ctx := context.Background()
	const q = "w0042 w1999 OR w0007 -w3000 cat:c3 w05*"
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := e.Search(ctx, q, 10); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkSearchSimpleParallel measures simple-query throughput under
// concurrent load (b.RunParallel); QPS = 1e9 / ns-per-op across all P.
func BenchmarkSearchSimpleParallel(b *testing.B) {
	e := benchEngine(b)
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := e.Search(ctx, "w0042", 10); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// BenchmarkSearchComplexParallel measures complex combined query throughput
// under concurrent load (b.RunParallel).
func BenchmarkSearchComplexParallel(b *testing.B) {
	e := benchEngine(b)
	ctx := context.Background()
	const q = "w0042 w1999 OR w0007 -w3000 cat:c3 w05*"
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := e.Search(ctx, q, 10); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// TestComplexQueryP95 asserts the p95 latency of a complex combined query
// over a 100k-document corpus stays below 100ms, and logs the achieved
// single-goroutine QPS.
func TestComplexQueryP95(t *testing.T) {
	e := NewEngine(newTestRegistry(t), 16)
	mustBuild(t, e, genDocs(benchDatasetDocs))
	ctx := context.Background()
	const q = "w0042 w1999 OR w0007 -w3000 cat:c3 w05*"
	const runs = 200

	durs := make([]time.Duration, 0, runs)
	for i := 0; i < runs; i++ {
		start := time.Now()
		if _, err := e.Search(ctx, q, 10); err != nil {
			t.Fatalf("search: %v", err)
		}
		durs = append(durs, time.Since(start))
	}
	sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
	p95 := durs[runs*95/100-1]
	var total time.Duration
	for _, d := range durs {
		total += d
	}
	qps := float64(runs) / total.Seconds()
	t.Logf("complex query on %d docs: p50=%v p95=%v max=%v qps=%.0f",
		benchDatasetDocs, durs[runs/2], p95, durs[runs-1], qps)
	if p95 > 100*time.Millisecond {
		t.Fatalf("p95 = %v, exceeds 100ms", p95)
	}
}
