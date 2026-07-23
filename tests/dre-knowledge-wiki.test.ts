/**
 * 知识编译（Knowledge Wiki）— Layer 2 测试套件
 *
 * 覆盖维度（对应用户质量保障要求）：
 *   1. 功能测试：编译流程 + 提取维度（标题/摘要/关键词/概念/数值/交叉引用）
 *   2. 边界条件：空内容 / 无标题 / 短内容 / 特殊字符
 *   3. 查询功能：searchByKeyword / searchByConcept / getByTitle / getEntry
 *   4. 性能基准：批量编译延迟 + 查询延迟
 *
 * 测试策略（遵循 AGENTS.md 规则 7 测试驱动）：
 *   - 测行为不测实现：全部通过 compileDocument / searchByKeyword 等公共接口验证
 *   - 垂直切片：每个测试响应上一轮的发现
 *   - 手工构造 CompiledDocument，不依赖文件系统
 */
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import {
  KnowledgeWiki,
  _resetKnowledgeWikiForTest,
  type CompiledDocument,
  type WikiEntry,
} from "../src/dre/retrieval/knowledge-wiki.js";

// ─── 测试辅助 ────────────────────────────────────────────────────────────

/** 构造测试文档 */
function makeDoc(
  path: string,
  content: string,
  title?: string,
): CompiledDocument {
  return { path, content, ...(title !== undefined ? { title } : {}) };
}

/** 标准测试文档 */
function makeStandardDoc(): CompiledDocument {
  return makeDoc(
    "notes/typescript.md",
    `# TypeScript Guide

TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.
The TypeScript compiler checks types at build time, catching errors before runtime.
Use tsconfig.json to configure the compiler. Version 5.0 introduced decorators.
VSCode provides excellent TypeScript support with IntelliSense.`,
  );
}

// ─── 功能测试：编译流程 ──────────────────────────────────────────────────

describe("KnowledgeWiki — 编译流程", () => {
  let wiki: KnowledgeWiki;

  beforeEach(() => {
    wiki = new KnowledgeWiki();
  });

  afterEach(() => {
    _resetKnowledgeWikiForTest();
  });

  test("compileDocument 返回完整知识条目", () => {
    const doc = makeStandardDoc();
    const entry = wiki.compileDocument(doc);

    expect(entry.id).toBeDefined();
    expect(entry.title).toBeDefined();
    expect(entry.summary).toBeDefined();
    expect(entry.keywords).toBeInstanceOf(Array);
    expect(entry.concepts).toBeInstanceOf(Array);
    expect(entry.numericalFacts).toBeInstanceOf(Array);
    expect(entry.relatedTitles).toBeInstanceOf(Array);
    expect(entry.source).toBe("notes/typescript.md");
    expect(entry.compiledAt).toBeGreaterThan(0);
  });

  test("标题提取：Markdown # 标题", () => {
    const doc = makeDoc("notes/x.md", "# My Title\n\nContent here");
    const entry = wiki.compileDocument(doc);
    expect(entry.title).toBe("My Title");
  });

  test("标题提取：显式 title 参数优先", () => {
    const doc = makeDoc("notes/x.md", "# Markdown Title\nContent", "Explicit Title");
    const entry = wiki.compileDocument(doc);
    expect(entry.title).toBe("Explicit Title");
  });

  test("标题提取：无标题时用首行", () => {
    const doc = makeDoc("notes/x.md", "First line as title\nSecond line");
    const entry = wiki.compileDocument(doc);
    expect(entry.title).toBe("First line as title");
  });

  test("摘要提取：去除 Markdown 标记并截断", () => {
    const doc = makeDoc("notes/x.md", "# Title\n\n**Bold** and *italic* and `code` text");
    const entry = wiki.compileDocument(doc);
    expect(entry.summary).not.toContain("#");
    expect(entry.summary).not.toContain("**");
    expect(entry.summary).not.toContain("*");
    expect(entry.summary).not.toContain("`");
    expect(entry.summary).toContain("Bold");
    expect(entry.summary).toContain("italic");
  });

  test("关键词提取：词频分析去停用词", () => {
    const doc = makeDoc(
      "notes/x.md",
      "typescript typescript typescript javascript javascript code code code the the the is is is",
    );
    const entry = wiki.compileDocument(doc);
    expect(entry.keywords.length).toBeGreaterThan(0);
    // "typescript" 出现 3 次，应为首个关键词
    expect(entry.keywords[0]).toBe("typescript");
    // 停用词不应出现
    expect(entry.keywords).not.toContain("the");
    expect(entry.keywords).not.toContain("is");
  });

  test("概念提取：大写词 + camelCase + 缩写", () => {
    const doc = makeDoc(
      "notes/x.md",
      "TypeScript and JavaScript with VSCode support. Uses camelCase naming and HTTP protocol.",
    );
    const entry = wiki.compileDocument(doc);
    expect(entry.concepts).toContain("TypeScript");
    expect(entry.concepts).toContain("JavaScript");
    expect(entry.concepts).toContain("VSCode");
    expect(entry.concepts).toContain("camelCase");
    expect(entry.concepts).toContain("HTTP");
  });

  test("数值事实提取：数值 + 上下文", () => {
    const doc = makeDoc("notes/x.md", "Version 5.0 was released. Supported by 42 teams with 100 tests.");
    const entry = wiki.compileDocument(doc);
    expect(entry.numericalFacts.length).toBeGreaterThanOrEqual(3);
    const values = entry.numericalFacts.map((f) => f.value);
    expect(values).toContain(5.0);
    expect(values).toContain(42);
    expect(values).toContain(100);
    // 每个数值事实都有上下文
    for (const fact of entry.numericalFacts) {
      expect(fact.context.length).toBeGreaterThan(0);
    }
  });

  test("重新编译同一文档时覆盖旧条目", () => {
    const doc1 = makeDoc("notes/x.md", "# Old Title\nOld content");
    const entry1 = wiki.compileDocument(doc1);
    expect(wiki.getStats().totalEntries).toBe(1);

    const doc2 = makeDoc("notes/x.md", "# New Title\nNew content");
    const entry2 = wiki.compileDocument(doc2);
    expect(wiki.getStats().totalEntries).toBe(1);
    expect(entry2.title).toBe("New Title");
    expect(entry1.id).not.toBe(entry2.id); // 标题不同 → ID 不同
  });
});

// ─── 批量编译与交叉引用 ────────────────────────────────────────────────

describe("KnowledgeWiki — 批量编译与交叉引用", () => {
  let wiki: KnowledgeWiki;

  beforeEach(() => {
    wiki = new KnowledgeWiki();
  });

  afterEach(() => {
    _resetKnowledgeWikiForTest();
  });

  test("批量编译多个文档", () => {
    const docs = [
      makeDoc("notes/a.md", "# Topic A\nContent about topic A"),
      makeDoc("notes/b.md", "# Topic B\nContent about topic B"),
      makeDoc("notes/c.md", "# Topic C\nContent about topic C"),
    ];
    const entries = wiki.compileBatch(docs);
    expect(entries.length).toBe(3);
    expect(wiki.getStats().totalEntries).toBe(3);
  });

  test("交叉引用检测：文档间标题引用", () => {
    const docs = [
      makeDoc("notes/a.md", "# TypeScript\nContent about TypeScript"),
      makeDoc("notes/b.md", "# JavaScript\nTypeScript is based on JavaScript"),
    ];
    const entries = wiki.compileBatch(docs);
    // JavaScript 文档应引用 TypeScript
    const jsEntry = entries.find((e) => e.title === "JavaScript");
    expect(jsEntry).toBeDefined();
    expect(jsEntry!.relatedTitles).toContain("TypeScript");
  });

  test("交叉引用不包含自身", () => {
    const docs = [
      makeDoc("notes/a.md", "# SelfRef\nSelfRef content mentions SelfRef"),
    ];
    const entries = wiki.compileBatch(docs);
    expect(entries[0].relatedTitles).not.toContain("SelfRef");
  });
});

// ─── 查询功能 ──────────────────────────────────────────────────────────

describe("KnowledgeWiki — 查询功能", () => {
  let wiki: KnowledgeWiki;

  beforeEach(() => {
    wiki = new KnowledgeWiki();
    wiki.compileBatch([
      makeDoc("notes/ts.md", "# TypeScript\nTypeScript is a typed superset of JavaScript"),
      makeDoc("notes/js.md", "# JavaScript\nJavaScript is a programming language"),
      makeDoc("notes/py.md", "# Python\nPython is a high-level programming language"),
    ]);
  });

  afterEach(() => {
    _resetKnowledgeWikiForTest();
  });

  test("getEntry by ID", () => {
    const all = wiki.getAllEntries();
    const first = all[0];
    const entry = wiki.getEntry(first.id);
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(first.id);
  });

  test("getByTitle", () => {
    const entry = wiki.getByTitle("TypeScript");
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("TypeScript");
    expect(entry!.source).toBe("notes/ts.md");
  });

  test("searchByKeyword：返回包含关键词的条目", () => {
    const results = wiki.searchByKeyword("typescript");
    expect(results.length).toBeGreaterThan(0);
    // TypeScript 文档应匹配
    const tsEntry = results.find((r) => r.title === "TypeScript");
    expect(tsEntry).toBeDefined();
  });

  test("searchByKeyword：标题子串匹配", () => {
    const results = wiki.searchByKeyword("type");
    expect(results.length).toBeGreaterThan(0);
    const tsEntry = results.find((r) => r.title === "TypeScript");
    expect(tsEntry).toBeDefined();
  });

  test("searchByConcept", () => {
    const results = wiki.searchByConcept("TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results.find((r) => r.title === "TypeScript")).toBeDefined();
  });

  test("searchByKeyword：无匹配返回空数组", () => {
    const results = wiki.searchByKeyword("nonexistent_topic_xyz");
    expect(results.length).toBe(0);
  });

  test("getStats 返回正确统计", () => {
    const stats = wiki.getStats();
    expect(stats.totalEntries).toBe(3);
    expect(stats.totalKeywords).toBeGreaterThan(0);
    expect(stats.totalConcepts).toBeGreaterThan(0);
    expect(stats.totalNumericalFacts).toBeGreaterThanOrEqual(0);
    expect(stats.totalCrossRefs).toBeGreaterThanOrEqual(0);
  });
});

// ─── 边界条件 ──────────────────────────────────────────────────────────

describe("KnowledgeWiki — 边界条件", () => {
  let wiki: KnowledgeWiki;

  beforeEach(() => {
    wiki = new KnowledgeWiki();
  });

  afterEach(() => {
    _resetKnowledgeWikiForTest();
  });

  test("空内容：不崩溃且返回空条目", () => {
    const doc = makeDoc("notes/empty.md", "");
    const entry = wiki.compileDocument(doc);
    expect(entry.title).toBe("notes/empty.md"); // 无内容 → 用文件名
    expect(entry.summary).toBe("");
    expect(entry.keywords.length).toBe(0);
    expect(entry.concepts.length).toBe(0);
    expect(entry.numericalFacts.length).toBe(0);
  });

  test("无标题且无首行：用文件名作标题", () => {
    const doc = makeDoc("notes/whitespace.md", "   \n   \n   ");
    const entry = wiki.compileDocument(doc);
    expect(entry.title).toBe("notes/whitespace.md");
  });

  test("短内容：正常编译", () => {
    const doc = makeDoc("notes/short.md", "# Short\nHi");
    const entry = wiki.compileDocument(doc);
    expect(entry.title).toBe("Short");
    expect(entry.summary).toContain("Hi");
  });

  test("特殊字符内容：不崩溃", () => {
    const doc = makeDoc("notes/special.md", "# Special\n内容含特殊字符 <>&\"' 及 emoji 🎉");
    const entry = wiki.compileDocument(doc);
    expect(entry.title).toBe("Special");
    expect(entry.summary.length).toBeGreaterThan(0);
  });

  test("limit 截断搜索结果", () => {
    // 编译 5 个含 "code" 关键词的文档
    for (let i = 0; i < 5; i++) {
      wiki.compileDocument(makeDoc(`notes/code-${i}.md`, `# Code ${i}\nCode content ${i}`));
    }
    const results = wiki.searchByKeyword("code", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("clear 清空所有条目", () => {
    wiki.compileDocument(makeDoc("notes/x.md", "# X\nContent"));
    expect(wiki.getStats().totalEntries).toBe(1);
    wiki.clear();
    expect(wiki.getStats().totalEntries).toBe(0);
    expect(wiki.getAllEntries().length).toBe(0);
  });
});

// ─── 性能基准 ──────────────────────────────────────────────────────────

describe("KnowledgeWiki — 性能基准", () => {
  let wiki: KnowledgeWiki;

  beforeEach(() => {
    wiki = new KnowledgeWiki();
  });

  afterEach(() => {
    _resetKnowledgeWikiForTest();
  });

  test("100 文档批量编译延迟 < 200ms", () => {
    const docs: CompiledDocument[] = [];
    for (let i = 0; i < 100; i++) {
      docs.push(
        makeDoc(
          `notes/doc-${i}.md`,
          `# Document ${i}\nThis is document ${i} about topic ${i}. It contains TypeScript and JavaScript content with version ${i}.0.`,
        ),
      );
    }
    const start = performance.now();
    wiki.compileBatch(docs);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(wiki.getStats().totalEntries).toBe(100);
  });

  test("100 条目关键词搜索延迟 < 10ms", () => {
    for (let i = 0; i < 100; i++) {
      wiki.compileDocument(
        makeDoc(`notes/doc-${i}.md`, `# Document ${i}\nContent about typescript and javascript`),
      );
    }
    const start = performance.now();
    const results = wiki.searchByKeyword("typescript");
    const elapsed = performance.now() - start;
    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10);
  });
});

// ─── 单例 ──────────────────────────────────────────────────────────────

describe("KnowledgeWiki — 单例", () => {
  afterEach(() => {
    _resetKnowledgeWikiForTest();
  });

  test("getKnowledgeWiki 返回同一实例", () => {
    const { getKnowledgeWiki } = require("../src/dre/retrieval/knowledge-wiki.js");
    const a = getKnowledgeWiki();
    const b = getKnowledgeWiki();
    expect(a).toBe(b);
  });

  test("_resetKnowledgeWikiForTest 重置单例", () => {
    const { getKnowledgeWiki } = require("../src/dre/retrieval/knowledge-wiki.js");
    const a = getKnowledgeWiki();
    _resetKnowledgeWikiForTest();
    const b = getKnowledgeWiki();
    expect(a).not.toBe(b);
  });
});
