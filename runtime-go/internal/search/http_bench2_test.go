package search

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func benchHTTPWithReg(b *testing.B, reg prometheus.Registerer) {
	e := NewEngine(reg, 16)
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

func BenchmarkHTTPSearchSimpleReg(b *testing.B) {
	benchHTTPWithReg(b, prometheus.NewRegistry())
}
