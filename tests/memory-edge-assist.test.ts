/**
 * vault 边缘增强测试 —— 验证 src/memory/edge-assist.ts（Laya 判别式版）与 memory-gate 门控
 *
 * 注入点（全部"规则 fast path → 边缘增强 → 失败回退"）：
 *   1. MemoryGate 灰区（confidence ∈ [0.35, 0.6)）→ Laya noul 判断值不值得记
 *   2. 标题/标签生成（生成类）→ 退役：恒 null，规则回退（本套件锁此行为）
 *
 * 2026-09-28 迁移：原生成式 fake client 形态退役，改受控 fetch mock 驱动真实现。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

const REAL_FETCH = globalThis.fetch;
let layaCalls = 0;
let layaImpl: (body: { questions?: Record<string, unknown> }) => unknown = () => ({});
let fetchInstalled = false;

function installLayaFetch() {
  if (fetchInstalled) return;
  process.env.LAYA_DECISION_URL = process.env.LAYA_DECISION_URL ?? "http://laya.test:18081";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    layaCalls++;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(layaImpl(body)), { status: 200 });
  }) as typeof fetch;
  fetchInstalled = true;
}
function restoreLayaFetch() {
  if (!fetchInstalled) return;
  globalThis.fetch = REAL_FETCH;
  fetchInstalled = false;
}
function noulAnswers(body: { questions?: Record<string, unknown> }, v: number) {
  const answers: Record<string, unknown> = {};
  for (const k of Object.keys(body.questions ?? {})) {
    answers[k] = { type: "noul", noul: v, confidence: v };
  }
  return { model: "laya-rl-agent", answers, usage: { input_tokens: 10, output_tokens: 0 }, routing: { model: "multilingual" } };
}

beforeEach(() => {
  // LLM 默认关闭策略（用户指令 2026-09-18）：本文件用例验证"已授权"路径
  process.env.EDGE_MEMORY_ASSIST = "1";
  layaCalls = 0;
  layaImpl = (body) => noulAnswers(body, 0.9);
  installLayaFetch();
});
afterEach(restoreLayaFetch);

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

describe("judgeSignificanceWithEdge（Laya noul）", () => {
  test("noul≥0.5 → worth=true", async () => {
    const r = await judgeSignificanceWithEdge("如何配置 nginx 反代", "步骤如下：1. ...");
    expect(r?.worth).toBe(true);
    expect(layaCalls).toBe(1);
  });

  test("noul<0.5 → worth=false", async () => {
    layaImpl = (body) => noulAnswers(body, 0.2);
    const r = await judgeSignificanceWithEdge("你好", "你好！有什么可以帮你？");
    expect(r?.worth).toBe(false);
  });

  test("answers 缺失 → null（调用方回退规则结果）", async () => {
    layaImpl = () => ({ model: "laya-rl-agent", answers: {}, usage: { input_tokens: 1, output_tokens: 0 }, routing: { model: "multilingual" } });
    const r = await judgeSignificanceWithEdge("q", "a");
    expect(r).toBeNull();
  });

  test("服务异常 → null（fail-open）", async () => {
    restoreLayaFetch();
    process.env.LAYA_DECISION_URL = process.env.LAYA_DECISION_URL ?? "http://laya.test:18081";
    globalThis.fetch = (async () => {
      throw new Error("laya down");
    }) as unknown as typeof fetch;
    fetchInstalled = true;
    const r = await judgeSignificanceWithEdge("q", "a");
    expect(r).toBeNull();
  });

  test("EDGE_MEMORY_ASSIST=0 → null 且不调用模型", async () => {
    process.env.EDGE_MEMORY_ASSIST = "0";
    try {
      layaCalls = 0;
      const r = await judgeSignificanceWithEdge("q", "a");
      expect(r).toBeNull();
      expect(layaCalls).toBe(0);
    } finally {
      delete process.env.EDGE_MEMORY_ASSIST;
    }
  });
});

// ─────────────────────────────────────────────────────────
// generateTitleWithEdge
// ─────────────────────────────────────────────────────────

describe("generateTitleWithEdge（生成类退役）", () => {
  test("恒 null：调用方走规则回退（40 字符截断）", async () => {
    expect(await generateTitleWithEdge("如何配置 nginx 反向代理？首先安装 nginx...")).toBeNull();
    expect(layaCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// generateTagsWithEdge
// ─────────────────────────────────────────────────────────

describe("generateTagsWithEdge（生成类退役）", () => {
  test("恒 null：调用方按无附加标签处理", async () => {
    expect(await generateTagsWithEdge("如何配置 nginx 反向代理...")).toBeNull();
    expect(layaCalls).toBe(0);
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
    layaCalls = 0;
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx);
    expect(d.shouldWrite).toBe(true);
    expect(layaCalls).toBe(0);
  });

  test("灰区 + Laya 判定值得 → 升级为写入", async () => {
    const gate = new MemoryGate();
    // 只给少量加分项让 confidence 落在 [0.35, 0.6)
    const ctx = makeCtx({ hasCode: true, hasStructuredData: true, userMessageLength: 300 });
    layaCalls = 0;
    layaImpl = (body) => noulAnswers(body, 0.95);
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx);
    expect(layaCalls).toBe(1);
    expect(d.shouldWrite).toBe(true);
    expect(d.category).toBe("medium-value");
    expect(d.reason).toContain("edge-approved");
  });

  test("灰区 + Laya 判定不值得 → 维持跳过", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ hasCode: true, hasStructuredData: true, userMessageLength: 300 });
    layaImpl = (body) => noulAnswers(body, 0.1);
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx);
    expect(d.shouldWrite).toBe(false);
  });

  test("灰区 + 边缘不可用 → 维持规则结果（fail-open 到规则）", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ hasCode: true, hasStructuredData: true, userMessageLength: 300 });
    restoreLayaFetch();
    process.env.LAYA_DECISION_URL = process.env.LAYA_DECISION_URL ?? "http://laya.test:18081";
    globalThis.fetch = (async () => {
      throw new Error("laya down");
    }) as unknown as typeof fetch;
    fetchInstalled = true;
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx);
    expect(d.shouldWrite).toBe(false);
  });

  test("远低于阈值（< 0.35）不调用边缘模型", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ taskType: "chat" }); // -0.2 → confidence 0
    layaCalls = 0;
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx);
    expect(d.shouldWrite).toBe(false);
    expect(layaCalls).toBe(0);
  });

  test("基础检查失败（如含错误）直接跳过，不调用边缘模型", async () => {
    const gate = new MemoryGate();
    const ctx = makeCtx({ hasErrors: true });
    layaCalls = 0;
    const d = await gate.shouldWriteWithEdge(response, userMessage, ctx);
    expect(d.shouldWrite).toBe(false);
    expect(layaCalls).toBe(0);
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
