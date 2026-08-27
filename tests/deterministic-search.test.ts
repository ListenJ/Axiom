/**
 * 确定性记忆搜索引擎测试套件
 * 覆盖：精确匹配、关键词匹配、关系推导、PARA 语义、过滤
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { DeterministicSearchEngine } from "../src/memory/deterministic-search.js";

const TEST_VAULT = "./tests/fixtures/vault";

describe("DeterministicSearchEngine", () => {
  beforeEach(() => {
    // 创建测试 Vault
    fs.mkdirSync(TEST_VAULT, { recursive: true });
    fs.mkdirSync(path.join(TEST_VAULT, "01-Projects"), { recursive: true });
    fs.mkdirSync(path.join(TEST_VAULT, "03-Resources"), { recursive: true });
    fs.mkdirSync(path.join(TEST_VAULT, "04-Conversations"), { recursive: true });

    // 创建测试笔记
    fs.writeFileSync(path.join(TEST_VAULT, "SOUL.md"), `---
title: SOUL
type: core-personality
tags: [meta, personality]
---

# SOUL — Agent 人格定义

我是 Axiom，一个 AI Agent。核心使命是协助用户完成研究任务。

## 核心原则

- 文件优先：所有记忆以 Markdown 形式持久化
- 最小依赖：能用内置能力解决的，不引入新依赖
`);

    fs.writeFileSync(path.join(TEST_VAULT, "01-Projects", "axiom.md"), `---
title: Axiom Project
type: project-doc
tags: [project, typescript, bun]
---

# Axiom 项目

基于 Bun + TypeScript 构建的 AI Agent。

技术栈：Bun 1.3, TypeScript, SQLite。

[[SOUL]]
[[SQLite]]
`);

    fs.writeFileSync(path.join(TEST_VAULT, "03-Resources", "sqlite-guide.md"), `---
title: SQLite 指南
type: reference
tags: [database, sqlite, reference]
---

# SQLite 指南

SQLite 是一个嵌入式数据库。FTS5 支持全文检索。

## 特性

- 零配置
- 单文件存储
- 支持 JSON

[[axiom]]
`);

    fs.writeFileSync(path.join(TEST_VAULT, "04-Conversations", "2026-05-25.md"), `---
title: 会话日志
type: conversation-log
tags: [conversation]
---

# 2026-05-25 会话

讨论了 Vault 核心记忆引擎的设计。

用户偏好：使用确定性推理，不使用向量数据库。
`);

    fs.writeFileSync(path.join(TEST_VAULT, "unrelated.md"), `---
title: 无关笔记
type: note
tags: [random]
---

# 无关笔记

这是一篇与 Agent 系统无关的内容。
`);
  });

  afterEach(() => {
    // 清理测试 Vault
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  test("精确匹配：文件名", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("SOUL");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].note.path).toBe("SOUL.md");
    expect(results[0].score).toBeGreaterThanOrEqual(85);
    expect(results[0].reasons.some((r) => r.includes("精确匹配"))).toBe(true);
  });

  test("精确匹配：标题", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("SQLite 指南");
    expect(results[0].note.path).toBe("03-Resources/sqlite-guide.md");
  });

  test("关键词匹配：内容关键词", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("TypeScript");
    const paths = results.map((r) => r.note.path);
    expect(paths).toContain("01-Projects/axiom.md");
  });

  test("关键词匹配：标签匹配权重更高", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("sqlite");
    const resourceNote = results.find((r) => r.note.path === "03-Resources/sqlite-guide.md");
    expect(resourceNote).toBeDefined();
    expect(resourceNote!.reasons.some((r) => r.includes("标签"))).toBe(true);
  });

  test("关系推导：wiki-link 出链提升", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    // 搜索 "axiom" 时，SOUL.md 因为被 axiom.md 引用而应该被提升
    const results = engine.search("axiom");
    const soulResult = results.find((r) => r.note.path === "SOUL.md");
    // SOUL 被 axiom.md 引用，应该出现在结果中
    expect(soulResult).toBeDefined();
  });

  test("关系推导：backlink 提升", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    // sqlite-guide.md 引用了 [[axiom]]
    // 搜索 "sqlite-guide" 或 "sqlite" 时，axiom.md 应该被 backlink 提升
    const results = engine.search("sqlite");
    const axiomResult = results.find((r) => r.note.path === "01-Projects/axiom.md");
    // axiom.md 引用了 [[SQLite]]，所以搜索 sqlite 时它会被提升
    expect(axiomResult).toBeDefined();
  });

  test("PARA 分类浏览", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const resources = engine.browseByPara("resources");
    expect(resources.length).toBe(1);
    expect(resources[0].path).toBe("03-Resources/sqlite-guide.md");

    const projects = engine.browseByPara("projects");
    expect(projects.length).toBe(1);
    expect(projects[0].path).toBe("01-Projects/axiom.md");
  });

  test("标签浏览", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const metaNotes = engine.browseByTag("meta");
    expect(metaNotes.length).toBe(1);
    expect(metaNotes[0].path).toBe("SOUL.md");
  });

  test("关联网络", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const network = engine.getNetwork("01-Projects/axiom.md", 1);
    const relatedPaths = network.notes.map((n) => n.path);
    expect(relatedPaths).toContain("SOUL.md");
    expect(relatedPaths).toContain("03-Resources/sqlite-guide.md");
    expect(network.relationships.length).toBeGreaterThan(0);
  });

  test("过滤：type 过滤", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("Agent", { types: ["core-personality"] });
    expect(results.length).toBe(1);
    expect(results[0].note.path).toBe("SOUL.md");
  });

  test("过滤：tags 过滤", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("SQLite", { tags: ["reference"] });
    expect(results.length).toBe(1);
    expect(results[0].note.path).toBe("03-Resources/sqlite-guide.md");
  });

  test("过滤：paraCategory 过滤", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("Agent", { paraCategory: "projects" });
    expect(results.length).toBe(1);
    expect(results[0].note.path).toBe("01-Projects/axiom.md");
  });

  test("统计信息", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const stats = engine.stats();
    expect(stats.totalNotes).toBe(5);
    expect(stats.totalWords).toBeGreaterThan(0);
    expect(stats.paraDistribution.projects).toBe(1);
    expect(stats.paraDistribution.resources).toBe(1);
    expect(stats.paraDistribution.conversations).toBe(1);
  });

  test("可解释性：每个结果都有原因", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("Agent");
    for (const r of results) {
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.excerpt.length).toBeGreaterThan(0);
    }
  });

  test("去重：同一笔记只出现一次", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    const results = engine.search("笔记");
    const paths = results.map((r) => r.note.path);
    const uniquePaths = new Set(paths);
    expect(paths.length).toBe(uniquePaths.size);
  });

  test("内容关键词命中可召回(有界扫描下,P1-T1 护栏)", () => {
    const engine = new DeterministicSearchEngine(TEST_VAULT);
    // sqlite-guide.md 正文独有词「嵌入式」——标题/标签/路径均不含 → 纯内容命中路径
    const results = engine.search("嵌入式");
    expect(results.some((r) => r.note.path === "03-Resources/sqlite-guide.md")).toBe(true);
  });
});
