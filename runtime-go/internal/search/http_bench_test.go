package search

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// BenchmarkHTTPSearchSimple measures the full HTTP path (serve + parse +
// search + metrics + encode) the way loadgen drives it, to find where the
// HTTP end-to-end overhead sits relative to the in-process search cost.
func BenchmarkHTTPSearchSimple(b *testing.B) {
	e := NewEngine(nil, 16)
	if err := e.Build(context.Background(), genDocs(benchDatasetDocs)); err != nil {
		b.Fatalf("build: %v", err)
	}
	srv := httptest.NewServer(e.HTTPHandler())
	defer srv.Close()

	queries := []string{"w0042", "w0007", "w1999", "w3000"}
	client := &http.Client{}
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			url := fmt.Sprintf("%s/search?q=%s&limit=15", srv.URL, queries[i%len(queries)])
			i++
			resp, err := client.Get(url)
			if err != nil {
				b.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	})
}
