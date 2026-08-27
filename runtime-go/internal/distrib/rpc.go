package distrib

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	"runtime-go/internal/observability"
)

// maxErrorBody caps how much of a non-2xx response body is read into the
// error, so a misbehaving peer cannot exhaust memory.
const maxErrorBody = 64 << 10

// setAuthHeader attaches X-Axiom-Token to an outbound request when
// SEARCHD_AUTH_TOKEN is configured, so peers with write auth enabled accept
// cluster RPCs instead of rejecting them with 403.
func setAuthHeader(h http.Header) {
	if tok := os.Getenv("SEARCHD_AUTH_TOKEN"); tok != "" {
		h.Set("X-Axiom-Token", tok)
	}
}

// DoJSON performs one JSON RPC: it marshals in (a nil in sends no body),
// issues the request with the given client, and decodes a 2xx response body
// into out (a nil out discards the body).
//
// Timeouts and cancellation are the caller's responsibility via ctx. Any
// failure — marshal, transport, cancellation, non-2xx status, or decode —
// is returned as *observability.AppError with code ErrCodeRPC. Non-2xx
// responses additionally carry the HTTP status code in the error context
// under "status" and include the response body in the message.
func DoJSON(ctx context.Context, client *http.Client, method, url string, in, out any) error {
	if client == nil {
		client = http.DefaultClient
	}

	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return observability.WrapError(ErrCodeRPC, "marshal request body", err).
				WithContext("url", url)
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return observability.WrapError(ErrCodeRPC, "build request", err).
			WithContext("url", url)
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	setAuthHeader(req.Header)

	resp, err := client.Do(req)
	if err != nil {
		return observability.WrapError(ErrCodeRPC, "request failed", err).
			WithContext("url", url).
			WithContext("method", method)
	}
	defer func() {
		// Drain before close so the connection is reusable even when the
		// decoder stopped short of EOF.
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return observability.NewAppError(ErrCodeRPC,
			fmt.Sprintf("rpc %s %s: %s: %s", method, url, resp.Status, bytes.TrimSpace(raw))).
			WithContext("url", url).
			WithContext("method", method).
			WithContext("status", fmt.Sprintf("%d", resp.StatusCode))
	}

	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil && err != io.EOF {
		return observability.WrapError(ErrCodeRPC, "decode response body", err).
			WithContext("url", url)
	}
	return nil
}

// DefaultClient returns an *http.Client with the given overall timeout and a
// connection pool sized for high-fanout peer RPC: under cluster load every
// query triggers one RPC per peer, so the idle pool must absorb the full
// in-flight concurrency or each RPC pays a fresh connect+close.
func DefaultClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   5 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:        1024,
			MaxIdleConnsPerHost: 256,
			IdleConnTimeout:     90 * time.Second,
		},
	}
}
