package httpauth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const testEnvKey = "HTTPAUTH_TEST_TOKEN"

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	val, ok := os.LookupEnv(key)
	if _ = os.Unsetenv(key); ok {
		t.Cleanup(func() { _ = os.Setenv(key, val) })
	}
}

func TestWriteGuard(t *testing.T) {
	isWrite := func(r *http.Request) bool {
		return r.Method != http.MethodGet && r.Method != http.MethodHead
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := WriteGuard(testEnvKey, isWrite)(next)

	tests := []struct {
		name       string
		setToken   bool
		method     string
		headerVal  string
		wantStatus int
	}{
		{"env unset POST forbidden", false, http.MethodPost, "", http.StatusForbidden},
		{"env unset PUT forbidden", false, http.MethodPut, "", http.StatusForbidden},
		{"env unset GET allowed", false, http.MethodGet, "", http.StatusOK},
		{"env unset HEAD allowed", false, http.MethodHead, "", http.StatusOK},
		{"env set correct token allowed", true, http.MethodPost, "secret", http.StatusOK},
		{"env set wrong token forbidden", true, http.MethodPost, "wrong", http.StatusForbidden},
		{"env set missing header forbidden", true, http.MethodPost, "", http.StatusForbidden},
		{"env set DELETE correct token allowed", true, http.MethodDelete, "secret", http.StatusOK},
		{"env set GET allowed without token", true, http.MethodGet, "", http.StatusOK},
		{"env set HEAD allowed without token", true, http.MethodHead, "", http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setToken {
				t.Setenv(testEnvKey, "secret")
			} else {
				unsetEnv(t, testEnvKey)
			}
			req := httptest.NewRequest(tt.method, "/documents", nil)
			if tt.headerVal != "" {
				req.Header.Set("X-Axiom-Token", tt.headerVal)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if tt.wantStatus == http.StatusForbidden && !tt.setToken {
				if got := rec.Body.String(); !strings.Contains(got, "write endpoint disabled: set "+testEnvKey) {
					t.Fatalf("disabled body = %q, want mention of env key", got)
				}
			}
		})
	}
}

func TestWriteGuardInvalidTokenBody(t *testing.T) {
	isWrite := func(r *http.Request) bool { return r.Method == http.MethodPost }
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := WriteGuard(testEnvKey, isWrite)(next)
	t.Setenv(testEnvKey, "secret")

	req := httptest.NewRequest(http.MethodPost, "/documents", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if got := rec.Body.String(); !strings.Contains(got, `"invalid token"`) {
		t.Fatalf("body = %q, want invalid token error", got)
	}
}
