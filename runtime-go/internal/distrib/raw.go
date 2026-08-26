package distrib

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"

	"runtime-go/internal/observability"
)

// DoRaw performs a request with a pre-encoded body and returns the raw 2xx
// response body plus headers, for protocol-sniffing callers (binary RPC with
// JSON fallback). Semantics mirror DoJSON: non-2xx becomes an AppError and
// the body is drained before close so the connection stays reusable.
func DoRaw(ctx context.Context, client *http.Client, method, url, contentType string, body []byte) ([]byte, http.Header, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return nil, nil, observability.WrapError(ErrCodeRPC, "build request", err).WithContext("url", url)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", contentType+", application/json")
	setAuthHeader(req.Header)
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, observability.WrapError(ErrCodeRPC, "request failed", err).
			WithContext("url", url).WithContext("method", method)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return nil, nil, observability.NewAppError(ErrCodeRPC,
			fmt.Sprintf("rpc %s %s: %s: %s", method, url, resp.Status, bytes.TrimSpace(raw))).
			WithContext("url", url).WithContext("method", method).
			WithContext("status", fmt.Sprintf("%d", resp.StatusCode))
	}
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, observability.WrapError(ErrCodeRPC, "read response", err).WithContext("url", url)
	}
	return out, resp.Header.Clone(), nil
}
