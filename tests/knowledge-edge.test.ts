/**
 * 知识库边缘增强测试 —— 验证 src/knowledge/edge-assist.ts（Laya 判别式版）与 store 标题查询
 *
 * 2026-09-28 迁移（src/local-llm 删除）：
 *   1. structureKnowledgeWithEdge  — 生成类退役：恒 null（pipeline 回退 GLM → TF-IDF）
 *   2. judgeKnowledgeQualityWithEdge — 灰区质量裁决 → Laya noul
 *   3. isNearDuplicateWithEdge       — 近重复判断 → Laya noul
 *   4. summarizeKnowledgeWithEdge    — 生成类退役：恒 null
 *
 * 受控 fetch mock 驱动真实现，不访问真实端点；LLM 默认关闭策略口径不变（双开关授权）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  structureKnowledgeWithEdge,
  judgeKnowledgeQualityWithEdge,
  isNearDuplicateWithEdge,
  summarizeKnowledgeWithEdge,
} from "../src/knowledge/edge-assist.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

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
  // LLM 默认关闭策略（用户指令 2026-09-18）：本文件用例验证"已授权"路径，显式打开双开关
  process.env.KNOWLEDGE_USE_LLM = "1";
  process.env.EDGE_KNOWLEDGE_ASSIST = "1";
  layaCalls = 0;
  layaImpl = (body) => noulAnswers(body, 0.9);
  installLayaFetch();
});
afterEach(restoreLayaFetch);

// ─────────────────────────────────────────────────────────
// structureKnowledgeWithEdge（生成类退役）
// ─────────────────────────────────────────────────────────

describe("structureKnowledgeWithEdge（退役）", () => {
  test("恒 null：pipeline 回退 GLM → fallbackTFIDF", async () => {
    expect(await structureKnowledgeWithEdge("# Nginx 指南\n内容...")).toBeNull();
    expect(layaCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// judgeKnowledgeQualityWithEdge（Laya noul）
// ─────────────────────────────────────────────────────────

describe("judgeKnowledgeQualityWithEdge（Laya）", () => {
  test("noul≥0.5 → pass=true；noul<0.5 → pass=false", async () => {
    expect((await judgeKnowledgeQualityWithEdge("标题", "摘要..."))?.pass).toBe(true);
    layaImpl = (body) => noulAnswers(body, 0.2);
    expect((await judgeKnowledgeQualityWithEdge("标题", "摘要..."))?.pass).toBe(false);
    expect(layaCalls).toBe(2);
  });

  test("answers 缺失/服务异常 → null（fail-open 回规则）", async () => {
    layaImpl = () => ({ model: "laya-rl-agent", answers: {}, usage: { input_tokens: 1, output_tokens: 0 }, routing: { model: "multilingual" } });
    expect(await judgeKnowledgeQualityWithEdge("t", "s")).toBeNull();
    restoreLayaFetch();
    process.env.LAYA_DECISION_URL = process.env.LAYA_DECISION_URL ?? "http://laya.test:18081";
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    fetchInstalled = true;
    expect(await judgeKnowledgeQualityWithEdge("t", "s")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// isNearDuplicateWithEdge（Laya noul）
// ─────────────────────────────────────────────────────────

describe("isNearDuplicateWithEdge（Laya）", () => {
  test("noul≥0.5 → true（重复）；noul<0.5 → false", async () => {
    expect(await isNearDuplicateWithEdge("Nginx 代理配置", "内容...", ["Nginx 反向代理配置指南"])).toBe(true);
    layaImpl = (body) => noulAnswers(body, 0.1);
    expect(await isNearDuplicateWithEdge("Docker 入门", "内容...", ["Nginx 指南"])).toBe(false);
  });

  test("无候选标题直接 false（不调模型）", async () => {
    layaCalls = 0;
    expect(await isNearDuplicateWithEdge("t", "s", [])).toBe(false);
    expect(layaCalls).toBe(0);
  });

  test("服务异常 → null（调用方按不重复处理）", async () => {
    restoreLayaFetch();
    process.env.LAYA_DECISION_URL = process.env.LAYA_DECISION_URL ?? "http://laya.test:18081";
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    fetchInstalled = true;
    expect(await isNearDuplicateWithEdge("t", "s", ["x"])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// summarizeKnowledgeWithEdge（生成类退役）
// ─────────────────────────────────────────────────────────

describe("summarizeKnowledgeWithEdge（退役）", () => {
  test("恒 null：调用方按无摘要处理", async () => {
    expect(await summarizeKnowledgeWithEdge("长文...".repeat(100))).toBeNull();
    expect(layaCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// KnowledgeStore.listTitlesBySubdomain（真实 SQLite）
// ─────────────────────────────────────────────────────────

describe("KnowledgeStore.listTitlesBySubdomain", () => {
  test("按域/子域返回标题，按时间倒序限量", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ks-test-"));
    try {
      const store = new KnowledgeStore(join(dir, "test.db"));
      store.saveSource({ title: "第一篇", domain: "computer-science", subdomain: "web", url: "http://a/1", quality: 0.5 });
      store.saveSource({ title: "第二篇", domain: "computer-science", subdomain: "web", url: "http://a/2", quality: 0.5 });
      store.saveSource({ title: "其他域", domain: "philosophy", subdomain: "web", url: "http://a/3", quality: 0.5 });

      const titles = store.listTitlesBySubdomain("computer-science", "web", 10);
      expect(titles).toContain("第一篇");
      expect(titles).toContain("第二篇");
      expect(titles).not.toContain("其他域");
      expect(titles.length).toBe(2);
      store.close(); // Windows 下需先释放 SQLite 文件锁才能删目录
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
