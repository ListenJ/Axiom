package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestCluster(t *testing.T) *Cluster {
	t.Helper()
	c, err := NewCluster(ClusterConfig{
		NodeID:        "test-node",
		InitialAgents: 2,
		AgentQuota:    ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 4},
		Autoscale: AutoscalerConfig{
			MinAgents: 1, MaxAgents: 4,
			QueuePerAgent: 2, ScaleUpUtilization: 0.8, ScaleDownUtilization: 0.2,
		},
	})
	if err != nil {
		t.Fatalf("NewCluster: %v", err)
	}
	return c
}

func TestClusterSubmitTaskEndToEnd(t *testing.T) {
	c := newTestCluster(t)
	if _, err := c.Store.Put(testDef("crawler")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	task, res, queued, err := c.SubmitTask(context.Background(), "crawler", 0, map[string]string{"url": "x"})
	if err != nil {
		t.Fatalf("SubmitTask: %v", err)
	}
	if queued {
		t.Fatal("task should run immediately with capacity available")
	}
	if task.Version != 1 || res.TaskID != task.ID {
		t.Fatalf("task=%+v res=%+v", task, res)
	}

	// Pinned version run after an update: still resolves v1 content.
	d2 := testDef("crawler")
	d2.Resources.MemoryBytes = 32 << 20
	if _, err := c.Store.Put(d2); err != nil {
		t.Fatalf("Put v2: %v", err)
	}
	t1, _, _, err := c.SubmitTask(context.Background(), "crawler", 1, nil)
	if err != nil {
		t.Fatalf("SubmitTask v1: %v", err)
	}
	if t1.Version != 1 || t1.Resources.MemoryBytes != 64<<20 {
		t.Fatalf("pinned task = %+v", t1)
	}

	if _, _, _, err := c.SubmitTask(context.Background(), "missing", 0, nil); !errors.Is(err, ErrTaskDefNotFound) {
		t.Fatalf("missing def err = %v", err)
	}
}

func TestClusterTaskRetryMetric(t *testing.T) {
	c := newTestCluster(t)
	failFirst := true
	// The first Run on the process handling our task fails once,
	// exercising the retry layer.
	def := testDef("flaky")
	def.Idempotent = true
	c.Store.Put(def)

	flaky := &flakyProc{inner: NewFakeAgent("flaky"), failFirst: &failFirst}
	c.Health.Add(flaky)
	c.Scheduler.AddAgent("flaky", ResourceQuota{MemoryBytes: 1 << 30, CPUCores: 4})
	// Remove the two default agents so the task must land on "flaky".
	for _, info := range c.Scheduler.Agents() {
		if info.ID != "flaky" {
			c.Health.Remove(info.ID)
			c.Scheduler.RemoveAgent(info.ID)
		}
	}

	_, _, _, err := c.SubmitTask(context.Background(), "flaky", 0, nil)
	if err != nil {
		t.Fatalf("SubmitTask with retry: %v", err)
	}
}

type flakyProc struct {
	inner     *FakeAgent
	failFirst *bool
}

func (f *flakyProc) ID() string                     { return f.inner.ID() }
func (f *flakyProc) Ping(ctx context.Context) error { return f.inner.Ping(ctx) }
func (f *flakyProc) Stop(ctx context.Context) error { return f.inner.Stop(ctx) }
func (f *flakyProc) Run(ctx context.Context, t Task) (TaskResult, error) {
	if *f.failFirst {
		*f.failFirst = false
		return TaskResult{}, errors.New("transient")
	}
	return f.inner.Run(ctx, t)
}

func TestClusterAutoscaleIntegration(t *testing.T) {
	c := newTestCluster(t)
	// Saturate both agents' CPU quota (0.9 utilization each) so the
	// controller scales the pool up from 2 to 3.
	for i := 0; i < 2; i++ {
		task := schedTask(fmt.Sprintf("sat-%d", i), 10)
		task.Resources = ResourceRequirements{MemoryBytes: 1 << 20, CPUCores: 3.6}
		if _, queued, err := c.Scheduler.Submit(task); err != nil || queued {
			t.Fatalf("saturating submit: queued=%v err=%v", queued, err)
		}
	}
	if act := c.EvaluateAutoscale(); act != ScaleUp {
		t.Fatalf("action = %v, want up", act)
	}
	if got := len(c.Scheduler.Agents()); got != 3 {
		t.Fatalf("agents = %d, want 3", got)
	}
}

func TestHTTPAPI(t *testing.T) {
	c := newTestCluster(t)
	h := NewHandler(c)

	// Create a definition.
	body := `{"name":"crawler","type":"http","resources":{"memory_bytes":1048576,"cpu_cores":0.5},"idempotent":true}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/task-defs", strings.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /task-defs = %d: %s", rec.Code, rec.Body)
	}

	// Update it (second version).
	body2 := `{"name":"crawler","type":"http","resources":{"memory_bytes":2097152,"cpu_cores":1}}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/task-defs", strings.NewReader(body2)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("update = %d", rec.Code)
	}

	// Versions endpoint shows both.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/task-defs/crawler/versions", nil))
	var versions []TaskDefVersion
	if err := json.NewDecoder(rec.Body).Decode(&versions); err != nil || len(versions) != 2 {
		t.Fatalf("versions = %v, err=%v", versions, err)
	}

	// Rollback to v1.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/task-defs/crawler/rollback", strings.NewReader(`{"version":1}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("rollback = %d: %s", rec.Code, rec.Body)
	}
	var v TaskDefVersion
	json.NewDecoder(rec.Body).Decode(&v)
	if v.Version != 3 || v.Def.Resources.MemoryBytes != 1048576 {
		t.Fatalf("rollback version = %+v", v)
	}

	// Submit a task.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/tasks", strings.NewReader(`{"def_name":"crawler"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /tasks = %d: %s", rec.Code, rec.Body)
	}

	// Agents and cluster status.
	for path, want := range map[string]int{
		"/agents": http.StatusOK, "/cluster": http.StatusOK,
		"/healthz": http.StatusOK, "/metrics": http.StatusOK,
		"/task-defs": http.StatusOK,
	} {
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Fatalf("GET %s = %d, want %d", path, rec.Code, want)
		}
	}

	// Unknown definition → 404.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/tasks", strings.NewReader(`{"def_name":"ghost"}`)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown def = %d, want 404", rec.Code)
	}
}
