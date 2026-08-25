package httpauth

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
)

func WriteGuard(envKey string, isWrite func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isWrite(r) {
				next.ServeHTTP(w, r)
				return
			}
			token := os.Getenv(envKey)
			if token == "" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "write endpoint disabled: set " + envKey})
				return
			}
			got := r.Header.Get("X-Axiom-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				http.Error(w, `{"error":"invalid token"}`, http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
