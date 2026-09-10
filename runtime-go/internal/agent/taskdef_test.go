package agent

import (
	"errors"
	"testing"
)

func testDef(name string) TaskDefinition {
	return TaskDefinition{
		Name:       name,
		Type:       "shell",
		Params:     map[string]string{"cmd": "echo hi"},
		Resources:  ResourceRequirements{MemoryBytes: 64 << 20, CPUCores: 0.5},
		Idempotent: true,
	}
}

func TestConfigStoreCreateAndGet(t *testing.T) {
	s := NewMemoryConfigStore()
	v, err := s.Put(testDef("crawler"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if v.Version != 1 {
		t.Fatalf("first version = %d, want 1", v.Version)
	}
	if v.Hash == "" {
		t.Fatal("hash must not be empty")
	}
	got, err := s.Get("crawler")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Version != 1 || got.Def.Name != "crawler" {
		t.Fatalf("Get returned %+v", got)
	}
}

func TestConfigStoreUpdateIncrementsVersion(t *testing.T) {
	s := NewMemoryConfigStore()
	v1, _ := s.Put(testDef("crawler"))
	d2 := testDef("crawler")
	d2.Params["cmd"] = "echo v2"
	v2, err := s.Put(d2)
	if err != nil {
		t.Fatalf("Put v2: %v", err)
	}
	if v2.Version != 2 {
		t.Fatalf("second version = %d, want 2", v2.Version)
	}
	if v2.Hash == v1.Hash {
		t.Fatal("hash must change when content changes")
	}

	cur, _ := s.Get("crawler")
	if cur.Version != 2 || cur.Def.Params["cmd"] != "echo v2" {
		t.Fatalf("current = %+v", cur)
	}

	// Full history is retained.
	versions, err := s.Versions("crawler")
	if err != nil {
		t.Fatalf("Versions: %v", err)
	}
	if len(versions) != 2 {
		t.Fatalf("len(versions) = %d, want 2", len(versions))
	}

	old, err := s.GetVersion("crawler", 1)
	if err != nil {
		t.Fatalf("GetVersion: %v", err)
	}
	if old.Def.Params["cmd"] != "echo hi" {
		t.Fatalf("v1 params = %v", old.Def.Params)
	}
}

func TestConfigStoreRollback(t *testing.T) {
	s := NewMemoryConfigStore()
	s.Put(testDef("crawler"))
	d2 := testDef("crawler")
	d2.Params["cmd"] = "echo v2"
	s.Put(d2)

	v3, err := s.Rollback("crawler", 1)
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	// Rollback creates a new version carrying the old content; history is
	// append-only and version numbers stay monotonic.
	if v3.Version != 3 {
		t.Fatalf("rollback version = %d, want 3", v3.Version)
	}
	cur, _ := s.Get("crawler")
	if cur.Def.Params["cmd"] != "echo hi" {
		t.Fatalf("after rollback params = %v", cur.Def.Params)
	}
	v1, _ := s.GetVersion("crawler", 1)
	if cur.Hash != v1.Hash {
		t.Fatal("rollback version must have same hash as source version")
	}
	versions, _ := s.Versions("crawler")
	if len(versions) != 3 {
		t.Fatalf("len(versions) = %d, want 3", len(versions))
	}
}

func TestConfigStoreErrors(t *testing.T) {
	s := NewMemoryConfigStore()
	if _, err := s.Get("missing"); !errors.Is(err, ErrTaskDefNotFound) {
		t.Fatalf("Get missing err = %v", err)
	}
	s.Put(testDef("crawler"))
	if _, err := s.GetVersion("crawler", 9); !errors.Is(err, ErrVersionNotFound) {
		t.Fatalf("GetVersion err = %v", err)
	}
	if _, err := s.Rollback("missing", 1); !errors.Is(err, ErrTaskDefNotFound) {
		t.Fatalf("Rollback missing err = %v", err)
	}
	if _, err := s.Put(TaskDefinition{}); !errors.Is(err, ErrInvalidTaskDef) {
		t.Fatalf("Put empty name err = %v", err)
	}
}

func TestConfigStoreListAndDelete(t *testing.T) {
	s := NewMemoryConfigStore()
	s.Put(testDef("a"))
	s.Put(testDef("b"))
	if got := len(s.List()); got != 2 {
		t.Fatalf("List len = %d, want 2", got)
	}
	if err := s.Delete("a"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get("a"); !errors.Is(err, ErrTaskDefNotFound) {
		t.Fatalf("Get after delete err = %v", err)
	}
	if got := len(s.List()); got != 1 {
		t.Fatalf("List len after delete = %d, want 1", got)
	}
}
