package search

import (
	"reflect"
	"testing"
)

func TestTokenizeASCII(t *testing.T) {
	got := Tokenize("Hello, World! go1.26 Is_FAST")
	want := []string{"hello", "world", "go1", "26", "is", "fast"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Tokenize mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestTokenizeCJKBigrams(t *testing.T) {
	got := Tokenize("知识图谱")
	want := []string{"知识", "识图", "图谱"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CJK bigrams mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestTokenizeCJKSingleRuneFallback(t *testing.T) {
	got := Tokenize("中")
	want := []string{"中"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("single Han rune mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestTokenizeMixed(t *testing.T) {
	got := Tokenize("Go语言")
	want := []string{"go", "语言"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mixed text mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestTokenizeEmpty(t *testing.T) {
	if got := Tokenize(" \t.,!"); len(got) != 0 {
		t.Fatalf("expected no tokens, got %q", got)
	}
}
