package distrib

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"runtime-go/internal/observability"
)

type echoIn struct {
	Msg string `json:"msg"`
}

type echoOut struct {
	Reply string `json:"reply"`
}

func TestDoJSON_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("expected application/json, got %q", ct)
		}
		body, _ := io.ReadAll(r.Body)
		var in echoIn
		if err := json.Unmarshal(body, &in); err != nil {
			t.Errorf("bad request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(echoOut{Reply: "echo:" + in.Msg})
	}))
	defer srv.Close()

	var out echoOut
	err := DoJSON(context.Background(), srv.Client(), http.MethodPost, srv.URL, echoIn{Msg: "hi"}, &out)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Reply != "echo:hi" {
		t.Fatalf("unexpected reply: %q", out.Reply)
	}
}

func TestDoJSON_NilInAndOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	if err := DoJSON(context.Background(), srv.Client(), http.MethodGet, srv.URL, nil, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDoJSON_4xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
	}))
	defer srv.Close()

	err := DoJSON(context.Background(), srv.Client(), http.MethodGet, srv.URL, nil, nil)
	assertRPCError(t, err, "400")
	var ae *observability.AppError
	_ = errors.As(err, &ae)
	if !strings.Contains(ae.Message, "bad request") {
		t.Fatalf("response body not included in error: %q", ae.Message)
	}
}

func TestDoJSON_5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	err := DoJSON(context.Background(), srv.Client(), http.MethodGet, srv.URL, nil, nil)
	assertRPCError(t, err, "500")
}

func TestDoJSON_ContextTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := DoJSON(ctx, srv.Client(), http.MethodGet, srv.URL, nil, nil)
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("DoJSON did not respect context deadline")
	}
	assertRPCError(t, err, "")
}

func TestDoJSON_TransportError(t *testing.T) {
	err := DoJSON(context.Background(), http.DefaultClient, http.MethodGet, "http://127.0.0.1:1", nil, nil)
	assertRPCError(t, err, "")
}

func TestDefaultClient_HasTimeout(t *testing.T) {
	c := DefaultClient(3 * time.Second)
	if c.Timeout != 3*time.Second {
		t.Fatalf("expected timeout 3s, got %v", c.Timeout)
	}
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", c.Transport)
	}
	if tr.MaxIdleConns == 0 || tr.MaxIdleConnsPerHost == 0 {
		t.Fatal("expected a configured connection pool")
	}
}

func assertRPCError(t *testing.T, err error, wantStatus string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var ae *observability.AppError
	if !errors.As(err, &ae) {
		t.Fatalf("expected AppError, got %T: %v", err, err)
	}
	if ae.Code != ErrCodeRPC {
		t.Fatalf("expected code %q, got %q", ErrCodeRPC, ae.Code)
	}
	if wantStatus != "" && ae.Context["status"] != wantStatus {
		t.Fatalf("expected status context %q, got %v", wantStatus, ae.Context)
	}
}
