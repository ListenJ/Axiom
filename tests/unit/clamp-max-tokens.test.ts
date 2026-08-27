/**
 * 审计 H-3 / 整改 R3 Task 3.5 —— maxTokens 预算钳制
 *
 * 修复前：recommendedMaxTokens 仅写入日志（engine.ts:327,335），各调用方
 * 自传硬编码 maxTokens（engine=256 / edge-client=512），请求可超 llama.cpp
 * --ctx-size，行为取决于外部截断策略。
 *
 * 修复后契约（clampMaxTokens 纯函数）：
 *   - recommended 有效（>0）→ min(requested, recommended)，下限 1
 *   - recommended 缺失/非法 → 原样返回（不臆造上限）
 */
import { describe, test, expect, afterEach } from "bun:test";
import { clampMaxTokens, getResourceBudgetManager } from "../../src/dre/system-resource.js";
import { LLMClient } from "../../src/dre/llm/client.js";

describe("clampMaxTokens（H-3）", () => {
  test("预算低于请求时钳制到预算", () => {
    expect(clampMaxTokens(256, 100)).toBe(100);
  });

  test("预算高于请求时保持请求值", () => {
    expect(clampMaxTokens(256, 4096)).toBe(256);
  });

  test("预算缺失/0/负数 → 原样返回", () => {
    expect(clampMaxTokens(256, undefined)).toBe(256);
    expect(clampMaxTokens(256, 0)).toBe(256);
    expect(clampMaxTokens(512, -5)).toBe(512);
  });

  test("结果下限为 1", () => {
    expect(clampMaxTokens(10, 1)).toBe(1);
  });
});

describe("D1：canRun=false 时禁止直发本地 LLM（2026-08-25 整改）", () => {
  let originalAvail = getResourceBudgetManager().getResource().availableMemory;
  const origFetch = globalThis.fetch;

  afterEach(() => {
    getResourceBudgetManager().updateResource({ availableMemory: originalAvail });
    globalThis.fetch = origFetch;
  });

  test("默认静态预算 availableMemory=4000>1300 → canRunLocal=true（默认行为零变化）", () => {
    expect(getResourceBudgetManager().getStatus().canRunLocal).toBe(true);
  });

  test("可用内存 100MB → generate() 抛 LLM_ERROR(retriable=false, 消息含 insufficient resources) 且未发起 fetch", async () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 100 });
    expect(mgr.getStatus().canRunLocal).toBe(false);

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new LLMClient({ baseUrl: "http://127.0.0.1:1", model: "test" });
    const err: Error & { code?: string; retriable?: boolean } | null = await client
      .generate("hi")
      .then(
        () => null,
        (e) => e as Error & { code?: string; retriable?: boolean }
      );

    expect(err).not.toBeNull();
    expect(err!.code).toBe("LLM_ERROR");
    expect(err!.retriable).toBe(false);
    expect(String(err!.message)).toContain("insufficient resources");
    expect(fetchCalls).toBe(0);
  });

  test("可用内存 100MB → streamGenerate() 同样阻断且未发起 fetch", async () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 100 });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new LLMClient({ baseUrl: "http://127.0.0.1:1", model: "test" });
    let caught: unknown = null;
    try {
      for await (const _ of client.streamGenerate("hi")) {
        void _;
      }
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code).toBe("LLM_ERROR");
    expect((caught as { retriable?: boolean }).retriable).toBe(false);
    expect(String((caught as Error).message)).toContain("insufficient resources");
    expect(fetchCalls).toBe(0);
  });
});
