package dagfs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile creates path inside dir, making parent directories as needed.
func writeFile(t *testing.T, dir, path, content string) string {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return full
}

// buildTree builds a module-shaped tree with an import dependency:
// a.go and c/c.go both import package b.
//
//	root/go.mod  (module example.com/m)
//	root/a.go    import "example.com/m/b"
//	root/b/b.go
//	root/c/c.go  import "example.com/m/b"
//	root/sub/d.go
func buildTree(t *testing.T) (root string, files map[string]string) {
	t.Helper()
	root = t.TempDir()
	files = map[string]string{
		"go.mod":   "module example.com/m\n\ngo 1.25\n",
		"a.go":     "package main\n\nimport _ \"example.com/m/b\"\n",
		"b/b.go":   "package b\n",
		"c/c.go":   "package c\n\nimport _ \"example.com/m/b\"\n",
		"sub/d.go": "package sub\n",
	}
	for rel, content := range files {
		files[rel] = writeFile(t, root, rel, content)
	}
	return root, files
}

// layerIndex maps each node to its layer number.
func layerIndex(layers [][]string) map[string]int {
	idx := map[string]int{}
	for i, layer := range layers {
		for _, n := range layer {
			idx[n] = i
		}
	}
	return idx
}

func TestBuildLayersRespectContainmentAndImports(t *testing.T) {
	root, files := buildTree(t)
	g, err := Build(root)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	layers, err := g.Layers()
	if err != nil {
		t.Fatalf("Layers: %v", err)
	}
	idx := layerIndex(layers)

	abs, _ := filepath.Abs(root)
	if idx[abs] != 0 {
		t.Errorf("root layer = %d, want 0", idx[abs])
	}
	// Containment: every file sits below its parent directory chain, so
	// the root is strictly above all files.
	for rel, absPath := range files {
		if idx[absPath] == 0 {
			t.Errorf("%s unexpectedly in layer 0", rel)
		}
	}
	// Import edges: b/b.go is imported by a.go and c/c.go, so it must
	// land in a strictly later layer than both importers.
	if idx[files["b/b.go"]] <= idx[files["a.go"]] {
		t.Errorf("b/b.go layer %d not after a.go layer %d", idx[files["b/b.go"]], idx[files["a.go"]])
	}
	if idx[files["b/b.go"]] <= idx[files["c/c.go"]] {
		t.Errorf("b/b.go layer %d not after c/c.go layer %d", idx[files["b/b.go"]], idx[files["c/c.go"]])
	}
	// Independent file: sub/d.go only has containment edges.
	if idx[files["sub/d.go"]] != 2 {
		t.Errorf("sub/d.go layer = %d, want 2 (root -> sub -> d.go)", idx[files["sub/d.go"]])
	}
}

func TestLayersDetectsImportCycle(t *testing.T) {
	root := t.TempDir()
	x := writeFile(t, root, "x/x.go", "package x\n\nimport _ \"example.com/cyc/y\"\n")
	y := writeFile(t, root, "y/y.go", "package y\n\nimport _ \"example.com/cyc/x\"\n")
	writeFile(t, root, "go.mod", "module example.com/cyc\n")

	g, err := Build(root)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	_, err = g.Layers()
	if err == nil {
		t.Fatal("Layers must report the import cycle, got nil error")
	}
	if !strings.Contains(err.Error(), "cycle") {
		t.Errorf("error should mention cycle: %v", err)
	}
	if !strings.Contains(err.Error(), x) || !strings.Contains(err.Error(), y) {
		t.Errorf("error should name both cyclic files: %v", err)
	}
}

func TestPrefetchReadsEverything(t *testing.T) {
	root, files := buildTree(t)
	contents, stats, err := Prefetch(root, 3)
	if err != nil {
		t.Fatalf("Prefetch: %v", err)
	}
	if stats.Files != len(files) {
		t.Errorf("stats.Files = %d, want %d", stats.Files, len(files))
	}
	var wantBytes int64
	for rel, absPath := range files {
		want, ok := contents[absPath]
		if !ok {
			t.Errorf("missing content for %s", rel)
			continue
		}
		onDisk, err := os.ReadFile(absPath)
		if err != nil {
			t.Fatal(err)
		}
		if string(want) != string(onDisk) {
			t.Errorf("content mismatch for %s", rel)
		}
		wantBytes += int64(len(onDisk))
	}
	if stats.Bytes != wantBytes {
		t.Errorf("stats.Bytes = %d, want %d", stats.Bytes, wantBytes)
	}
	if stats.Duration <= 0 {
		t.Errorf("stats.Duration = %v, want > 0", stats.Duration)
	}
}

func TestPrefetchAbortsOnCycle(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "x/x.go", "package x\n\nimport _ \"example.com/cyc/y\"\n")
	writeFile(t, root, "y/y.go", "package y\n\nimport _ \"example.com/cyc/x\"\n")
	writeFile(t, root, "go.mod", "module example.com/cyc\n")

	if _, _, err := Prefetch(root, 2); err == nil {
		t.Fatal("Prefetch must abort on a cyclic graph")
	}
}

func TestPrefetchDefaultConcurrency(t *testing.T) {
	root, files := buildTree(t)
	contents, _, err := Prefetch(root, 0)
	if err != nil {
		t.Fatalf("Prefetch: %v", err)
	}
	if len(contents) != len(files) {
		t.Errorf("read %d files, want %d", len(contents), len(files))
	}
}

func TestPrefetchMissingRoot(t *testing.T) {
	if _, _, err := Prefetch(filepath.Join(t.TempDir(), "nope"), 2); err == nil {
		t.Fatal("want error for missing root")
	}
}

// BenchmarkPrefetch measures read throughput over the runtime-go module
// itself (the parent directory of this package).
func BenchmarkPrefetch(b *testing.B) {
	root := filepath.Join("..", "..")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, stats, err := Prefetch(root, 8)
		if err != nil {
			b.Fatalf("Prefetch: %v", err)
		}
		if i == 0 {
			b.ReportMetric(float64(stats.Files), "files")
			b.ReportMetric(float64(stats.Bytes)/1024, "KiB")
		}
		b.ReportMetric(float64(stats.Files)/stats.Duration.Seconds(), "files/sec")
	}
}
