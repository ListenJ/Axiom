package modelclient

import (
	"log/slog"
	"strconv"

	"runtime-go/internal/observability"
)

// Per-message structural overhead in tokens (role tag, separators, etc.).
const messageOverheadTokens = 4

// EstimateTokens approximates the prompt token count without a tokenizer.
// Heuristic: ASCII/Latin characters count ~4 chars per token, CJK and other
// non-ASCII runes count ~1.5 chars per token, plus a fixed 4-token structural
// overhead per message. Only message Content is counted; the per-message
// overhead covers roles and framing.
func EstimateTokens(messages []Message) int {
	total := 0
	for _, m := range messages {
		ascii, nonASCII := 0, 0
		for _, r := range m.Content {
			if r < 128 {
				ascii++
			} else {
				nonASCII++
			}
		}
		// ceil(ascii/4) + ceil(nonASCII/1.5) + overhead.
		total += (ascii+3)/4 + (nonASCII*2+2)/3 + messageOverheadTokens
	}
	return total
}

// fitRequest fits req to the client's context window. If the estimated
// prompt alone exceeds ContextWindow - ReservedOutputTokens - 1, the oldest
// non-system messages are dropped first (all system messages and the last
// message are always kept). MaxTokens is then clamped so that estimated
// prompt tokens + MaxTokens stay within ContextWindow -
// ReservedOutputTokens. A clamped result below 1 token is reported as an
// AppError with ErrCodeContextOverflow.
func (c *Client) fitRequest(req ChatRequest) (ChatRequest, error) {
	limit := c.cfg.ContextWindow - c.cfg.ReservedOutputTokens

	estBefore := EstimateTokens(req.Messages)
	truncated := 0
	if estBefore > limit-1 {
		var fitted []Message
		fitted, truncated = truncateMessages(req.Messages, limit-1)
		if truncated > 0 {
			req.Messages = fitted
			c.metric.truncations.Add(float64(truncated))
			slog.Warn("modelclient: prompt truncated to fit context window",
				"truncated_messages", truncated,
				"context_window", c.cfg.ContextWindow,
				"prompt_tokens_before", estBefore,
			)
		}
	}

	est := EstimateTokens(req.Messages)
	c.metric.promptTokens.Observe(float64(est))
	if req.MaxTokens <= 0 || est+req.MaxTokens > limit {
		clamped := limit - est
		if clamped < 1 {
			return ChatRequest{}, errContextOverflow(est, c.cfg.ContextWindow, c.cfg.ReservedOutputTokens, truncated)
		}
		req.MaxTokens = clamped
	}
	return req, nil
}

// truncateMessages returns a copy of messages that fits within the token
// limit, dropping the oldest non-system messages first. All system messages
// and the last message are never dropped; the second return value reports
// how many messages were dropped. If nothing needs dropping, the input is
// returned unchanged.
func truncateMessages(messages []Message, limit int) ([]Message, int) {
	if EstimateTokens(messages) <= limit {
		return messages, 0
	}
	kept := make([]Message, len(messages))
	copy(kept, messages)
	dropped := 0
	for EstimateTokens(kept) > limit {
		idx := -1
		for i := 0; i < len(kept)-1; i++ {
			if kept[i].Role != "system" {
				idx = i
				break
			}
		}
		if idx < 0 {
			break // only system messages and the last message remain
		}
		kept = append(kept[:idx], kept[idx+1:]...)
		dropped++
	}
	return kept, dropped
}

// errContextOverflow builds the AppError for a prompt that leaves no room
// for even a single output token.
func errContextOverflow(promptTokens, window, reserve, truncated int) error {
	err := observability.NewAppError(ErrCodeContextOverflow,
		"estimated prompt leaves no output budget in the context window").
		WithContext("prompt_tokens", strconv.Itoa(promptTokens)).
		WithContext("context_window", strconv.Itoa(window)).
		WithContext("reserved_output_tokens", strconv.Itoa(reserve))
	if truncated > 0 {
		err = err.WithContext("truncated_messages", strconv.Itoa(truncated))
	}
	return err
}
