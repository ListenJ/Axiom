package pcda

import (
	"context"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestScaleOnceScalesUpUnderBacklog(t *testing.T) {
	cfg := testConfig()
	cfg.WorkersPerStage = 1
	cfg.MinWorkers = 1
	cfg.MaxWorkers = 4
	e := NewEngine(cfg, nil)

	block := make(chan struct{})
	e.SetHandler(StagePlan, func(ctx context.Context, cycles []*Cycle) error {
		<-block
		return nil
	})
	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() {
		close(block)
		e.Shutdown(ctx)
	}()

	// Build a backlog deeper than workers * watermark in the plan queue.
	time.Sleep(20 * time.Millisecond) // let the single worker grab one cycle
	for i := 0; i < 32; i++ {
		if err := e.Submit(&Cycle{ID: itoa(i)}); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}

	before := e.Stats().Stages["plan"].Workers
	e.scaleOnce()
	e.scaleOnce()
	after := e.Stats().Stages["plan"].Workers
	if after <= before {
		t.Fatalf("workers = %d before, %d after; want scale-up", before, after)
	}
	if bs := e.Stats().Stages["plan"].BatchSize; bs <= int64(cfg.BatchSize) {
		t.Fatalf("batch size = %d, want growth above %d under backlog", bs, cfg.BatchSize)
	}
}

func TestScaleOnceScalesDownWhenIdle(t *testing.T) {
	cfg := testConfig()
	cfg.WorkersPerStage = 4
	cfg.MinWorkers = 1
	cfg.MaxWorkers = 8
	e := NewEngine(cfg, nil)

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	// Idle engine: every iteration must shed one worker per stage until min.
	for i := 0; i < 5; i++ {
		e.scaleOnce()
	}
	for _, name := range []string{"plan", "do", "check", "act"} {
		if w := e.Stats().Stages[name].Workers; w != 1 {
			t.Fatalf("stage %s workers = %d, want min 1", name, w)
		}
	}
}

func TestScaleStageClampsToBounds(t *testing.T) {
	cfg := testConfig()
	cfg.MinWorkers = 2
	cfg.MaxWorkers = 6
	e := NewEngine(cfg, nil)
	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	if err := e.ScaleStage(StageDo, 100); err != nil {
		t.Fatalf("scale up: %v", err)
	}
	if w := e.Stats().Stages["do"].Workers; w != 6 {
		t.Fatalf("workers = %d, want clamped 6", w)
	}
	if err := e.ScaleStage(StageDo, 0); err != nil {
		t.Fatalf("scale down: %v", err)
	}
	if w := e.Stats().Stages["do"].Workers; w != 2 {
		t.Fatalf("workers = %d, want clamped 2", w)
	}
	if err := e.ScaleStage(StageDone, 3); err == nil {
		t.Fatal("scaling a terminal stage must fail")
	}
}

func TestMetricsRecorded(t *testing.T) {
	reg := prometheus.NewRegistry()
	e := NewEngine(testConfig(), reg)

	ctx := context.Background()
	if err := e.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer e.Shutdown(ctx)

	if err := e.Submit(&Cycle{ID: "m1"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	waitStatus(t, e, "m1", StatusCompleted)

	fams, err := reg.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	values := map[string]float64{}
	for _, f := range fams {
		for _, m := range f.GetMetric() {
			if m.GetCounter() != nil {
				values[f.GetName()] += m.GetCounter().GetValue()
			}
		}
	}
	if values["pcda_2pc_commits_total"] != 4 {
		t.Fatalf("2pc commits = %v, want 4 (one per stage transition)", values["pcda_2pc_commits_total"])
	}
	if values["pcda_cycles_completed_total"] != 1 {
		t.Fatalf("completed = %v, want 1", values["pcda_cycles_completed_total"])
	}
	if values["pcda_requests_total"] < 1 {
		t.Fatalf("module requests = %v, want >= 1", values["pcda_requests_total"])
	}

	// Per-stage processed counters must cover every stage.
	seen := map[string]bool{}
	for _, f := range fams {
		if f.GetName() != "pcda_stage_processed_total" {
			continue
		}
		for _, m := range f.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetName() == "stage" {
					seen[l.GetValue()] = true
				}
			}
		}
	}
	for _, name := range []string{"plan", "do", "check", "act"} {
		if !seen[name] {
			t.Fatalf("no processed counter for stage %s", name)
		}
	}
}
