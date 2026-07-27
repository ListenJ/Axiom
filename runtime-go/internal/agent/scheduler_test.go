package agent

import (
	"math"
	"math/rand"
	"testing"
)

func TestPredictorEMA(t *testing.T) {
	p := NewPredictor(0.5)
	if p.Samples() != 0 || p.Duration() != 0 {
		t.Fatalf("empty predictor: samples=%d dur=%v", p.Samples(), p.Duration())
	}
	p.Observe(10, 100)
	if p.Duration() != 10 || p.Memory() != 100 {
		t.Fatalf("first sample initializes EMA: %+v", p)
	}
	p.Observe(20, 300)
	// alpha=0.5: dur = 0.5*20+0.5*10 = 15, mem = 0.5*300+0.5*100 = 200
	if p.Duration() != 15 || p.Memory() != 200 {
		t.Fatalf("EMA dur=%v mem=%v, want 15/200", p.Duration(), p.Memory())
	}
	if p.Samples() != 2 {
		t.Fatalf("samples = %d, want 2", p.Samples())
	}
}

func TestPredictorConverges(t *testing.T) {
	p := NewPredictor(0.3)
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 500; i++ {
		p.Observe(5+rng.Float64()*2, 0) // mean 6
	}
	if math.Abs(p.Duration()-6) > 0.2 {
		t.Fatalf("EMA duration = %v, want ≈6", p.Duration())
	}
}

func schedTask(id string, dur float64) Task {
	return Task{
		ID:              id,
		DefName:         "def",
		Version:         1,
		EstimateSeconds: dur,
		Resources:       ResourceRequirements{MemoryBytes: 1 << 20, CPUCores: 0.1},
	}
}

func TestSchedulerLeastLoaded(t *testing.T) {
	s := NewScheduler(NewAccountingLimiter(), NewMetrics(nil))
	for _, id := range []string{"a", "b", "c"} {
		if err := s.AddAgent(id, ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 8}); err != nil {
			t.Fatalf("AddAgent: %v", err)
		}
	}
	// First task goes to some agent; second must go to a different one
	// because the first agent now carries load.
	got := map[string]int{}
	for i := 0; i < 6; i++ {
		agentID, queued, err := s.Submit(schedTask("t"+string(rune('0'+i)), 5))
		if err != nil || queued {
			t.Fatalf("Submit: agent=%q queued=%v err=%v", agentID, queued, err)
		}
		got[agentID]++
	}
	for _, id := range []string{"a", "b", "c"} {
		if got[id] != 2 {
			t.Fatalf("agent %s got %d tasks, want 2 (spread: %v)", id, got[id], got)
		}
	}
	if n := s.QueueLen(); n != 0 {
		t.Fatalf("QueueLen = %d, want 0", n)
	}
}

func TestSchedulerQueuesWhenOverQuota(t *testing.T) {
	s := NewScheduler(NewAccountingLimiter(), NewMetrics(nil))
	s.AddAgent("a", ResourceQuota{MemoryBytes: 100 << 20, CPUCores: 1})

	big := schedTask("t1", 5)
	big.Resources = ResourceRequirements{MemoryBytes: 80 << 20, CPUCores: 0.5}
	if _, queued, err := s.Submit(big); err != nil || queued {
		t.Fatalf("first submit queued=%v err=%v", queued, err)
	}
	if _, queued, err := s.Submit(big); err != nil || !queued {
		t.Fatalf("second submit should be queued, queued=%v err=%v", queued, err)
	}
	if n := s.QueueLen(); n != 1 {
		t.Fatalf("QueueLen = %d, want 1", n)
	}

	// Completing the running task frees quota and drains the queue.
	s.OnTaskCompleted("a", big, 5, float64(80<<20))
	if n := s.QueueLen(); n != 0 {
		t.Fatalf("QueueLen after drain = %d, want 0", n)
	}
	infos := s.Agents()
	if len(infos) != 1 || infos[0].Tasks != 1 {
		t.Fatalf("agent tasks after drain = %+v", infos)
	}
}

func TestSchedulerBalanceSimulation(t *testing.T) {
	const numAgents = 8
	const numTasks = 800

	s := NewScheduler(NewAccountingLimiter(), NewMetrics(nil))
	for i := 0; i < numAgents; i++ {
		id := "agent-" + string(rune('a'+i))
		if err := s.AddAgent(id, ResourceQuota{MemoryBytes: 1 << 40, CPUCores: 1 << 20}); err != nil {
			t.Fatalf("AddAgent: %v", err)
		}
	}

	rng := rand.New(rand.NewSource(7))
	for i := 0; i < numTasks; i++ {
		dur := 1 + rng.Float64()*9 // uniform in [1,10)
		_, queued, err := s.Submit(schedTask("task-"+string(rune(i)), dur))
		if err != nil || queued {
			t.Fatalf("Submit %d: queued=%v err=%v", i, queued, err)
		}
	}

	var min, max, sum float64
	min = math.Inf(1)
	for _, info := range s.Agents() {
		if info.Load < min {
			min = info.Load
		}
		if info.Load > max {
			max = info.Load
		}
		sum += info.Load
	}
	avg := sum / numAgents
	spread := (max - min) / avg
	t.Logf("load spread: min=%.1f max=%.1f avg=%.1f spread=%.4f", min, max, avg, spread)
	if spread > 0.10 {
		t.Fatalf("load spread %.4f exceeds 10%%", spread)
	}
}

func TestSchedulerCompletionUpdatesPrediction(t *testing.T) {
	s := NewScheduler(NewAccountingLimiter(), NewMetrics(nil))
	s.AddAgent("a", ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 8})

	task := schedTask("t1", 10)
	s.Submit(task)
	// Actual run took 3s and 12MiB; predictor must learn from it.
	s.OnTaskCompleted("a", task, 3, 12<<20)

	infos := s.Agents()
	if len(infos) != 1 {
		t.Fatalf("Agents len = %d", len(infos))
	}
	if infos[0].Tasks != 0 {
		t.Fatalf("Tasks = %d, want 0", infos[0].Tasks)
	}
	if infos[0].PredictedDuration != 3 {
		t.Fatalf("PredictedDuration = %v, want 3", infos[0].PredictedDuration)
	}
	if infos[0].PredictedMemory != 12<<20 {
		t.Fatalf("PredictedMemory = %v, want %v", infos[0].PredictedMemory, float64(12<<20))
	}
	// Limiter usage released.
	if u := s.limiter.Usage("a"); u.MemoryBytes != 0 {
		t.Fatalf("limiter usage after completion = %+v", u)
	}
}

func TestSchedulerRemoveAgent(t *testing.T) {
	s := NewScheduler(NewAccountingLimiter(), NewMetrics(nil))
	s.AddAgent("a", ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 8})
	s.AddAgent("b", ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 8})
	if err := s.RemoveAgent("a"); err != nil {
		t.Fatalf("RemoveAgent: %v", err)
	}
	if got := len(s.Agents()); got != 1 {
		t.Fatalf("Agents len = %d, want 1", got)
	}
	// All tasks must land on b now.
	id, _, _ := s.Submit(schedTask("t", 1))
	if id != "b" {
		t.Fatalf("task went to %q, want b", id)
	}
}
