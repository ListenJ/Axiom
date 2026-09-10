package agent

import (
	"testing"
	"time"
)

func testScaler(now *time.Time) (*Autoscaler, *[]int) {
	var applied []int
	a := NewAutoscaler(AutoscalerConfig{
		MinAgents:            2,
		MaxAgents:            5,
		Cooldown:             time.Minute,
		QueuePerAgent:        2,
		ScaleUpUtilization:   0.8,
		ScaleDownUtilization: 0.2,
	}, func(delta int) { applied = append(applied, delta) }, NewMetrics(nil))
	a.now = func() time.Time { return *now }
	return a, &applied
}

func TestAutoscalerScaleUpOnQueue(t *testing.T) {
	now := time.Now()
	a, applied := testScaler(&now)
	// 3 agents, queue of 7 > 3*2 → scale up.
	if act := a.EvaluateAndApply(ScaleInput{Agents: 3, QueueLen: 7, Utilization: 0.3}); act != ScaleUp {
		t.Fatalf("action = %v, want up", act)
	}
	if len(*applied) != 1 || (*applied)[0] != 1 {
		t.Fatalf("applied = %v", *applied)
	}
}

func TestAutoscalerScaleUpOnUtilization(t *testing.T) {
	now := time.Now()
	a, _ := testScaler(&now)
	if act := a.EvaluateAndApply(ScaleInput{Agents: 3, QueueLen: 0, Utilization: 0.9}); act != ScaleUp {
		t.Fatalf("action = %v, want up", act)
	}
}

func TestAutoscalerScaleDown(t *testing.T) {
	now := time.Now()
	a, applied := testScaler(&now)
	if act := a.EvaluateAndApply(ScaleInput{Agents: 4, QueueLen: 0, Utilization: 0.1}); act != ScaleDown {
		t.Fatalf("action = %v, want down", act)
	}
	if len(*applied) != 1 || (*applied)[0] != -1 {
		t.Fatalf("applied = %v", *applied)
	}
}

func TestAutoscalerRespectsBounds(t *testing.T) {
	now := time.Now()
	a, applied := testScaler(&now)
	if act := a.EvaluateAndApply(ScaleInput{Agents: 5, QueueLen: 100, Utilization: 1}); act != ScaleNone {
		t.Fatalf("at max agents action = %v, want none", act)
	}
	if act := a.EvaluateAndApply(ScaleInput{Agents: 2, QueueLen: 0, Utilization: 0}); act != ScaleNone {
		t.Fatalf("at min agents action = %v, want none", act)
	}
	if len(*applied) != 0 {
		t.Fatalf("applied = %v, want empty", *applied)
	}
}

func TestAutoscalerCooldown(t *testing.T) {
	now := time.Now()
	a, applied := testScaler(&now)

	if act := a.EvaluateAndApply(ScaleInput{Agents: 3, QueueLen: 7, Utilization: 0.3}); act != ScaleUp {
		t.Fatalf("first action = %v, want up", act)
	}
	// Inside the cooldown window the same pressure is ignored.
	now = now.Add(30 * time.Second)
	if act := a.EvaluateAndApply(ScaleInput{Agents: 4, QueueLen: 9, Utilization: 0.3}); act != ScaleNone {
		t.Fatalf("during cooldown action = %v, want none", act)
	}
	// After the cooldown it scales again.
	now = now.Add(31 * time.Second)
	if act := a.EvaluateAndApply(ScaleInput{Agents: 4, QueueLen: 9, Utilization: 0.3}); act != ScaleUp {
		t.Fatalf("after cooldown action = %v, want up", act)
	}
	if len(*applied) != 2 {
		t.Fatalf("applied = %v, want 2 entries", *applied)
	}
}

func TestAutoscalerSteadyState(t *testing.T) {
	now := time.Now()
	a, _ := testScaler(&now)
	if act := a.EvaluateAndApply(ScaleInput{Agents: 3, QueueLen: 4, Utilization: 0.5}); act != ScaleNone {
		t.Fatalf("steady state action = %v, want none", act)
	}
}
