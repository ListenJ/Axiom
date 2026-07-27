package astopt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSrc writes a Go source file into a fresh temp directory and returns
// the directory. Multiple sources may share one dir via writeSrcIn.
func writeSrc(t *testing.T, name, src string) string {
	t.Helper()
	dir := t.TempDir()
	writeSrcIn(t, dir, name, src)
	return dir
}

func writeSrcIn(t *testing.T, dir, name, src string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

// findByRule returns all findings with the given rule ID.
func findByRule(fs []Finding, rule string) []Finding {
	var out []Finding
	for _, f := range fs {
		if f.Rule == rule {
			out = append(out, f)
		}
	}
	return out
}

func TestScanStringConcatInLoop(t *testing.T) {
	dir := writeSrc(t, "a.go", `package p

func build(parts []string) string {
	s := ""
	for _, p := range parts {
		s += p + "/"
	}
	return s
}

func clean() int {
	n := 0
	for i := 0; i < 10; i++ {
		n += i // numeric accumulation is fine
	}
	return n
}
`)
	fs, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hits := findByRule(fs, RuleStringConcatLoop)
	if len(hits) != 1 {
		t.Fatalf("want 1 string-concat finding, got %d: %+v", len(hits), fs)
	}
	if hits[0].Severity != Warn {
		t.Errorf("severity = %s, want warn", hits[0].Severity)
	}
	if hits[0].Line != 6 {
		t.Errorf("line = %d, want 6", hits[0].Line)
	}
	if !strings.Contains(hits[0].Message, "strings.Builder") {
		t.Errorf("message should suggest strings.Builder: %q", hits[0].Message)
	}
}

func TestScanSprintfInLoop(t *testing.T) {
	dir := writeSrc(t, "b.go", `package p

import "fmt"

func labels(ns []int) []string {
	out := make([]string, 0, len(ns))
	for _, n := range ns {
		out = append(out, fmt.Sprintf("id-%d", n))
	}
	return out
}

func once() string {
	return fmt.Sprintf("outside loop %d", 1)
}
`)
	fs, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hits := findByRule(fs, RuleSprintfInLoop)
	if len(hits) != 1 {
		t.Fatalf("want 1 sprintf finding, got %d: %+v", len(hits), fs)
	}
	if hits[0].Line != 8 {
		t.Errorf("line = %d, want 8", hits[0].Line)
	}
}

func TestScanHeapAllocInLoop(t *testing.T) {
	dir := writeSrc(t, "c.go", `package p

type item struct{ v int }

func alloc(n int) []*item {
	var out []*item
	for i := 0; i < n; i++ {
		buf := new(int)
		_ = buf
		tmp := make([]byte, 16)
		_ = tmp
		it := &item{v: i}
		out = append(out, it)
	}
	return out
}
`)
	fs, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hits := findByRule(fs, RuleHeapAllocInLoop)
	if len(hits) != 3 {
		t.Fatalf("want 3 heap-alloc findings (new, make, &lit), got %d: %+v", len(hits), fs)
	}
	for _, h := range hits {
		if h.Severity != Warn {
			t.Errorf("severity = %s, want warn", h.Severity)
		}
	}
}

func TestScanUnbufferedChan(t *testing.T) {
	dir := writeSrc(t, "d.go", `package p

func pipeline() chan int {
	ch := make(chan int)
	buf := make(chan int, 8)
	_ = buf
	return ch
}
`)
	fs, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hits := findByRule(fs, RuleUnbufferedChan)
	if len(hits) != 1 {
		t.Fatalf("want 1 unbuffered-chan finding, got %d: %+v", len(hits), fs)
	}
	if hits[0].Severity != Info {
		t.Errorf("severity = %s, want info", hits[0].Severity)
	}
}

func TestScanNestedLoopsReportedOnce(t *testing.T) {
	dir := writeSrc(t, "e.go", `package p

import "fmt"

func matrix(xs, ys []int) {
	for _, x := range xs {
		for _, y := range ys {
			fmt.Sprintf("%d-%d", x, y)
		}
	}
}
`)
	fs, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hits := findByRule(fs, RuleSprintfInLoop)
	if len(hits) != 1 {
		t.Fatalf("nested loop hit must be reported exactly once, got %d: %+v", len(hits), fs)
	}
	if hits[0].Line != 8 {
		t.Errorf("line = %d, want 8", hits[0].Line)
	}
}

func TestScanSkipsNonGoAndHiddenDirs(t *testing.T) {
	dir := t.TempDir()
	writeSrcIn(t, dir, "ok.go", "package p\n")
	writeSrcIn(t, dir, "note.txt", "for { fmt.Sprintf }")
	if err := os.MkdirAll(filepath.Join(dir, ".hidden"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeSrcIn(t, filepath.Join(dir, ".hidden"), "h.go", `package h

import "fmt"

func f(xs []int) {
	for _, x := range xs {
		fmt.Sprintf("%d", x)
	}
}
`)
	fs, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(fs) != 0 {
		t.Fatalf("want no findings, got %+v", fs)
	}
}

func TestScanSyntaxErrorPropagates(t *testing.T) {
	dir := writeSrc(t, "bad.go", "package p\n\nfunc broken( {\n")
	if _, err := Scan(dir); err == nil {
		t.Fatal("want error for unparseable file")
	}
}

func TestFormatReport(t *testing.T) {
	fs := []Finding{
		{File: "a.go", Line: 3, Rule: RuleSprintfInLoop, Severity: Warn, Message: "m1"},
		{File: "b.go", Line: 9, Rule: RuleUnbufferedChan, Severity: Info, Message: "m2"},
	}
	rep := FormatReport(fs)
	if !strings.Contains(rep, "a.go:3: [warn] sprintf-in-loop: m1") {
		t.Errorf("report missing warn line:\n%s", rep)
	}
	if !strings.Contains(rep, "b.go:9: [info] unbuffered-chan: m2") {
		t.Errorf("report missing info line:\n%s", rep)
	}
	if !strings.Contains(rep, "2 finding(s) (1 warn, 1 info)") {
		t.Errorf("report missing summary:\n%s", rep)
	}
}

// BenchmarkScan measures scanner throughput over the runtime-go module
// itself (the parent directory of this package).
func BenchmarkScan(b *testing.B) {
	root := filepath.Join("..", "..")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		fs, err := Scan(root)
		if err != nil {
			b.Fatalf("Scan: %v", err)
		}
		if i == 0 {
			b.ReportMetric(float64(len(fs)), "findings")
		}
	}
}
