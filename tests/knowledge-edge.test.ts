/**
 * 知识库边缘增强测试 —— 验证 src/knowledge/edge-assist.ts 与 store 标题查询
 *
 * 四个子能力（全部可空返回，EDGE_KNOWLEDGE_ASSIST=0 禁用）：
 *   1. structureKnowledgeWithEdge  — 文档结构化（title/summary/keywords/quality_score）
 *   2. rewriteKnowledgeQueryWithEdge — 自然语言 → 检索关键词
 *   3. judgeKnowledgeQualityWithEdge — validateContent 灰区质量裁决
 *   4. isNearDuplicateWithEdge       — 近重复判断
 *   5. summarizeKnowledgeWithEdge    — 采集摘要
 *
 * 全部 DI fake client，不访问真实端点。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  structureKnowledgeWithEdge,
  rewriteKnowledgeQueryWithEdge,
  judgeKnowledgeQualityWithEdge,
  isNearDuplicateWithEdge,
  summarizeKnowledgeWithEdge,
} from "../src/knowledge/edge-assist.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

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

// ─────────────────────────────────────────────────────────
// structureKnowledgeWithEdge
// ─────────────────────────────────────────────────────────

describe("structureKnowledgeWithEdge", () => {
  test("合法 JSON 返回结构化结果（缺省字段补默认值）", async () => {
    const { client } = fakeClient(() => ({
      content: '{"title":"Nginx 反向代理指南","summary":"介绍 nginx 反向代理配置","keywords":["nginx","proxy"],"quality_score":0.8}',
    }));
    const r = await structureKnowledgeWithEdge("# Nginx 指南\n内容...", client);
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Nginx 反向代理指南");
    expect(r!.keywords).toEqual(["nginx", "proxy"]);
    expect(r!.quality_score).toBe(0.8);
    expect(r!.sections).toEqual([]);
    expect(r!.entities).toEqual([]);
    expect(r!.structured_data).toBeNull();
  });

  test("缺 title 视为无效 → null", async () => {
    const { client } = fakeClient(() => ({ content: '{"summary":"只有摘要"}' }));
    expect(await structureKnowledgeWithEdge("content", client)).toBeNull();
  });

  test("垃圾输出 → null", async () => {
    const { client } = fakeClient(() => ({ content: "这是一篇好文章" }));
    expect(await structureKnowledgeWithEdge("content", client)).toBeNull();
  });

  test("模型异常 → null", async () => {
    const { client } = fakeClient(() => { throw new Error("down"); });
    expect(await structureKnowledgeWithEdge("content", client)).toBeNull();
  });

  test("EDGE_KNOWLEDGE_ASSIST=0 → null 且不调用", async () => {
    process.env.EDGE_KNOWLEDGE_ASSIST = "0";
    try {
      const { client, getCalls } = fakeClient(() => ({ content: '{"title":"t","summary":"s"}' }));
      expect(await structureKnowledgeWithEdge("content", client)).toBeNull();
      expect(getCalls()).toBe(0);
    } finally {
      delete process.env.EDGE_KNOWLEDGE_ASSIST;
    }
  });
});

// ─────────────────────────────────────────────────────────
// rewriteKnowledgeQueryWithEdge
// ─────────────────────────────────────────────────────────

describe("rewriteKnowledgeQueryWithEdge", () => {
  test("返回空格分隔关键词串", async () => {
    const { client } = fakeClient(() => ({ content: '{"keywords":["nginx","反向代理","proxy_pass"]}' }));
    const r = await rewriteKnowledgeQueryWithEdge("怎么配置 nginx 的反向代理？", client);
    expect(r).toBe("nginx 反向代理 proxy_pass");
  });

  test("非数组输出 → null", async () => {
    const { client } = fakeClient(() => ({ content: '{"keywords": "nginx"}' }));
    expect(await rewriteKnowledgeQueryWithEdge("q", client)).toBeNull();
  });

  test("空数组 → null", async () => {
    const { client } = fakeClient(() => ({ content: '{"keywords":[]}' }));
    expect(await rewriteKnowledgeQueryWithEdge("q", client)).toBeNull();
  });

  test("模型异常 → null", async () => {
    const { client } = fakeClient(() => { throw new Error("down"); });
    expect(await rewriteKnowledgeQueryWithEdge("q", client)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// judgeKnowledgeQualityWithEdge
// ─────────────────────────────────────────────────────────

describe("judgeKnowledgeQualityWithEdge", () => {
  test("pass=true/false 正确解析", async () => {
    const { client: c1 } = fakeClient(() => ({ content: '{"pass": true, "reason": "内容详实"}' }));
    expect((await judgeKnowledgeQualityWithEdge("标题", "摘要...", c1))?.pass).toBe(true);
    const { client: c2 } = fakeClient(() => ({ content: '{"pass": false}' }));
    expect((await judgeKnowledgeQualityWithEdge("标题", "摘要...", c2))?.pass).toBe(false);
  });

  test("垃圾/异常 → null", async () => {
    const { client: c1 } = fakeClient(() => ({ content: "看不懂" }));
    expect(await judgeKnowledgeQualityWithEdge("t", "s", c1)).toBeNull();
    const { client: c2 } = fakeClient(() => { throw new Error("down"); });
    expect(await judgeKnowledgeQualityWithEdge("t", "s", c2)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// isNearDuplicateWithEdge
// ─────────────────────────────────────────────────────────

describe("isNearDuplicateWithEdge", () => {
  test("判定重复 → true", async () => {
    const { client } = fakeClient(() => ({ content: '{"duplicate": true}' }));
    expect(await isNearDuplicateWithEdge("Nginx 代理配置", "内容...", ["Nginx 反向代理配置指南"], client)).toBe(true);
  });

  test("判定不重复 → false", async () => {
    const { client } = fakeClient(() => ({ content: '{"duplicate": false}' }));
    expect(await isNearDuplicateWithEdge("Docker 入门", "内容...", ["Nginx 指南"], client)).toBe(false);
  });

  test("无候选标题直接 false（不调模型）", async () => {
    const { client, getCalls } = fakeClient(() => ({ content: '{"duplicate": true}' }));
    expect(await isNearDuplicateWithEdge("t", "s", [], client)).toBe(false);
    expect(getCalls()).toBe(0);
  });

  test("垃圾/异常 → null", async () => {
    const { client: c1 } = fakeClient(() => ({ content: "可能重复吧" }));
    expect(await isNearDuplicateWithEdge("t", "s", ["x"], c1)).toBeNull();
    const { client: c2 } = fakeClient(() => { throw new Error("down"); });
    expect(await isNearDuplicateWithEdge("t", "s", ["x"], c2)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// summarizeKnowledgeWithEdge
// ─────────────────────────────────────────────────────────

describe("summarizeKnowledgeWithEdge", () => {
  test("返回摘要", async () => {
    const { client } = fakeClient(() => ({ content: "本文介绍 nginx 反向代理的配置步骤与常见坑。" }));
    expect(await summarizeKnowledgeWithEdge("长文...".repeat(100), client)).toContain("nginx");
  });

  test("过短输出 → null", async () => {
    const { client } = fakeClient(() => ({ content: "短" }));
    expect(await summarizeKnowledgeWithEdge("content", client)).toBeNull();
  });

  test("模型异常 → null", async () => {
    const { client } = fakeClient(() => { throw new Error("down"); });
    expect(await summarizeKnowledgeWithEdge("content", client)).toBeNull();
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
