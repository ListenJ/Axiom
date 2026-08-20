/**
 * Task 5: knowledge/pipeline zero LLM 条件化
 * KNOWLEDGE_USE_LLM=false 仍可 saveSource / fallback TF-IDF
 * TDD Red-Green: 修复前应 FAIL（fallbackTFIDF 缺失或仍强制调 LLM），修复后 PASS
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readBool } from "../../src/utils/env.js";
import { getKnowledgeStore } from "../../src/knowledge/store.js";
import * as pipeline from "../../src/knowledge/pipeline.js";

describe("knowledge pipeline zero LLM (Task 5)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  test("KNOWLEDGE_USE_LLM 默认 false", () => {
    delete process.env.KNOWLEDGE_USE_LLM;
    const v = readBool("KNOWLEDGE_USE_LLM", false);
    expect(v).toBe(false);
  });

  test("KNOWLEDGE_USE_LLM=false 仍可 saveSource", () => {
    process.env.KNOWLEDGE_USE_LLM = "false";
    // use in-memory db path via temp file to avoid polluting
    const tmpPath = `./data/test-knowledge-${Date.now()}.db`;
    const store = getKnowledgeStore(tmpPath);
    const id = store.saveSource({
      title: "hello task5",
      domain: "general",
      subdomain: "test",
      url: `https://example.com/task5-${Date.now()}`,
      quality: 0.9,
    });
    expect(typeof id).toBe("string");
    expect(id.startsWith("know_")).toBe(true);
    // cleanup
    try { store.close(); } catch {}
    try { require("fs").unlinkSync(tmpPath); } catch {}
    try { require("fs").unlinkSync(tmpPath + "-wal"); } catch {}
    try { require("fs").unlinkSync(tmpPath + "-shm"); } catch {}
  });

  test("fallbackTFIDF 存在且返回合法 StructuredKnowledge", async () => {
    const fn = (pipeline as any).fallbackTFIDF as (md: string) => any;
    expect(typeof fn).toBe("function");
    const md = "# Hello World\n\nThis is a deterministic TF-IDF fallback test. TypeScript JavaScript TypeScript JavaScript TypeScript.\n\n## Section One\nContent about TypeScript and knowledge pipeline fallback.";
    const result = fn(md);
    // may be promise or sync
    const structured = result instanceof Promise ? await result : result;
    expect(structured).toBeTruthy();
    expect(typeof structured.title).toBe("string");
    expect(structured.title.length).toBeGreaterThan(0);
    expect(typeof structured.summary).toBe("string");
    expect(Array.isArray(structured.keywords)).toBe(true);
    // keywords should be non-empty for this md
    expect(structured.keywords.length).toBeGreaterThan(0);
    expect(typeof structured.quality_score).toBe("number");
    expect(structured.quality_score).toBeGreaterThanOrEqual(0);
    expect(structured.quality_score).toBeLessThanOrEqual(1);
    expect(Array.isArray(structured.sections)).toBe(true);
    expect(structured.sections.length).toBeGreaterThan(0);
    expect(Array.isArray(structured.entities)).toBe(true);
    // zod validation
    const { StructuredKnowledgeSchema } = await import("../../src/knowledge/types.js");
    const parsed = StructuredKnowledgeSchema.safeParse(structured);
    expect(parsed.success).toBe(true);
  });

  test("KNOWLEDGE_USE_LLM=false 时不调用 LLM (fetch)", async () => {
    process.env.KNOWLEDGE_USE_LLM = "false";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 })) as unknown as typeof fetch);
    const md = "# No LLM\n\nContent for no LLM test. " + "word ".repeat(50);
    const fn = (pipeline as any).fallbackTFIDF as (md: string) => any;
    expect(typeof fn).toBe("function");
    // 直接调用 fallback 不应触发 fetch
    const result = fn(md);
    const structured = result instanceof Promise ? await result : result;
    expect(structured.title).toBeTruthy();
    // fetch 不应被调用（fallback 是确定性算法）
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("fallbackTFIDF 中英文混合 keywords 确定性", () => {
    const fn = (pipeline as any).fallbackTFIDF as (md: string) => any;
    expect(typeof fn).toBe("function");
    const md = "# 中文标题\n\n这是中文内容的 TF-IDF 测试，包含 TypeScript 与 JavaScript 关键词。";
    const r1 = fn(md);
    const r2 = fn(md);
    expect(r1.keywords.join(",")).toBe(r2.keywords.join(","));
    expect(r1.title).toBe(r2.title);
    expect(r1.quality_score).toBe(r2.quality_score);
  });
});
