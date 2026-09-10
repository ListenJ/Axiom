package pcda

import "testing"

func TestStageOrder(t *testing.T) {
	if StagePlan.Next() != StageDo || StageDo.Next() != StageCheck ||
		StageCheck.Next() != StageAct || StageAct.Next() != StageDone {
		t.Fatalf("bad stage order: plan=%v do=%v check=%v act=%v",
			StagePlan.Next(), StageDo.Next(), StageCheck.Next(), StageAct.Next())
	}
}

func TestLaneQueuePriorityOrder(t *testing.T) {
	q := newLaneQueue(16)
	low := &Cycle{ID: "low", Priority: PriorityLow}
	normal := &Cycle{ID: "normal", Priority: PriorityNormal}
	high := &Cycle{ID: "high", Priority: PriorityHigh}

	// Enqueue low first; high must still come out first.
	q.Enqueue(low)
	q.Enqueue(normal)
	q.Enqueue(high)

	want := []string{"high", "normal", "low"}
	for _, id := range want {
		c, ok := q.Dequeue()
		if !ok || c.ID != id {
			t.Fatalf("dequeue: got %v ok=%v, want %s", c, ok, id)
		}
	}
	if _, ok := q.Dequeue(); ok {
		t.Fatal("dequeue on drained queue must fail")
	}
}

func TestLaneQueueFIFOWithinSamePriority(t *testing.T) {
	q := newLaneQueue(16)
	for _, id := range []string{"a", "b", "c"} {
		q.Enqueue(&Cycle{ID: id, Priority: PriorityNormal})
	}
	for _, id := range []string{"a", "b", "c"} {
		c, ok := q.Dequeue()
		if !ok || c.ID != id {
			t.Fatalf("got %v ok=%v, want %s", c, ok, id)
		}
	}
}

func TestLaneQueueFullAppliesBackpressure(t *testing.T) {
	q := newLaneQueue(2)
	if !q.Enqueue(&Cycle{ID: "1", Priority: PriorityHigh}) ||
		!q.Enqueue(&Cycle{ID: "2", Priority: PriorityHigh}) {
		t.Fatal("enqueue below capacity must succeed")
	}
	if q.Enqueue(&Cycle{ID: "3", Priority: PriorityHigh}) {
		t.Fatal("enqueue beyond lane capacity must fail (backpressure)")
	}
	if q.Len() != 2 {
		t.Fatalf("len = %d, want 2", q.Len())
	}
}

func TestLaneQueueLenAcrossLanes(t *testing.T) {
	q := newLaneQueue(8)
	q.Enqueue(&Cycle{ID: "h", Priority: PriorityHigh})
	q.Enqueue(&Cycle{ID: "n", Priority: PriorityNormal})
	q.Enqueue(&Cycle{ID: "l", Priority: PriorityLow})
	if q.Len() != 3 {
		t.Fatalf("len = %d, want 3", q.Len())
	}
}
