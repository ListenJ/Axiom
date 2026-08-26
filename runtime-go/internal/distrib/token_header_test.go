package distrib

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestAuthTokenHeader verifies that outbound RPCs carry X-Axiom-Token when
// SEARCHD_AUTH_TOKEN is configured, and omit it when it is not.
func TestAuthTokenHeader(t *testing.T) {
	cases := []struct {
		name  string
		token string
	}{
		{"configured", "cluster-secret-1"},
		{"unconfigured", ""},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SEARCHD_AUTH_TOKEN", tc.token)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("X-Axiom-Token"); got != tc.token {
					t.Errorf("%s %s: X-Axiom-Token = %q, want %q", r.Method, r.URL.Path, got, tc.token)
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer srv.Close()

			ctx := context.Background()
			if err := DoJSON(ctx, srv.Client(), http.MethodGet, srv.URL, nil, nil); err != nil {
				t.Fatalf("DoJSON: %v", err)
			}
			if _, _, err := DoRaw(ctx, srv.Client(), http.MethodPost, srv.URL, "application/octet-stream", []byte("ping")); err != nil {
				t.Fatalf("DoRaw: %v", err)
			}
		})
	}
}
