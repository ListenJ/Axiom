/**
 * DRE MCP 工具行为安全网（内核收敛 Step 2b-ii 前置）。
 *
 * 为什么先有这条：DRE 的 35 个 MCP 工具此前**无任何行为测试** —— 一旦把这些工具的
 * 处理器从 MCP 进程下沉到 DRE daemon，缺少安全网就可能静默改坏调用面。本测试先对
 * 代表性工具固定"名称 → 输出形状"，作为下沉重构的红绿判据。
 *
 * 覆盖范围：不发网络、不依赖本地 LLM 的确定性工具（写/读知识、persona、认知状态、
 * 数据统一入口、心智模型/约束/Actor 列表、约束注入）。需要 LLM 的管道类工具不在
 * 本网内（另有专门回归）。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import { registerDreTools, shutdownKernel } from "../../src/mcp/server/dre-tools.js";
import { snapshotEnv } from "../helpers/env-snapshot.js";

const DB = `.tmp/dre-tools-behavior-${process.pid}.db`;
let handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

// 轮 7 审计三梯队⑤：beforeAll 改写的 env 键 + 不可逆 delete 必须在 afterAll 全量
// 还原（bun 单进程顺序执行，泄漏会改变同进程后续测试文件的行为分支）。
const restoreEnv = snapshotEnv(["DRE_DB_PATH", "DATABASE_PATH", "DRE_LLM_URL", "DRE_AUTO_TICK", "DEEPSEEK_API_KEY"]);

describe("DRE MCP 工具行为安全网", () => {
  beforeAll(async () => {
    process.env.DRE_DB_PATH = DB;
    process.env.DATABASE_PATH = DB;
    process.env.DRE_LLM_URL = "http://127.0.0.1:8080";
    process.env.DRE_AUTO_TICK = "0";
    delete process.env.DEEPSEEK_API_KEY;
    try { fs.rmSync(DB, { force: true }); } catch {}
    const registry = new ToolRegistry({ guard: async () => {} });
    registerDreTools(registry);
    handlers = registry.buildHttpHandlers() as typeof handlers;
  });

  afterAll(async () => {
    await shutdownKernel();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(DB + suffix, { force: true }); } catch {}
    }
    restoreEnv();
  });

  test("注册了 DRE 工具面（含关键工具名）", () => {
    for (const name of ["dre_status", "dre_write_knowledge", "persona_list", "data_write", "cognitive_state", "mental_model_list", "constraint_list", "actor_list"]) {
      expect(typeof handlers[name]).toBe("function");
    }
  });

  test("dre_constraint_inject 返回约束词结构", async () => {
    const r = (await handlers.dre_constraint_inject({ text: "git 提交前先检查状态" })) as { injected: unknown[]; words: unknown; matched: unknown[] };
    expect(Array.isArray(r.injected)).toBe(true);
    expect(Array.isArray(r.matched)).toBe(true);
  });

  test("dre_status 返回引擎状态（vfs/actors 等子系统）", async () => {
    const r = (await handlers.dre_status({})) as Record<string, unknown>;
    expect(r).toBeDefined();
    // DREngine.getStatus() 形状：vfs/knowledge/actors/persona…；不可用时包成 success:false
    expect("vfs" in r || "actors" in r || "success" in r).toBe(true);
  });

  test("resource_status 返回预算状态对象", async () => {
    const r = (await handlers.resource_status({})) as Record<string, unknown>;
    expect(r).toBeDefined();
    expect(typeof r).toBe("object");
  });

  test("persona_list 含 general 模式；persona_switch 生效", async () => {
    const list = (await handlers.persona_list({})) as string[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toContain("general");
    const sw = (await handlers.persona_switch({ mode: "code", reason: "net" })) as { mode?: string } | { success?: boolean };
    if ("mode" in sw) expect(sw.mode).toBe("code");
  });

  test("data_write → data_search → data_stats 闭环", async () => {
    const w = (await handlers.data_write({ content: "安全网探针数据：地球绕日周期约365天", kind: "fact", domain: "science" })) as { atomId?: string; success?: boolean };
    expect(w.atomId ?? w.success !== undefined).toBeTruthy();
    const s = (await handlers.data_search({ query: "地球绕日周期" })) as { atoms?: unknown[]; knowledgeNodes?: unknown[] };
    expect(Array.isArray(s.atoms)).toBe(true);
    expect(Array.isArray(s.knowledgeNodes)).toBe(true);
    const stats = (await handlers.data_stats({})) as Record<string, unknown>;
    expect(typeof stats).toBe("object");
  });

  test("cognitive_state 暴露 persona/consciousness/reasoning", async () => {
    const r = (await handlers.cognitive_state({})) as { persona?: unknown; consciousness?: unknown; reasoning?: unknown };
    expect(r.persona).toBeDefined();
    expect(r.consciousness).toBeDefined();
    expect(r.reasoning).toBeDefined();
  });

  test("mental_model_list / constraint_list / actor_list 返回数组或失败结构", async () => {
    for (const name of ["mental_model_list", "constraint_list", "actor_list"]) {
      const r = await handlers[name]({});
      expect(Array.isArray(r) || (typeof r === "object" && r !== null)).toBe(true);
    }
  });
});

describe("DRE MCP 工具 :: forward 模式（MCP 进程薄转发）", () => {
  test("注册时给 forward，则每个 handler 都委托给 forward(name,args)", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const registry = new ToolRegistry({ guard: async () => {} });
    registerDreTools(registry, {
      forward: async (name, args) => {
        calls.push({ name, args });
        return { forwarded: name };
      },
    });
    const handlers = registry.buildHttpHandlers() as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;
    const r1 = await handlers.persona_list({});
    expect(r1).toEqual({ forwarded: "persona_list" });
    const r2 = await handlers.dre_status({ x: 1 });
    expect(r2).toEqual({ forwarded: "dre_status" });
    expect(calls.map((c) => c.name)).toEqual(["persona_list", "dre_status"]);
    expect(calls[1].args).toEqual({ x: 1 });
  });
});
