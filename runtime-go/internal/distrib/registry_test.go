package distrib

import "testing"

func testNodes() []Node {
	return []Node{
		{ID: "n1", Addr: "http://10.0.0.1:9103", Role: "primary"},
		{ID: "n2", Addr: "http://10.0.0.2:9103", Role: "replica"},
		{ID: "n3", Addr: "http://10.0.0.3:9103", Role: "replica"},
	}
}

func TestRegistry_SelfAndOthers(t *testing.T) {
	r := NewRegistry(testNodes(), "n1")
	if self := r.Self(); self.ID != "n1" || self.Addr != "http://10.0.0.1:9103" {
		t.Fatalf("unexpected self: %+v", self)
	}
	others := r.Others()
	if len(others) != 2 {
		t.Fatalf("expected 2 others, got %d", len(others))
	}
	for _, o := range others {
		if o.ID == "n1" {
			t.Fatalf("others must not contain self: %+v", others)
		}
	}
}

func TestRegistry_HealthyDefaultsAndMarking(t *testing.T) {
	r := NewRegistry(testNodes(), "n1")

	// Every node starts healthy.
	healthy := r.Healthy()
	if len(healthy) != 3 {
		t.Fatalf("expected 3 healthy nodes, got %d", len(healthy))
	}
	if !r.IsHealthy("n2") {
		t.Fatal("n2 should be healthy initially")
	}

	r.MarkUnhealthy("n2")
	if r.IsHealthy("n2") {
		t.Fatal("n2 should be unhealthy after MarkUnhealthy")
	}
	healthy = r.Healthy()
	if len(healthy) != 2 {
		t.Fatalf("expected 2 healthy nodes, got %d", len(healthy))
	}
	for _, n := range healthy {
		if n.ID == "n2" {
			t.Fatalf("n2 should not be in healthy list: %+v", healthy)
		}
	}

	r.MarkHealthy("n2")
	if !r.IsHealthy("n2") {
		t.Fatal("n2 should be healthy after MarkHealthy")
	}
	if got := len(r.Healthy()); got != 3 {
		t.Fatalf("expected 3 healthy nodes, got %d", got)
	}
}

func TestRegistry_UnknownID(t *testing.T) {
	r := NewRegistry(testNodes(), "n1")
	if r.IsHealthy("ghost") {
		t.Fatal("unknown node must not be healthy")
	}
	// Marking an unknown node must not panic.
	r.MarkUnhealthy("ghost")
	r.MarkHealthy("ghost")
	if r.IsHealthy("ghost") {
		t.Fatal("unknown node must stay unhealthy after marking")
	}
}

func TestRegistry_SelfNotInList(t *testing.T) {
	r := NewRegistry(testNodes(), "ghost")
	if self := r.Self(); self.ID != "" {
		t.Fatalf("expected zero self, got %+v", self)
	}
	if got := len(r.Others()); got != 3 {
		t.Fatalf("expected all 3 nodes as others, got %d", got)
	}
}
