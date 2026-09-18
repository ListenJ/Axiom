package dagfs

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"
)

// Stats summarizes one Prefetch run.
type Stats struct {
	Files    int           // number of files read
	Bytes    int64         // total bytes read
	Duration time.Duration // wall-clock time including Build and layering
}

// Prefetch builds the DAG for root, layers it, and reads every regular
// file layer by layer: files within a layer are fetched in parallel by a
// worker pool of size concurrency, while layers are processed in
// topological order so a batch's reads land together on disk. It returns
// the file contents keyed by absolute path along with read statistics.
//
// A concurrency <= 0 defaults to runtime.NumCPU(). A cycle in the graph
// (e.g. a crafted Go import cycle) aborts the prefetch with an error
// before any file is read.
func Prefetch(root string, concurrency int) (map[string][]byte, Stats, error) {
	start := time.Now()
	if concurrency <= 0 {
		concurrency = runtime.NumCPU()
	}
	g, err := Build(root)
	if err != nil {
		return nil, Stats{}, err
	}
	layers, err := g.Layers()
	if err != nil {
		return nil, Stats{}, err
	}

	contents := make(map[string][]byte, len(g.Nodes))
	var stats Stats
	var mu sync.Mutex

	sem := make(chan struct{}, concurrency)
	for _, layer := range layers {
		var wg sync.WaitGroup
		var firstErr error
		var errOnce sync.Once
		for _, path := range layer {
			if g.Nodes[path] {
				continue // directories are ordering scaffolding, not read
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(p string) {
				defer wg.Done()
				defer func() { <-sem }()
				data, err := os.ReadFile(p)
				if err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
				mu.Lock()
				contents[p] = data
				stats.Bytes += int64(len(data))
				mu.Unlock()
			}(path)
		}
		wg.Wait()
		if firstErr != nil {
			return nil, Stats{}, fmt.Errorf("dagfs: prefetch: %w", firstErr)
		}
	}
	stats.Files = len(contents)
	stats.Duration = time.Since(start)
	return contents, stats, nil
}
