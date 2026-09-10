package agent

import (
	"testing"
)

func TestSchedulerSetAvailable(t *testing.T) {
	s := NewScheduler(NewPlatformLimiter(), NewMetrics(nil))
	if err := s.AddAgent("a1", ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 4}); err != nil {
		t.Fatalf("AddAgent: %v", err)
	}

	// Newly added agents are available.
	infos := s.Agents()
	if len(infos) != 1 || !infos[0].Available {
		t.Fatalf("agents = %+v, want a1 available", infos)
	}

	// Marking the only agent unavailable queues new tasks instead of placing them.
	s.SetAvailable("a1", false)
	if _, queued, err := s.Submit(schedTask("t1", 1)); err != nil || !queued {
		t.Fatalf("submit on unavailable agent: queued=%v err=%v, want queued", queued, err)
	}
	if got := s.Agents()[0].Available; got {
		t.Fatal("a1 should report unavailable")
	}

	// Re-enabling the agent drains the pending queue through OnDispatch.
	var dispatched []string
	s.OnDispatch = func(agentID string, task Task) {
		dispatched = append(dispatched, agentID+":"+task.ID)
	}
	s.SetAvailable("a1", true)
	if len(dispatched) != 1 || dispatched[0] != "a1:t1" {
		t.Fatalf("dispatched = %v, want [a1:t1]", dispatched)
	}
	if s.QueueLen() != 0 {
		t.Fatalf("queue = %d, want 0", s.QueueLen())
	}

	// Unknown IDs are ignored.
	s.SetAvailable("ghost", false)
}
