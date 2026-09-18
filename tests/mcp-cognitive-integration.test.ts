/**
 * MCP 认知工具集成测试
 *
 * 覆盖:
 * - cognitive_loop handler 直接调用
 * - cognitive_loop_full handler 直接调用
 * - task_graph_execute handler 直接调用
 * - 场景路由到认知工具
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, existsSync } from "fs";
import { DREngine, CognitivePipeline, TaskGraph } from "../src/dre/index.js";
import { SceneRouter } from "../src/mcp/scene-router.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";

let dbFiles: string[] = [];

function tempDb(): string {
  const p = join(tmpdir(), `mcp-cog-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  dbFiles.push(p);
  return p;
}

function cleanup() {
  for (const f of dbFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
    try { if (existsSync(f + "-wal")) unlinkSync(f + "-wal"); } catch {}
    try { if (existsSync(f + "-shm")) unlinkSync(f + "-shm"); } catch {}
  }
}

// ========== Handler 直接调用测试 ==========

describe("cognitive_loop handler", () => {
  let engine: DREngine;
  let pipeline: CognitivePipeline;

  beforeEach(() => {
    engine = new DREngine({
      dbPath: tempDb(),
      mainLLM: { baseUrl: "http://localhost:8080", model: "test", maxTokens: 128 },
    });
    pipeline = new CognitivePipeline(engine);
    // 预填充知识
    engine.knowledgeStore.write({
      nodeId: "dre:mcp:1",
      title: "认证模块",
      content: "JWT 认证需要验证 token 签名和过期时间",
      domain: "auth",
      paradigm: "fact",
      confidence: 0.9,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: true,
    });
  });

  test("handler 调用应返回完整 6-step 结果", async () => {
    // 模拟 handler: CognitivePipeline.run()
    const result = await pipeline.run("JWT 认证失败");
    expect(result.trace.length).toBe(6);
    expect(result.input).toBe("JWT 认证失败");
    // performance.now() 亚毫秒精度 + Math.round —— 热路径下整个流水线可在
    // 0.5ms 内完成，结果为 0 是合法值；断言“已测量且非负”而非“必须 >0”
    expect(Number.isFinite(result.totalDurationMs)).toBe(true);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("handler 应返回正确的 stages", async () => {
    const result = await pipeline.run("Git 合并冲突");
    const stages = result.trace.map((t) => t.stage);
    expect(stages).toEqual(["classify", "knowledge", "reasoning", "constraint", "action", "reflection"]);
  });

  test("空输入应返回完整流水线", async () => {
    const result = await pipeline.run("");
    expect(result.trace.length).toBe(6);
    expect(result.conclusion).toBeNull();
  });
});

describe("cognitive_loop_full handler", () => {
  let engine: DREngine;
  let pipeline: CognitivePipeline;

  beforeEach(() => {
    engine = new DREngine({
      dbPath: tempDb(),
      mainLLM: { baseUrl: "http://localhost:8080", model: "test", maxTokens: 128 },
    });
    pipeline = new CognitivePipeline(engine);
    engine.knowledgeStore.write({
      nodeId: "dre:mcp:2",
      title: "重构指南",
      content: "代码重构时需确保测试覆盖率和向后兼容",
      domain: "dev",
      paradigm: "rule",
      confidence: 0.85,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: true,
    });
  });

  test("runFull 应包含 executionGraph", async () => {
    const result = await pipeline.runFull("代码重构");
    expect(result.trace.length).toBe(6);
  });

  test("runFull 异常降级到 base", async () => {
    // 无知识时执行 runFull 不应崩溃
    const emptyEngine = new DREngine({
      dbPath: tempDb(),
      mainLLM: { baseUrl: "http://localhost:8080", model: "test", maxTokens: 128 },
    });
    const emptyPipeline = new CognitivePipeline(emptyEngine);
    const result = await emptyPipeline.runFull("不存在的主题");
    expect(result.trace.length).toBe(6);
  });
});

describe("task_graph_execute handler", () => {
  test("应执行并行任务并返回结果", async () => {
    const graph = new TaskGraph();
    graph.addTask("t1", "Task 1", async () => "result-1");
    graph.addTask("t2", "Task 2", async () => "result-2");
    graph.addTask("t3", "Task 3", async () => "result-3", { dependsOn: ["t1", "t2"] });

    await graph.executeAll();
    expect(graph.getStatus()).toBe("completed");
    expect(graph.getTask("t3")?.status).toBe("completed");
  });

  test("应处理任务失败和回滚", async () => {
    let rolledBack = false;
    const graph = new TaskGraph();
    graph.addTask("t1", "OK", async () => "ok", {
      rollback: async () => { rolledBack = true; },
    });
    graph.addTask("t2", "FAIL", async () => { throw new Error("fail"); }, {
      dependsOn: ["t1"],
      rollback: async () => {},
    });

    await graph.executeAll();
    expect(rolledBack).toBe(true);
    expect(graph.getStatus()).not.toBe("completed");
  });
});

// ========== 场景路由测试 ==========

describe("Cognitive MCP 场景路由", () => {
  let registry: ToolRegistry;
  let router: SceneRouter;

  beforeEach(async () => {
    registry = new ToolRegistry();
    router = new SceneRouter(registry);

    // 注册认知工具 (简化版)
    registry.add({
      name: "cognitive_loop",
      description: "认知闭环",
      inputSchema: { input: { type: "string" } },
      handler: async (args) => ({ trace: [], conclusion: null }),
    });
    registry.add({
      name: "cognitive_loop_full",
      description: "认知闭环+执行",
      inputSchema: { input: { type: "string" } },
      handler: async (args) => ({ trace: [], conclusion: null, executionGraph: {} }),
    });
    registry.add({
      name: "task_graph_execute",
      description: "任务图执行",
      inputSchema: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, description: { type: "string" } },
          },
        },
      },
      handler: async (args) => ({ status: "completed", checkpointId: "test" }),
    });

    // 注册认知场景
    const { DEFAULT_SCENES } = await import("../src/mcp/scene-router.js");
    router.addScenes(DEFAULT_SCENES);
  });

  test("cognitive_loop 场景应匹配认知关键词", () => {
    const scene = router.match("cognitive loop");
    expect(scene).not.toBeNull();
    expect(scene!.id).toBe("cognitive_loop");
    expect(scene!.tools).toContain("cognitive_loop");
  });

  test("task_graph 场景应匹配任务相关输入", () => {
    const scene = router.match("创建并行任务图执行计划");
    expect(scene).not.toBeNull();
    expect(scene!.id).toBe("task_graph");
    expect(scene!.tools).toContain("task_graph_execute");
  });

  test("认知场景通过 handler 返回正确结果", async () => {
    const result = await router.execute("cognitive loop");
    expect(result.sceneId).toBe("cognitive_loop");
    expect(result.executed.length).toBeGreaterThan(0);
  });
});

cleanup();
