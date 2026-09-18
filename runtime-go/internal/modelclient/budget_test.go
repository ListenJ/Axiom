package modelclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"runtime-go/internal/observability"
)

// captureServer records the last ChatRequest it received and replies with a
// fixed completion.
func captureServer(t *testing.T, got *ChatRequest) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		okResponse(w, "ok")
	}))
}

func budgetTestConfig(url string) Config {
	return Config{
		Endpoints:            []string{url},
		HealthInterval:       time.Hour,
		ContextWindow:        100,
		ReservedOutputTokens: 10,
	}
}

func TestConfigContextWindowDefault(t *testing.T) {
	t.Setenv("MODEL_CONTEXT_WINDOW", "")
	cfg := Config{}.withDefaults()
	if cfg.ContextWindow != DefaultContextWindow {
		t.Fatalf("ContextWindow = %d, want %d", cfg.ContextWindow, DefaultContextWindow)
	}
	if cfg.ReservedOutputTokens != DefaultReservedOutputTokens {
		t.Fatalf("ReservedOutputTokens = %d, want %d", cfg.ReservedOutputTokens, DefaultReservedOutputTokens)
	}
}

func TestConfigContextWindowFromEnv(t *testing.T) {
	t.Setenv("MODEL_CONTEXT_WINDOW", "32768")
	cfg := Config{}.withDefaults()
	if cfg.ContextWindow != 32768 {
		t.Fatalf("ContextWindow = %d, want 32768", cfg.ContextWindow)
	}
}

func TestConfigContextWindowInvalidEnv(t *testing.T) {
	t.Setenv("MODEL_CONTEXT_WINDOW", "not-a-number")
	cfg := Config{}.withDefaults()
	if cfg.ContextWindow != DefaultContextWindow {
		t.Fatalf("ContextWindow = %d, want %d", cfg.ContextWindow, DefaultContextWindow)
	}
}

func TestClampMaxTokensUnset(t *testing.T) {
	// Prompt "hello" = 6 tokens; budget = 100 - 6 - 10 = 84.
	var got ChatRequest
	srv := captureServer(t, &got)
	defer srv.Close()

	c := newTestClient(t, budgetTestConfig(srv.URL))
	if _, err := c.Chat(context.Background(), sampleRequest()); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if got.MaxTokens != 84 {
		t.Fatalf("max_tokens = %d, want 84", got.MaxTokens)
	}
}

func TestClampMaxTokensOverBudget(t *testing.T) {
	var got ChatRequest
	srv := captureServer(t, &got)
	defer srv.Close()

	c := newTestClient(t, budgetTestConfig(srv.URL))
	req := sampleRequest()
	req.MaxTokens = 1000
	if _, err := c.Chat(context.Background(), req); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if got.MaxTokens != 84 {
		t.Fatalf("max_tokens = %d, want 84 (clamped)", got.MaxTokens)
	}
}

func TestMaxTokensWithinBudgetKept(t *testing.T) {
	var got ChatRequest
	srv := captureServer(t, &got)
	defer srv.Close()

	c := newTestClient(t, budgetTestConfig(srv.URL))
	req := sampleRequest()
	req.MaxTokens = 50
	if _, err := c.Chat(context.Background(), req); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if got.MaxTokens != 50 {
		t.Fatalf("max_tokens = %d, want 50 (untouched)", got.MaxTokens)
	}
}

func TestContextOverflowError(t *testing.T) {
	// 40 ASCII chars -> 10 tokens + 4 overhead = 14; budget = 100? No:
	// window 20, reserve 10 -> budget = 20 - 14 - 10 = -4 < 1.
	srv := captureServer(t, &ChatRequest{})
	defer srv.Close()

	cfg := budgetTestConfig(srv.URL)
	cfg.ContextWindow = 20
	c := newTestClient(t, cfg)
	req := ChatRequest{
		Model:    "test-model",
		Messages: []Message{{Role: "user", Content: strings.Repeat("a", 40)}},
	}
	_, err := c.Chat(context.Background(), req)
	if err == nil {
		t.Fatal("expected overflow error")
	}
	var appErr *observability.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected *AppError, got %T", err)
	}
	if appErr.Code != ErrCodeContextOverflow {
		t.Fatalf("code = %s, want %s", appErr.Code, ErrCodeContextOverflow)
	}
}

func TestPromptTruncationKeepsSystemAndLast(t *testing.T) {
	// window 100, reserve 10 -> prompt must fit in 89 tokens.
	// system "sys" = 5; six middle messages of 40 ASCII chars = 14 each;
	// last "last" = 5. Total 94 > 89; dropping the oldest middle message
	// (14) brings it to 80.
	var got ChatRequest
	srv := captureServer(t, &got)
	defer srv.Close()

	c := newTestClient(t, budgetTestConfig(srv.URL))
	msgs := []Message{{Role: "system", Content: "sys"}}
	for i := 0; i < 6; i++ {
		msgs = append(msgs, Message{Role: "user", Content: strings.Repeat(string(rune('a'+i)), 40)})
	}
	msgs = append(msgs, Message{Role: "user", Content: "last"})
	req := ChatRequest{Model: "test-model", Messages: msgs, MaxTokens: 5}

	if _, err := c.Chat(context.Background(), req); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if len(got.Messages) != 7 { // system + 5 middle + last
		t.Fatalf("messages = %d, want 7", len(got.Messages))
	}
	if got.Messages[0].Role != "system" || got.Messages[0].Content != "sys" {
		t.Fatalf("first message = %+v, want system message kept", got.Messages[0])
	}
	if last := got.Messages[len(got.Messages)-1]; last.Content != "last" {
		t.Fatalf("last message = %q, want %q", last.Content, "last")
	}
	for _, m := range got.Messages {
		if m.Content == strings.Repeat("a", 40) {
			t.Fatal("oldest non-system message should have been dropped")
		}
	}
	// max_tokens still clamped against the truncated prompt: 100-80-10 = 10,
	// but the caller's 5 fits, so it stays.
	if got.MaxTokens != 5 {
		t.Fatalf("max_tokens = %d, want 5", got.MaxTokens)
	}
}

func TestPromptTruncationOverflowWhenUnfittable(t *testing.T) {
	// system message alone exceeds the window: nothing droppable, overflow.
	srv := captureServer(t, &ChatRequest{})
	defer srv.Close()

	cfg := budgetTestConfig(srv.URL)
	cfg.ContextWindow = 20 // limit-1 = 9
	c := newTestClient(t, cfg)
	req := ChatRequest{
		Model: "test-model",
		Messages: []Message{
			{Role: "system", Content: strings.Repeat("s", 40)}, // 14 tokens, kept forever
			{Role: "user", Content: "hi"},
		},
	}
	_, err := c.Chat(context.Background(), req)
	var appErr *observability.AppError
	if !errors.As(err, &appErr) || appErr.Code != ErrCodeContextOverflow {
		t.Fatalf("err = %v, want %s", err, ErrCodeContextOverflow)
	}
}

func TestPromptTruncationCountInErrorContext(t *testing.T) {
	// When truncation happens and the remaining prompt still overflows (here:
	// huge system message plus droppable history), the error context exposes
	// how many messages were dropped.
	srv := captureServer(t, &ChatRequest{})
	defer srv.Close()

	cfg := budgetTestConfig(srv.URL)
	cfg.ContextWindow = 30 // limit-1 = 19
	c := newTestClient(t, cfg)
	req := ChatRequest{
		Model: "test-model",
		Messages: []Message{
			{Role: "system", Content: strings.Repeat("s", 60)}, // 19, kept
			{Role: "user", Content: strings.Repeat("u", 40)},   // 14, droppable
			{Role: "user", Content: "last"},                    // 5, kept
		},
	}
	_, err := c.Chat(context.Background(), req)
	var appErr *observability.AppError
	if !errors.As(err, &appErr) || appErr.Code != ErrCodeContextOverflow {
		t.Fatalf("err = %v, want %s", err, ErrCodeContextOverflow)
	}
	if got := appErr.Context["truncated_messages"]; got != "1" {
		t.Fatalf("truncated_messages = %q, want %q", got, "1")
	}
}

func TestBudgetMetricsRecorded(t *testing.T) {
	reg := prometheus.NewRegistry()
	var got ChatRequest
	srv := captureServer(t, &got)
	defer srv.Close()

	cfg := budgetTestConfig(srv.URL)
	c := NewClient(cfg, reg)
	defer c.Close()

	// Truncating request: 94 estimated tokens into a 89-token budget.
	msgs := []Message{{Role: "system", Content: "sys"}}
	for i := 0; i < 6; i++ {
		msgs = append(msgs, Message{Role: "user", Content: strings.Repeat(string(rune('a'+i)), 40)})
	}
	msgs = append(msgs, Message{Role: "user", Content: "last"})
	if _, err := c.Chat(context.Background(), ChatRequest{Model: "test-model", Messages: msgs}); err != nil {
		t.Fatalf("Chat: %v", err)
	}

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	var promptObserved, truncations float64
	for _, f := range families {
		switch f.GetName() {
		case "modelclient_prompt_tokens":
			for _, m := range f.GetMetric() {
				promptObserved += float64(m.GetHistogram().GetSampleCount())
			}
		case "modelclient_truncations_total":
			for _, m := range f.GetMetric() {
				truncations += m.GetCounter().GetValue()
			}
		}
	}
	if promptObserved != 1 {
		t.Fatalf("modelclient_prompt_tokens samples = %v, want 1", promptObserved)
	}
	if truncations != 1 {
		t.Fatalf("modelclient_truncations_total = %v, want 1", truncations)
	}
}

func TestEstimateTokensEmpty(t *testing.T) {
	if got := EstimateTokens(nil); got != 0 {
		t.Fatalf("EstimateTokens(nil) = %d, want 0", got)
	}
}

func TestEstimateTokensASCII(t *testing.T) {
	// "hello": 5 ASCII chars -> ceil(5/4) = 2 tokens + 4 overhead = 6.
	msgs := []Message{{Role: "user", Content: "hello"}}
	if got := EstimateTokens(msgs); got != 6 {
		t.Fatalf("EstimateTokens = %d, want 6", got)
	}
}

func TestEstimateTokensCJK(t *testing.T) {
	// "你好世界": 4 non-ASCII runes -> ceil(4/1.5) = 3 tokens + 4 overhead = 7.
	msgs := []Message{{Role: "user", Content: "你好世界"}}
	if got := EstimateTokens(msgs); got != 7 {
		t.Fatalf("EstimateTokens = %d, want 7", got)
	}
}

func TestEstimateTokensMixed(t *testing.T) {
	// "ab你": 2 ASCII -> 1 token, 1 CJK -> 1 token, + 4 overhead = 6.
	msgs := []Message{{Role: "user", Content: "ab你"}}
	if got := EstimateTokens(msgs); got != 6 {
		t.Fatalf("EstimateTokens = %d, want 6", got)
	}
}

func TestEstimateTokensMultipleMessages(t *testing.T) {
	// Two "hello" messages: 6 + 6 = 12.
	msgs := []Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "hello"},
	}
	if got := EstimateTokens(msgs); got != 12 {
		t.Fatalf("EstimateTokens = %d, want 12", got)
	}
}
