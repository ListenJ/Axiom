package agent

import (
	"fmt"
	"testing"
)

// BenchmarkSubmit measures scheduler dispatch throughput (tasks/sec) with a
// fixed pool of agents and ample quota.
func BenchmarkSubmit(b *testing.B) {
	s := NewScheduler(NewAccountingLimiter(), nil)
	for i := 0; i < 16; i++ {
		s.AddAgent(fmt.Sprintf("agent-%d", i), ResourceQuota{MemoryBytes: 1 << 40, CPUCores: 1 << 20})
	}
	task := schedTask("bench", 2.5)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, queued, err := s.Submit(task); err != nil || queued {
			b.Fatalf("Submit: queued=%v err=%v", queued, err)
		}
	}
}

// BenchmarkSubmitWithCompletion measures the full schedule → complete cycle
// (including queue drain and EMA update), approximating sustained task
// throughput.
func BenchmarkSubmitWithCompletion(b *testing.B) {
	s := NewScheduler(NewAccountingLimiter(), nil)
	for i := 0; i < 16; i++ {
		s.AddAgent(fmt.Sprintf("agent-%d", i), ResourceQuota{MemoryBytes: 1 << 40, CPUCores: 1 << 20})
	}
	task := schedTask("bench", 2.5)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		agentID, queued, err := s.Submit(task)
		if err != nil || queued {
			b.Fatalf("Submit: queued=%v err=%v", queued, err)
		}
		s.OnTaskCompleted(agentID, task, 2.4, 1<<20)
	}
}
