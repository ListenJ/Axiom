/**
 * 深度测试: DRE Engine + Memory 系统边缘
 */
import { describe, it, expect } from "bun:test";

// ─── ConstraintSolver ────────────────────────────────────────────

describe("ConstraintSolver 边界", () => {
  it("空求解器 check 返回 satisfied", async () => {
    const { ConstraintSolver } = await import("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    const r = s.check("any");
    expect(r.satisfied).toBeTrue();
    expect(r.violations).toBeEmpty();
  });

  it("disabled 约束被跳过", async () => {
    const { ConstraintSolver } = await import("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.register({
      id: "test", dimension: "logical", type: "requires",
      name: "test", description: "",
      subject: "action", target: "missing_dep",
      priority: 1, enabled: false,
      createdAt: Date.now(),
    });
    const r = s.check("action");
    expect(r.satisfied).toBeTrue();
  });

  it("physical min_value 约束", async () => {
    const { ConstraintSolver } = await import("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.register({
      id: "mem", dimension: "physical", type: "min_value",
      name: "memory", description: "需要 >= 500MB",
      subject: "available_memory_mb",
      params: { min: 500 },
      priority: 1, enabled: true,
      createdAt: Date.now(),
    });
    // 不提供上下文 → 跳过
    expect(s.check("any").satisfied).toBeTrue();
    // 提供上下文但不足
    const r = s.check("any", { available_memory_mb: 100 });
    expect(r.satisfied).toBeFalse();
    expect(r.violations.length).toBe(1);
    // 足够
    expect(s.check("any", { available_memory_mb: 1000 }).satisfied).toBeTrue();
  });

  it("field_match equals / not_equals", async () => {
    const { ConstraintSolver } = await import("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.register({
      id: "eq", dimension: "field_match", type: "equals",
      name: "", description: "",
      subject: "role", target: "admin",
      priority: 1, enabled: true,
      createdAt: Date.now(),
    });
    expect(s.check("x", { role: "admin" }).satisfied).toBeTrue();
    expect(s.check("x", { role: "user" }).satisfied).toBeFalse();
  });

  it("selectBest 选择违规最少的候选", async () => {
    const { ConstraintSolver } = await import("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.register({
      id: "no-write", dimension: "policy", type: "not_equals",
      name: "", description: "",
      subject: "action", target: "write",
      priority: 10, enabled: true,
      createdAt: Date.now(),
    });
    const r = s.selectBest(["read", "write"]);
    expect(r.selected).toBe("read");
  });

  it("getStats 统计正确", async () => {
    const { createDefaultConstraintSolver } = await import("../src/dre/constraint/solver.js");
    const s = createDefaultConstraintSolver();
    const stats = s.getStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.enabled + stats.disabled).toBe(stats.total);
  });

  it("listByDimension 过滤正确", async () => {
    const { ConstraintSolver } = await import("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.register({ id: "a", dimension: "logical", type: "requires", name: "", description: "", subject: "", priority: 1, enabled: true, createdAt: 0 });
    s.register({ id: "b", dimension: "physical", type: "min_value", name: "", description: "", subject: "", params: { min: 1 }, priority: 1, enabled: true, createdAt: 0 });
    expect(s.listByDimension("logical")).toHaveLength(1);
    expect(s.listByDimension("physical")).toHaveLength(1);
    expect(s.listByDimension("temporal")).toBeEmpty();
  });
});

// ─── Archiver 跨平台 ├───

describe("Archiver parseFrontmatter 跨平台", () => {
  it("解析 \\r\\n frontmatter", async () => {
    const { MemoryArchiver } = await import("../src/memory/archiver.js");
    const archiver = new (MemoryArchiver as any)("./.tmp-test-archiver");
    const normal = archiver.parseFrontmatter("---\r\nkey: value\r\n---\r\nbody text");
    expect(normal.frontmatter).toHaveProperty("key", "value");
    expect(normal.body).toBe("body text");
  });

  it("解析 \\n frontmatter", async () => {
    const { MemoryArchiver } = await import("../src/memory/archiver.js");
    const archiver = new (MemoryArchiver as any)("./.tmp-test-archiver");
    const normal = archiver.parseFrontmatter("---\nkey: value\n---\nbody text");
    expect(normal.frontmatter).toHaveProperty("key", "value");
    expect(normal.body).toBe("body text");
  });

  it("无 frontmatter 时不崩溃", async () => {
    const { MemoryArchiver } = await import("../src/memory/archiver.js");
    const archiver = new (MemoryArchiver as any)("./.tmp-test-archiver");
    const r = archiver.parseFrontmatter("just text");
    expect(r.frontmatter).toBeEmpty();
    expect(r.body).toBe("just text");
  });
});

// ─── Distiller ───────────────────────────────────────────────────

describe("Distiller safeHostname 边界", () => {
  it("无效 URL 不崩溃", async () => {
    const { safeHostname } = await import("../src/memory/distiller.js");
    expect(safeHostname("localhost")).toBe("localhost");
    expect(safeHostname("example.com/foo")).toBe("example.com");
    expect(safeHostname("not a url")).toBe("not a url");
    expect(safeHostname("")).toBe("");
  });

  it("有效 URL 正常", async () => {
    const { safeHostname } = await import("../src/memory/distiller.js");
    expect(safeHostname("https://example.com/path")).toBe("example.com");
    expect(safeHostname("http://sub.example.com:8080/path")).toBe("sub.example.com");
  });
});

// ─── EventBus 边界 ────────────────────────────────────────────────

describe("EventBus 边界", () => {
  it("publish 无订阅者不崩溃", async () => {
    const { eventBus } = await import("../src/dre/runtime/event-bus.js");
    eventBus.publish({ type: "test.no.subscriber", source: "test", data: {}, priority: "normal" });
  });

  it("订阅/取消订阅/再次触发", async () => {
    const { eventBus } = await import("../src/dre/runtime/event-bus.js");
    let called = false;
    const id = eventBus.subscribe("test.unsub", () => { called = true; });
    eventBus.unsubscribe(id);
    eventBus.publish({ type: "test.unsub", source: "test", data: {}, priority: "normal" });
    expect(called).toBeFalse();
  });

  it("subscribeOnce 一次性订阅", async () => {
    const { eventBus } = await import("../src/dre/runtime/event-bus.js");
    let count = 0;
    eventBus.subscribeOnce("test.once", () => { count++; });
    eventBus.publish({ type: "test.once", source: "test", data: {}, priority: "normal" });
    eventBus.publish({ type: "test.once", source: "test", data: {}, priority: "normal" });
    expect(count).toBe(1);
  });
});

// ─── WorldState 边界 ──────────────────────────────────────────────

describe("WorldState 边界", () => {
  it("get/set 基础", async () => {
    const { worldState } = await import("../src/dre/runtime/world-state.js");
    worldState.set("test.key", "value");
    expect(worldState.get<string>("test.key")).toBe("value");
  });

  it("get 不存在的 key 返回 undefined", async () => {
    const { worldState } = await import("../src/dre/runtime/world-state.js");
    expect(worldState.get("nonexistent")).toBeUndefined();
  });

  it("update 使用回调", async () => {
    const { worldState } = await import("../src/dre/runtime/world-state.js");
    worldState.update<{ count: number }>("update.test", (prev) => ({ count: ((prev as any)?.count || 0) + 1 }));
    const r = worldState.get<{ count: number }>("update.test");
    expect(r).toHaveProperty("count", 1);
    worldState.update<{ count: number }>("update.test", (prev) => ({ count: ((prev as any)?.count || 0) + 1 }));
    const r2 = worldState.get<{ count: number }>("update.test");
    expect(r2).toHaveProperty("count", 2);
  });
});
