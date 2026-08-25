package search

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestQueryBinReqRoundTrip(t *testing.T) {
	req := internalQueryRequest{Shards: []int{0, 3, 7, 31}, Query: "中文 query ✓", Limit: 42}
	body := appendQueryBinReq(nil, req.Query, req.Shards, req.Limit)
	got, err := decodeQueryBinReq(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if got.Query != req.Query || got.Limit != req.Limit || len(got.Shards) != 4 {
		t.Fatalf("got %+v", got)
	}
	for i := range req.Shards {
		if got.Shards[i] != req.Shards[i] {
			t.Fatalf("shard[%d]=%d want %d", i, got.Shards[i], req.Shards[i])
		}
	}
}

func TestQueryBinRespRoundTrip(t *testing.T) {
	hits := []Hit{
		{ID: "doc-中文-✓", Score: 12.5, Title: "标题"},
		{ID: "", Score: 0, Title: ""},
		{ID: strings.Repeat("x", 300), Score: -1.25e-9, Title: strings.Repeat("长", 200)},
	}
	body := appendQueryBinResp(nil, hits)
	got, err := decodeQueryBinResp(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(hits) {
		t.Fatalf("n=%d want %d", len(got), len(hits))
	}
	for i := range hits {
		if got[i] != hits[i] {
			t.Fatalf("[%d] got %+v want %+v", i, got[i], hits[i])
		}
	}
}

func TestSniffBinaryResponse(t *testing.T) {
	h := http.Header{}
	h.Set("Content-Type", queryBinContentType)
	if !sniffBinaryResponse(h) {
		t.Fatal("binary content type not sniffed")
	}
	j := http.Header{}
	j.Set("Content-Type", "application/json; charset=utf-8")
	if sniffBinaryResponse(j) {
		t.Fatal("json misdetected as binary")
	}
}

// 压缩率与编解码吞吐对照：二进制应显著小于 JSON（键名消除）。
func BenchmarkQueryBinVsJSON(b *testing.B) {
	rng := rand.New(rand.NewSource(42))
	hits := make([]Hit, 1000)
	for i := range hits {
		hits[i] = Hit{ID: fmt.Sprintf("doc-%06d", i), Score: rng.Float64() * 100, Title: "标题 title-" + strconv.Itoa(i)}
	}
	b.Run("json", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			jb, _ := json.Marshal(internalQueryResponse{Hits: hits})
			var out internalQueryResponse
			_ = json.Unmarshal(jb, &out)
		}
	})
	b.Run("bin", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			bb := appendQueryBinResp(nil, hits)
			if _, err := decodeQueryBinResp(bytes.NewReader(bb)); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("json-size", func(b *testing.B) {
		jb, _ := json.Marshal(internalQueryResponse{Hits: hits})
		b.Log("json bytes:", len(jb))
	})
	b.Run("bin-size", func(b *testing.B) {
		bb := appendQueryBinResp(nil, hits)
		b.Log("bin bytes:", len(bb))
	})
}
