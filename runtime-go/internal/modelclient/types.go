// Package modelclient is the adapter layer for llama.cpp's OpenAI-compatible
// chat completion service. It provides timeout control, bounded retry with
// exponential backoff, round-robin load balancing across endpoints,
// background health checks with circuit breaking, and an injectable fallback
// handler for full outages.
//
// Endpoints are configured via Config.Endpoints, or the MODEL_SERVICE_URL
// environment variable (comma-separated for multiple endpoints), defaulting
// to the ${LAN_MODEL_SERVICE} placeholder (no internal address hard-coded).
package modelclient

import "context"

// Message is a single chat message in the OpenAI chat format.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// ReasoningContent carries the reasoning trace of reasoning models
	// (e.g. Qwopus) that emit it in a separate field before the final answer.
	ReasoningContent string `json:"reasoning_content,omitempty"`
}

// ChatRequest is an OpenAI /v1/chat/completions request. Only commonly used
// fields are modeled.
type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature *float64  `json:"temperature,omitempty"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
	TopP        *float64  `json:"top_p,omitempty"`
	Stream      bool      `json:"stream,omitempty"`
}

// Choice is one completion choice in a ChatResponse.
type Choice struct {
	Index        int     `json:"index"`
	Message      Message `json:"message"`
	FinishReason string  `json:"finish_reason"`
}

// Usage reports token accounting for a completion.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// ChatResponse is an OpenAI /v1/chat/completions response.
type ChatResponse struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"`
	Created int64    `json:"created"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
	Usage   Usage    `json:"usage"`
}

// Content returns the content of the first choice, or "" if there is none.
// Fallback semantics: reasoning models may exhaust their token budget during
// reasoning (finish_reason=length) and leave content empty; in that case the
// reasoning_content of the first choice is returned instead of "".
func (r ChatResponse) Content() string {
	if len(r.Choices) == 0 {
		return ""
	}
	if c := r.Choices[0].Message.Content; c != "" {
		return c
	}
	return r.Choices[0].Message.ReasoningContent
}

// FallbackFunc handles a request when no endpoint is available.
type FallbackFunc func(ctx context.Context, req ChatRequest) (ChatResponse, error)
