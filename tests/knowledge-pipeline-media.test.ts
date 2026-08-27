import { describe, it, expect } from "bun:test";

describe("knowledge pipeline media guard S4", () => {
  it("KNOWLEDGE_USE_LLM=false 时不调用视觉 fetch", async () => {
    const prev = process.env.KNOWLEDGE_USE_LLM;
    process.env.KNOWLEDGE_USE_LLM = "false";
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"title":"x","summary":"y","keywords":[],"quality_score":0.5}' } }],
        }),
      } as any;
    };
    try {
      const { fallbackTFIDF } = await import("../src/knowledge/pipeline.js");
      // 直接验证 fallback 路径不触发网络
      fallbackTFIDF("# t\n![img](x.png)\nhello");
      expect(fetchCalls).toBe(0);
      // 再验证 pipeline 的 useLLM 守卫存在（静态检查）
      const fs = await import("fs");
      const content = fs.readFileSync("src/knowledge/pipeline.ts", "utf8");
      const hasGuard = content.includes('readBool("KNOWLEDGE_USE_LLM"') && content.includes("describeMediaInMarkdown");
      // 红：当前无 guard，hasGuard 关联逻辑应在实现后为 true 且 fetch 隔离
      expect(hasGuard).toBe(true);
      // 精确检查：structureWithGLM 内部必须受 KNOWLEDGE_USE_LLM 守卫（W7 承诺）
      const fnStart = content.indexOf("async function structureWithGLM");
      const fnEnd = content.indexOf("export interface PipelineOptions", fnStart);
      const fnBody = fnStart !== -1 && fnEnd !== -1 ? content.slice(fnStart, fnEnd) : content;
      const hasGuardInStructure =
        fnBody.includes('readBool("KNOWLEDGE_USE_LLM"') &&
        fnBody.includes("describeMediaInMarkdown") &&
        fnBody.indexOf('readBool("KNOWLEDGE_USE_LLM"') < fnBody.indexOf("describeMediaInMarkdown");
      expect(hasGuardInStructure).toBe(true);
    } finally {
      globalThis.fetch = orig;
      if (prev === undefined) delete process.env.KNOWLEDGE_USE_LLM;
      else process.env.KNOWLEDGE_USE_LLM = prev;
    }
  });
});
