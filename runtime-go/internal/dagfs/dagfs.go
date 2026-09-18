// Package dagfs models a directory tree as a directed acyclic graph and
// uses the graph to schedule I/O: directory containment forms the first
// layer of edges, Go import statements between local files form the
// second. A Kahn topological layering then yields a batch prefetch order —
// files in the same layer can be read in parallel, layers are ordered —
// which improves readahead locality and reduces disk seek interleaving.
package dagfs

import (
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Graph is a file-tree DAG. Nodes are absolute paths of directories and
// files; Edges maps a node to the nodes it points at (a directory points to
// its entries, a Go file additionally points to the local files it
// imports).
type Graph struct {
	Root  string              // absolute root the graph was built from
	Nodes map[string]bool     // path -> isDir
	Edges map[string][]string // path -> sorted, deduplicated successors
}

// Build walks root and constructs the file-tree DAG. Directory entries
// produce containment edges; each .go file additionally gains an edge to
// every file inside root belonging to a package it imports (resolved via
// the module path declared in the nearest go.mod). Hidden directories,
// vendor and testdata are skipped. Symbolic links are not followed, so the
// containment layer cannot cycle; import cycles are left in the graph for
// Layers to detect.
func Build(root string) (*Graph, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("dagfs: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("dagfs: %s is not a directory", abs)
	}

	g := &Graph{
		Root:  abs,
		Nodes: map[string]bool{abs: true},
		Edges: map[string][]string{},
	}
	module := readModulePath(abs)
	var goFiles []string

	err = filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == abs {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if strings.HasPrefix(name, ".") || name == "vendor" || name == "testdata" {
				return filepath.SkipDir
			}
			g.addNode(path, true)
			g.addEdge(filepath.Dir(path), path)
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil // never follow links: keeps the tree layer acyclic
		}
		if !d.Type().IsRegular() {
			return nil
		}
		g.addNode(path, false)
		g.addEdge(filepath.Dir(path), path)
		if strings.HasSuffix(name, ".go") {
			goFiles = append(goFiles, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	if module != "" {
		// Index Go files by the import path of their package directory.
		byImport := map[string][]string{}
		for _, f := range goFiles {
			rel, err := filepath.Rel(abs, filepath.Dir(f))
			if err != nil {
				continue
			}
			imp := module
			if rel != "." {
				imp = module + "/" + filepath.ToSlash(rel)
			}
			byImport[imp] = append(byImport[imp], f)
		}
		for _, f := range goFiles {
			for _, imp := range parseImports(f) {
				for _, dep := range byImport[imp] {
					if dep != f {
						g.addEdge(f, dep)
					}
				}
			}
		}
	}
	return g, nil
}

// addNode records a node; isDir is sticky (a path never changes kind).
func (g *Graph) addNode(path string, isDir bool) {
	g.Nodes[path] = isDir
}

// addEdge appends a successor, keeping edge lists deduplicated and sorted
// so in-degree counting and tests stay deterministic.
func (g *Graph) addEdge(from, to string) {
	edges := g.Edges[from]
	i := sort.SearchStrings(edges, to)
	if i < len(edges) && edges[i] == to {
		return
	}
	edges = append(edges, "")
	copy(edges[i+1:], edges[i:])
	edges[i] = to
	g.Edges[from] = edges
}

// Layers topologically sorts the graph with Kahn's algorithm and returns
// nodes grouped by level: layer 0 holds the roots (nothing points at
// them), and every edge points from an earlier layer to a strictly later
// one. Nodes within a layer are sorted and safe to process in parallel.
// A cycle — possible through crafted Go import cycles even though the
// containment layer cannot cycle — is reported as an error naming the
// remaining nodes instead of looping forever.
func (g *Graph) Layers() ([][]string, error) {
	indeg := make(map[string]int, len(g.Nodes))
	for n := range g.Nodes {
		indeg[n] = 0
	}
	for _, succs := range g.Edges {
		for _, s := range succs {
			indeg[s]++
		}
	}

	var current []string
	for n, d := range indeg {
		if d == 0 {
			current = append(current, n)
		}
	}
	sort.Strings(current)

	var layers [][]string
	done := 0
	for len(current) > 0 {
		layers = append(layers, current)
		done += len(current)
		var next []string
		for _, n := range current {
			for _, s := range g.Edges[n] {
				indeg[s]--
				if indeg[s] == 0 {
					next = append(next, s)
				}
			}
		}
		sort.Strings(next)
		current = next
	}
	if done != len(g.Nodes) {
		var remaining []string
		for n, d := range indeg {
			if d > 0 {
				remaining = append(remaining, n)
			}
		}
		sort.Strings(remaining)
		return nil, fmt.Errorf("dagfs: cycle detected involving %d node(s): %s",
			len(remaining), strings.Join(remaining, ", "))
	}
	return layers, nil
}

// readModulePath extracts the module path from the go.mod directly inside
// dir, or "" when there is none.
func readModulePath(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, "module"); ok {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}

// parseImports returns the import paths declared by one Go file. Files
// that fail to parse contribute no edges.
func parseImports(path string) []string {
	f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly|parser.SkipObjectResolution)
	if err != nil {
		return nil
	}
	imports := make([]string, 0, len(f.Imports))
	for _, spec := range f.Imports {
		imports = append(imports, strings.Trim(spec.Path.Value, `"`))
	}
	return imports
}
