/**
 * vault 边缘增强测试 —— 验证 src/memory/edge-assist.ts 与 memory-gate 边缘门控
 *
 * 注入点（全部"规则 fast path → 边缘增强 → 失败回退"）：
 *   1. MemoryGate 灰区（confidence ∈ [0.35, 0.6)）→ 边缘判断值不值得记
 *   2. 笔记标题生成（规则截断 → 边缘语义标题）
 *   3. 笔记标签生成（无 → 边缘 2-5 个标签）
 *
 * 全部 DI fake client，不访问真实端点。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  judgeSignificanceWithEdge,
  generateTitleWithEdge,
  generateTagsWithEdge,
} from "../src/memory/edge-assist.js";
import { MemoryGate, type SignificanceContext } from "../src/memory/memory-gate.js";
import { MemoryDistiller } from "../src/memory/distiller.js";

// ─────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────

function fakeClient(impl: (prompt: string) => { content: string }) {
  let calls = 0;
  return {
    client: {
      generate: async (prompt: string) => {
        calls++;
        const r = impl(prompt);
        return { content: r.content, model: "mock", usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop" };
      },
    },
    getCalls: () => calls,
  };
}

function makeCtx(overrides: Partial<SignificanceContext> = {}): SignificanceContext {
  return {
    responseLength: 300,
    hasCode: false,
    hasCitations: false,
    hasErrors: false,
    userMessageLength: 50,
    isFirstTurn: false,
    hasStructuredData: false,
    hasTechnicalTerms: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// judgeSignificanceWithEdge
// ─────────────────────────────────────────────────────────

describe("judgeSignificanceWithEdge", () => {
  test("模型判定值得记忆 → worth=true", async () => {
    const { client } = fakeClient(() => ({ content: '{"worth": true, "reason": "包含可复用方案"}' }));
    const r = await judgeSignificanceWithEdge("如何配置 nginx 反代", "步骤如下：1. ...", client);
    expect(r?.worth).toBe(true);
  });

  test("模型判定不值得 → worth=false", async () => {
    const { client } = fakeClient(() => ({ content: '{"worth": false}' }));
    const r = await judgeSignificanceWithEdge("你好", "你好！有什么可以帮你？", client);
    expect(r?.worth).toBe(false);
  });

  test("垃圾输出 → null（调用方回退规则结果）", async () => {
    const { client } = fakeClient(() => ({ content: "我觉得挺好的" }));
    const r = await judgeSignificanceWithEdge("q", "a", client);
    expect(r).toBeNull();
  });

  test("模型异常 → null", async () => {
    const { client } = fakeClient(() => { throw new Error("down"); });
    const r = await judgeSignificanceWithEdge("q", "a", client);
    expect(r).toBeNull();
  });

  test("EDGE_MEMORY_ASSIST=0 → null 且不调用模型", async () => {
    process.env.EDGE_MEMORY_ASSIST = "0";
    try {
      const { client, getCalls } = fakeClient(() => ({ content: '{"worth": true}' }));
      const r = await judgeSignificanceWithEdge("q", "a", client);
      expect(r).toBeNull();
      expect(getCalls()).toBe(0);
    } finally {
      delete process.env.EDGE_MEMORY_ASSIST;
    }
  });
});

// ─────────────────────────────────────────────────────────
// generateTitleWithEdge
// ─────────────────────────────────────────────────────────

describe("generateTitleWithEdge", () => {
  test("返回合法标题", async () => {
    const { client } = fakeClient(() => ({ content: "Nginx 反向代理配置方法" }));
    const r = await generateTitleWithEdge("如何配置 nginx 反向代理？首先安装 nginx...", client);
    expect(r).toBe("Nginx 反向代理配置方法");
  });

  test("超长标题被截断到 60 字符", async () => {
    const { client } = fakeClient(() => ({ content: "标".repeat(100) }));
    const r = await generateTitleWithEdge("content", client);
    expect(r).not.toBeNull();
    expect(r!.length).toBeLessThanOrEqual(60);
  });

  test("空/垃圾输出 → null", async () => {
    const { client } = fakeClient(() => ({ content: "  " }));
    expect(await generateTitleWithEdge("content", client)).toBeNull();
  });

  test("模型异常 → null", async () => {
    const { client } = fakeClient(() => { throw new Error("down"); });
    expect(await generateTitleWithEdge("content", client)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// generateTagsWithEdge
// ─────────────────────────────────────────────────────────

describe("generateTagsWithEdge", () => {
  test("返回标签数组", async () => {
    const { client } = fakeClient(() => ({ content: '{"tags": ["nginx", "反向代理", "运维"]}' }));
    const r = await generateTagsWithEdge("如何配置 nginx 反向代理...", client);
    expect(r).toEqual(["nginx", "反向代理", "运维"]);
  });

  test("超过 5 个标签被截断", async () => {
    const { client } = fakeClient(() => ({ content: '{"tags": ["a","b","c","d","e","f","g"]}' }));
    const r = await generateTagsWithEdge("content", client);
    expect(r!.length).toBeLessThanOrEqual(5);
  });

  test("非数组输出 → null", async () => {
    const { client } = fakeClient(() => ({ content: '{"tags": "nginx"}' }));
    expect(await generateTagsWithEdge("content", client)).toBeNull();
  });

  test("模型异常 → null", async () => {
    const { client } = fakeClient(() => { throw new Error("down"); });
    expect(await generateTagsWithEdge("content", client)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// MemoryGate.shouldWriteWithEdge — 灰区边缘裁决
// ─────────────────────────────────────────────────────────

describe("MemoryGate.shouldWriteWithEdge", () => {
  const response = "这是一个足够长的响应内容，".repeat(20); // > 100 chars
  const userMessage = "这是一个足够长的用户消息";

  test("规则高分直接通过，不调用边缘模型", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ taskType: "coding", hasCode: true, hasCitations: true, hasStructuredData: true, hasTechnicalTerms: true, isFirstTurn: true, userMessageLength: 300 });
    const { client, getCalls } = fakeClient(() => ({ content: '{"worth": false}' }));
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx, client);
    expect(d.shouldWrite).toBe(true);
    expect(getCalls()).toBe(0);
  });

  test("灰区 + 边缘判定值得 → 升级为写入", async () => {
    const gate = new MemoryGate();
    // 只给少量加分项让 confidence 落在 [0.35, 0.6)
    const ctx = makeCtx({ hasCode: true, hasStructuredData: true, userMessageLength: 300 });
    const { client, getCalls } = fakeClient(() => ({ content: '{"worth": true, "reason": "可复用"}' }));
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx, client);
    expect(getCalls()).toBe(1);
    expect(d.shouldWrite).toBe(true);
    expect(d.category).toBe("medium-value");
    expect(d.reason).toContain("edge-approved");
  });

  test("灰区 + 边缘判定不值得 → 维持跳过", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ hasCode: true, hasStructuredData: true, userMessageLength: 300 });
    const { client } = fakeClient(() => ({ content: '{"worth": false}' }));
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx, client);
    expect(d.shouldWrite).toBe(false);
  });

  test("灰区 + 边缘不可用 → 维持规则结果（fail-open 到规则）", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ hasCode: true, hasStructuredData: true, userMessageLength: 300 });
    const { client } = fakeClient(() => { throw new Error("down"); });
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx, client);
    expect(d.shouldWrite).toBe(false);
  });

  test("远低于阈值（< 0.35）不调用边缘模型", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ taskType: "chat" }); // -0.2 → confidence 0
    const { client, getCalls } = fakeClient(() => ({ content: '{"worth": true}' }));
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx, client);
    expect(d.shouldWrite).toBe(false);
    expect(getCalls()).toBe(0);
  });

  test("基础检查失败（如含错误）直接跳过，不调用边缘模型", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ hasErrors: true });
    const { client, getCalls } = fakeClient(() => ({ content: '{"worth": true}' }));
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx, client);
    expect(d.shouldWrite).toBe(false);
    expect(getCalls()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// MemoryDistiller — 边缘辅助关闭时的回退行为
// ─────────────────────────────────────────────────────────

describe("MemoryDistiller distillManual (EDGE_MEMORY_ASSIST=0 回退)", () => {
  test("关闭边缘辅助时行为与原来一致（截断标题/摘要）", async () => {
    process.env.EDGE_MEMORY_ASSIST = "0";
    const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
    try {
      const distiller = new MemoryDistiller(dir);
      const longContent = "蒸馏内容。".repeat(100); // > 300 chars → 触发摘要截断
      const notePath = await distiller.distillManual(
        "手动笔记标题",
        longContent,
        { source: "test", sourceType: "manual", tags: ["t1"] },
      );
      const { readFileSync } = await import("node:fs");
      const written = readFileSync(join(dir, notePath), "utf-8");
      expect(written).toContain("t1");
      expect(written.length).toBeLessThan(longContent.length + 600); // 摘要被截断
    } finally {
      delete process.env.EDGE_MEMORY_ASSIST;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
