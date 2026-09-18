package search

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

// indexEqual compares two index snapshots for structural equality.
func indexEqual(a, b *Index) error {
	if len(a.shards) != len(b.shards) {
		return fmt.Errorf("shard count %d != %d", len(a.shards), len(b.shards))
	}
	if !reflect.DeepEqual(a.ids, b.ids) {
		return fmt.Errorf("ids maps differ")
	}
	if a.docs != b.docs {
		return fmt.Errorf("live doc count %d != %d", a.docs, b.docs)
	}
	for i := range a.shards {
		sa, sb := a.shards[i], b.shards[i]
		if !reflect.DeepEqual(sa.terms, sb.terms) {
			return fmt.Errorf("shard %d terms differ", i)
		}
		if !reflect.DeepEqual(sa.docs, sb.docs) {
			return fmt.Errorf("shard %d docs differ", i)
		}
		if sa.maxDoc != sb.maxDoc {
			return fmt.Errorf("shard %d maxDoc %d != %d", i, sa.maxDoc, sb.maxDoc)
		}
	}
	return nil
}

// TestBuildParallelMatchesSerial proves the parallel index build produces
// exactly the same index as a single-worker build.
func TestBuildParallelMatchesSerial(t *testing.T) {
	docs := genDocs(2000)
	serial := BuildIndex(docs, 16, 1)
	parallel := BuildIndex(docs, 16, 8)
	if err := indexEqual(serial, parallel); err != nil {
		t.Fatalf("parallel build differs from serial: %v", err)
	}
}

// TestTombstoneDelete verifies deletes hide documents from queries without
// touching the old snapshot.
func TestTombstoneDelete(t *testing.T) {
	e := NewEngine(newTestRegistry(t), 8)
	ctx := context.Background()
	mustBuild(t, e, []Document{
		{ID: "a", Body: "apple banana"},
		{ID: "b", Body: "apple cherry"},
	})

	if err := e.Update(ctx, nil, []string{"a"}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	hits := mustSearch(t, e, "apple", 10)
	if len(hits) != 1 || hits[0].ID != "b" {
		t.Fatalf("expected only doc b after delete, got %+v", hits)
	}
	if n := e.DocCount(); n != 1 {
		t.Fatalf("live doc count = %d, want 1", n)
	}
	// Deleting an unknown ID is a no-op.
	if err := e.Update(ctx, nil, []string{"nope"}); err != nil {
		t.Fatalf("delete unknown: %v", err)
	}
	if n := e.DocCount(); n != 1 {
		t.Fatalf("live doc count after no-op delete = %d, want 1", n)
	}
}

// TestUpdateVisibility asserts the COW contract: a document written by
// Update is visible to the very next query, well under one second.
func TestUpdateVisibility(t *testing.T) {
	e := NewEngine(newTestRegistry(t), 16)
	ctx := context.Background()
	mustBuild(t, e, genDocs(1000))

	start := time.Now()
	if err := e.Update(ctx, []Document{{ID: "fresh", Body: "zzqvisiblemarker"}}, nil); err != nil {
		t.Fatalf("update: %v", err)
	}
	hits := mustSearch(t, e, "zzqvisiblemarker", 10)
	elapsed := time.Since(start)
	if len(hits) != 1 || hits[0].ID != "fresh" {
		t.Fatalf("updated doc not immediately visible: %+v", hits)
	}
	if elapsed > time.Second {
		t.Fatalf("visibility latency %v exceeds 1s", elapsed)
	}
	t.Logf("update-to-visible latency: %v", elapsed)
}

// TestUpdateModify verifies that modifying a document tombstones the old
// version: old terms stop matching, new terms match.
func TestUpdateModify(t *testing.T) {
	e := NewEngine(newTestRegistry(t), 8)
	ctx := context.Background()
	mustBuild(t, e, []Document{{ID: "u1", Body: "oldtermcontent"}})

	if err := e.Update(ctx, []Document{{ID: "u1", Body: "newtermcontent"}}, nil); err != nil {
		t.Fatalf("update: %v", err)
	}
	if hits := mustSearch(t, e, "newtermcontent", 10); len(hits) != 1 || hits[0].ID != "u1" {
		t.Fatalf("new content not found: %+v", hits)
	}
	if hits := mustSearch(t, e, "oldtermcontent", 10); len(hits) != 0 {
		t.Fatalf("old content still visible: %+v", hits)
	}
	if n := e.DocCount(); n != 1 {
		t.Fatalf("live doc count = %d, want 1", n)
	}
}

// TestOptimizerOrdersSelectiveFirst checks the cost model reorders AND
// children by ascending document frequency.
func TestOptimizerOrdersSelectiveFirst(t *testing.T) {
	var docs []Document
	for i := 0; i < 100; i++ {
		docs = append(docs, Document{ID: fmt.Sprintf("c%d", i), Body: "commonterm"})
	}
	docs = append(docs, Document{ID: "r0", Body: "commonterm rareterm"})
	e := NewEngine(newTestRegistry(t), 4)
	mustBuild(t, e, docs)

	node, err := ParseQuery("commonterm rareterm")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	opt := Optimize(node, e.idx.Load())
	and, ok := opt.(And)
	if !ok {
		t.Fatalf("expected And node, got %T", opt)
	}
	first, ok := and.Children[0].(Term)
	if !ok || first.Value != "rareterm" {
		t.Fatalf("most selective term should execute first, got %+v", and.Children[0])
	}
}
