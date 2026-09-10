package distrib

import (
	"errors"
	"testing"

	"runtime-go/internal/observability"
)

func TestParseNodes_Valid(t *testing.T) {
	nodes, err := ParseNodes(`[
		{"id":"n1","addr":"http://192.168.0.150:9103","role":"primary"},
		{"id":"n2","addr":"http://192.168.0.151:9103","role":"replica"}
	]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}
	if nodes[0].ID != "n1" || nodes[0].Addr != "http://192.168.0.150:9103" || nodes[0].Role != "primary" {
		t.Fatalf("unexpected node: %+v", nodes[0])
	}
	if nodes[1].Role != "replica" {
		t.Fatalf("unexpected role: %+v", nodes[1])
	}
}

func TestParseNodes_RoleOptional(t *testing.T) {
	nodes, err := ParseNodes(`[{"id":"n1","addr":"http://192.168.0.150:9103"}]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if nodes[0].Role != "" {
		t.Fatalf("expected empty role, got %q", nodes[0].Role)
	}
}

func TestParseNodes_EmptyID(t *testing.T) {
	_, err := ParseNodes(`[{"id":"","addr":"http://192.168.0.150:9103"}]`)
	assertConfigError(t, err)
}

func TestParseNodes_EmptyAddr(t *testing.T) {
	_, err := ParseNodes(`[{"id":"n1","addr":""}]`)
	assertConfigError(t, err)
}

func TestParseNodes_DuplicateID(t *testing.T) {
	_, err := ParseNodes(`[
		{"id":"n1","addr":"http://192.168.0.150:9103"},
		{"id":"n1","addr":"http://192.168.0.151:9103"}
	]`)
	assertConfigError(t, err)
}

func TestParseNodes_BadJSON(t *testing.T) {
	_, err := ParseNodes(`{"not":"an array"}`)
	assertConfigError(t, err)
}

func TestParseNodes_Empty(t *testing.T) {
	_, err := ParseNodes(`[]`)
	assertConfigError(t, err)
}

func assertConfigError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var ae *observability.AppError
	if !errors.As(err, &ae) {
		t.Fatalf("expected AppError, got %T: %v", err, err)
	}
	if ae.Code != ErrCodeConfig {
		t.Fatalf("expected code %q, got %q", ErrCodeConfig, ae.Code)
	}
}
