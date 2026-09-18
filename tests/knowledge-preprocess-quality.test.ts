/**
 * Phase 3 知识整理 — preprocessor + quality-assessor 单元测试
 *
 * 两部分：
 *   1. preprocessKnowledge: 清洗 / 标准化 / metadata 抽取 / token 估算
 *   2. assessQuality: 三维评分 (accuracy / completeness / consistency) + overall
 */
import { describe, it, expect } from "bun:test";
import {
  preprocessKnowledge,
  PreprocessedKnowledgeSchema,
} from "../src/knowledge/preprocessor.js";
import { assessQuality } from "../src/knowledge/quality-assessor.js";
import {
  KnowledgeSourceSchema,
  DictionaryEntrySchema,
  StructuredKnowledgeSchema,
  type StructuredKnowledge,
} from "../src/knowledge/types.js";

// ═══════════════════════════════════════════════════════════════
// Part 0: zod schema 基础校验（Task 3.1）
// ═══════════════════════════════════════════════════════════════

describe("zod schemas (Task 3.1)", () => {
  it("KnowledgeSourceSchema 校验合法对象", () => {
    const parsed = KnowledgeSourceSchema.safeParse({
      id: "ks-1",
      title: "React Docs",
      domain: "computer-science",
      subdomain: "frontend",
      url: "https://react.dev",
      quality: 0.9,
      storedAt: Date.now(),
    });
    expect(parsed.success).toBe(true);
  });

  it("KnowledgeSourceSchema 拒绝非法 domain", () => {
    const parsed = KnowledgeSourceSchema.safeParse({
      id: "ks-1",
      title: "X",
      domain: "invalid-domain",
      subdomain: "",
      url: "https://x.com",
      quality: 0.5,
      storedAt: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("DictionaryEntrySchema 校验合法词条", () => {
    const parsed = DictionaryEntrySchema.safeParse({
      word: "algorithm",
      partOfSpeech: "noun",
      definitions: ["A step-by-step procedure for solving a problem."],
    });
    expect(parsed.success).toBe(true);
  });

  it("DictionaryEntrySchema 拒绝空 definitions", () => {
    const parsed = DictionaryEntrySchema.safeParse({
      word: "x",
      partOfSpeech: "noun",
      definitions: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("StructuredKnowledgeSchema 给缺失字段填默认值", () => {
    const parsed = StructuredKnowledgeSchema.safeParse({
      title: "Test Doc",
      summary: "A short summary.",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.keywords).toEqual([]);
      expect(parsed.data.sections).toEqual([]);
      expect(parsed.data.entities).toEqual([]);
      expect(parsed.data.quality_score).toBe(0);
    }
  });

  it("StructuredKnowledgeSchema 拒绝空 title", () => {
    const parsed = StructuredKnowledgeSchema.safeParse({
      title: "",
      summary: "x",
    });
    expect(parsed.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 1: preprocessKnowledge (Task 3.2)
// ═══════════════════════════════════════════════════════════════

describe("preprocessKnowledge", () => {
  it("清洗 HTML 残留标签", () => {
    const md = "<div>Hello</div> <p>World</p>";
    const result = preprocessKnowledge(md);
    expect(result.cleanedMarkdown).not.toContain("<div>");
    expect(result.cleanedMarkdown).not.toContain("<p>");
    expect(result.cleanedMarkdown).toContain("Hello");
    expect(result.cleanedMarkdown).toContain("World");
  });

  it("解码 HTML 实体", () => {
    const md = "Tom &amp; Jerry &lt;3 &quot;quotes&quot;";
    const result = preprocessKnowledge(md);
    expect(result.cleanedMarkdown).toContain("Tom & Jerry");
    expect(result.cleanedMarkdown).toContain("<3");
    expect(result.cleanedMarkdown).toContain('"quotes"');
  });

  it("从 front-matter 抽取 metadata", () => {
    const md = `---
title: My Document
author: Alice
date: 2026-07-20
---

# Body content here.`;
    const result = preprocessKnowledge(md);
    expect(result.extractedMetadata.title).toBe("My Document");
    expect(result.extractedMetadata.author).toBe("Alice");
    expect(result.extractedMetadata.date).toBe("2026-07-20");
    expect(result.cleanedMarkdown).not.toContain("---");
  });

  it("从首个 # 标题抽取 title（无 front-matter 时）", () => {
    const md = "# Document Title\n\nBody text.";
    const result = preprocessKnowledge(md);
    expect(result.extractedMetadata.title).toBe("Document Title");
  });

  it("从元数据行抽取 author/date", () => {
    const md = `# Title

**Author:** Bob
Date: 2026-01-15

Content here.`;
    const result = preprocessKnowledge(md);
    expect(result.extractedMetadata.author).toBe("Bob");
    expect(result.extractedMetadata.date).toBe("2026-01-15");
  });

  it("折叠 3+ 连续空行为 2 行", () => {
    const md = "Para 1\n\n\n\n\nPara 2";
    const result = preprocessKnowledge(md);
    expect(result.cleanedMarkdown).not.toMatch(/\n{3,}/);
  });

  it("去除超长行（> 2000 字符）", () => {
    const longLine = "a".repeat(2500);
    const md = `# Title\n\n${longLine}\n\nShort line.`;
    const result = preprocessKnowledge(md);
    expect(result.cleanedMarkdown).not.toContain(longLine);
    expect(result.cleanedMarkdown).toContain("Short line");
  });

  it("标准化 ~~~ 代码块为 ```", () => {
    const md = "~~~js\nconst x = 1;\n~~~";
    const result = preprocessKnowledge(md);
    expect(result.cleanedMarkdown).toContain("```js");
    expect(result.cleanedMarkdown).not.toContain("~~~js");
  });

  it("估算 token 数（~4 字符/token，至少 1）", () => {
    const md = "Hello world"; // 11 字符
    const result = preprocessKnowledge(md);
    expect(result.tokenCount).toBeGreaterThanOrEqual(1);
    expect(result.tokenCount).toBe(Math.ceil(11 / 4)); // 3
  });

  it("多个顶层 # 标题时降级为 ##", () => {
    const md = "# Heading 1\n\nContent A\n\n# Heading 2\n\nContent B";
    const result = preprocessKnowledge(md);
    expect(result.cleanedMarkdown).not.toMatch(/^#\s+/m);
    expect(result.cleanedMarkdown).toMatch(/^##\s+/m);
  });

  it("单个顶层 # 标题时保持不变", () => {
    const md = "# Only Heading\n\nContent";
    const result = preprocessKnowledge(md);
    expect(result.cleanedMarkdown).toMatch(/^#\s+Only Heading/);
  });

  it("空输入返回空对象 + 0 token", () => {
    expect(preprocessKnowledge("")).toEqual({
      cleanedMarkdown: "",
      extractedMetadata: {},
      tokenCount: 0,
    });
    expect(preprocessKnowledge(null as never)).toEqual({
      cleanedMarkdown: "",
      extractedMetadata: {},
      tokenCount: 0,
    });
  });

  it("结果通过 PreprocessedKnowledgeSchema 校验", () => {
    const result = preprocessKnowledge("# Title\n\nBody content here.");
    const parsed = PreprocessedKnowledgeSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: assessQuality (Task 3.3)
// ═══════════════════════════════════════════════════════════════

function makeStructured(overrides: Partial<StructuredKnowledge> = {}): StructuredKnowledge {
  return {
    title: "TypeScript Guide",
    summary: "A comprehensive guide to TypeScript programming language features and best practices for developers.",
    keywords: ["typescript", "programming", "guide"],
    quality_score: 0.8,
    sections: [
      { heading: "Introduction", content: "This guide introduces TypeScript programming language and its core features." },
      { heading: "Types", content: "TypeScript supports primitive types like string, number, boolean, and complex types." },
    ],
    entities: [
      { name: "TypeScript", type: "technology" },
      { name: "JavaScript", type: "technology" },
    ],
    structured_data: null,
    ...overrides,
  };
}

describe("assessQuality", () => {
  it("返回 4 个字段 (accuracy/completeness/consistency/overall) ∈ [0, 1]", () => {
    const q = assessQuality(makeStructured());
    expect(q).toHaveProperty("accuracy");
    expect(q).toHaveProperty("completeness");
    expect(q).toHaveProperty("consistency");
    expect(q).toHaveProperty("overall");
    expect(q).toHaveProperty("issues");
    expect(q.accuracy).toBeGreaterThanOrEqual(0);
    expect(q.accuracy).toBeLessThanOrEqual(1);
    expect(q.completeness).toBeGreaterThanOrEqual(0);
    expect(q.completeness).toBeLessThanOrEqual(1);
    expect(q.consistency).toBeGreaterThanOrEqual(0);
    expect(q.consistency).toBeLessThanOrEqual(1);
    expect(q.overall).toBeGreaterThanOrEqual(0);
    expect(q.overall).toBeLessThanOrEqual(1);
  });

  it("完整数据集 completeness = 1.0", () => {
    const q = assessQuality(makeStructured());
    expect(q.completeness).toBe(1);
    expect(q.issues.filter((i) => i.includes("缺失") || i.includes("为空")).length).toBe(0);
  });

  it("缺失 title 扣 0.2 分", () => {
    const q = assessQuality(makeStructured({ title: "" }));
    expect(q.completeness).toBeLessThan(1);
    expect(q.issues.some((i) => i.includes("title"))).toBe(true);
  });

  it("summary 过短扣 0.1 分", () => {
    const q = assessQuality(makeStructured({ summary: "Short." }));
    expect(q.completeness).toBeLessThan(1);
    expect(q.issues.some((i) => i.includes("summary"))).toBe(true);
  });

  it("keywords < 3 扣 0.1 分", () => {
    const q = assessQuality(makeStructured({ keywords: ["only-one"] }));
    expect(q.completeness).toBeLessThan(1);
    expect(q.issues.some((i) => i.includes("keywords"))).toBe(true);
  });

  it("entities 为空扣 0.2 分", () => {
    const q = assessQuality(makeStructured({ entities: [] }));
    expect(q.completeness).toBeLessThan(1);
    expect(q.issues.some((i) => i.includes("entities"))).toBe(true);
  });

  it("keywords 出现在 sections 中时 consistency 高", () => {
    const q = assessQuality(makeStructured());
    expect(q.consistency).toBeGreaterThanOrEqual(0.5);
  });

  it("keywords 与 sections 完全不匹配时 consistency 低", () => {
    const q = assessQuality(
      makeStructured({
        keywords: ["python", "java", "rust"],
        sections: [{ heading: "Intro", content: "This document is about TypeScript programming language." }],
      }),
    );
    expect(q.consistency).toBeLessThan(0.6);
  });

  it("无 factBase 时 accuracy = 0.5（中位分）", () => {
    const q = assessQuality(makeStructured());
    expect(q.accuracy).toBe(0.5);
  });

  it("有 factBase 且高度匹配时 accuracy 高", () => {
    const factBase = [
      { text: "TypeScript is a typed superset of JavaScript", confidence: 1.0 },
      { text: "TypeScript supports primitive types like string number boolean", confidence: 1.0 },
    ];
    const q = assessQuality(makeStructured(), factBase);
    expect(q.accuracy).toBeGreaterThan(0.5);
  });

  it("overall 是 accuracy/completeness/consistency 的加权（0.4/0.3/0.3）", () => {
    const q = assessQuality(makeStructured());
    const expected =
      q.accuracy * 0.4 +
      q.completeness * 0.3 +
      q.consistency * 0.3;
    expect(q.overall).toBe(Math.round(expected * 1000) / 1000);
  });

  it("空 sections 时 consistency = 0", () => {
    const q = assessQuality(makeStructured({ sections: [] }));
    expect(q.consistency).toBe(0);
    expect(q.issues.some((i) => i.includes("sections 内容为空"))).toBe(true);
  });
});
