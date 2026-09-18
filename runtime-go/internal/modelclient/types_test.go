package modelclient

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReasoningContentParsed(t *testing.T) {
	body := `{
		"id": "chatcmpl-x",
		"object": "chat.completion",
		"model": "qwopus",
		"choices": [{
			"index": 0,
			"message": {"role": "assistant", "content": "", "reasoning_content": "let me think..."},
			"finish_reason": "length"
		}]
	}`
	var resp ChatResponse
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got := resp.Choices[0].Message.ReasoningContent; got != "let me think..." {
		t.Fatalf("reasoning_content = %q", got)
	}
}

func TestContentFallsBackToReasoning(t *testing.T) {
	// Reasoning model exhausted max_tokens during reasoning: content empty,
	// finish_reason=length. Content() must return the reasoning trace rather
	// than an empty string.
	resp := ChatResponse{Choices: []Choice{{
		Message:      Message{Role: "assistant", ReasoningContent: "thinking trace"},
		FinishReason: "length",
	}}}
	if got := resp.Content(); got != "thinking trace" {
		t.Fatalf("Content() = %q, want reasoning fallback", got)
	}
}

func TestContentPrefersContent(t *testing.T) {
	resp := ChatResponse{Choices: []Choice{{
		Message: Message{Role: "assistant", Content: "answer", ReasoningContent: "trace"},
	}}}
	if got := resp.Content(); got != "answer" {
		t.Fatalf("Content() = %q, want content", got)
	}
}

func TestContentEmptyWhenNeither(t *testing.T) {
	var resp ChatResponse
	if got := resp.Content(); got != "" {
		t.Fatalf("Content() = %q, want empty", got)
	}
	resp = ChatResponse{Choices: []Choice{{Message: Message{Role: "assistant"}}}}
	if got := resp.Content(); !strings.EqualFold(got, "") {
		t.Fatalf("Content() = %q, want empty", got)
	}
}
