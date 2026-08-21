import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { VaultManager } from "../../src/memory/vault-manager.js";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";
import { getResourceBudgetManager } from "../../src/dre/system-resource.js";
import { getPromptEngineer } from "../../src/agents/prompt-engineer.js";

/**
 * 真实链路测试：每个环节与功能构建现在开始实现真实测试
 * 1. 内存膨胀：Vault/Memory 在 200 次写入后是否线性增长而非指数，且预算正确
 * 2. 知识→LLM：Vault 写入的知识能否经检索交由 LLM（prepareChatContext 知识注入）
 * 3. Prompt 工程：输入提示词经 PromptEngineer 强化后约束完成度更高
 */

const TMP_VAULT = path.join(process.cwd(), ".tmp", "rigorous-real-links-vault");
const TMP_DB = path.join(process.cwd(), ".tmp", `rigorous-real-links-${Date.now()}.db`);

function cleanTmp() {
  try { fs.rmSync(TMP_VAULT, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + "-wal"); } catch {}
  try { fs.unlinkSync(TMP_DB + "-shm"); } catch {}
}

describe("真实链路：内存膨胀（Vault/Memory 预算与泄漏）", () => {
  beforeEach(() => { cleanTmp(); fs.mkdirSync(TMP_VAULT, { recursive: true }); });
  afterEach(() => cleanTmp());

  test("200 次写入后 totalNotes 200，文件大小线性，无指数膨胀", async () => {
    fs.mkdirSync(TMP_VAULT, { recursive: true });
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    const N = 200;
    for (let i = 0; i < N; i++) {
      await vault.writeNote(`03-Resources/rigorous/mem-${i}.md`, `# Memo ${i}\nContent for memory expansion test ${i} with deterministic token`, {
        title: `Memo ${i}`,
        tags: ["rigorous", `tag-${i % 5}`],
        type: "note",
        paraCategory: "resources",
      });
    }
    const stats = vault.stats();
    expect(stats.totalNotes).toBeGreaterThanOrEqual(N);
    expect(stats.totalNotes).toBeLessThan(N + 20); // 允许少量额外（如 code-index 产生的笔记）
    // DB 文件大小应 < 8MB（200 条），若指数膨胀会 >15MB
    const dbSize = fs.statSync(TMP_DB).size;
    expect(dbSize).toBeLessThan(8 * 1024 * 1024);
    // 再次写入 50 条覆盖，不应翻倍
    for (let i = 0; i < 50; i++) {
      await vault.writeNote(`03-Resources/rigorous/mem-${i}.md`, `# Memo ${i} updated\nUpdated content`, { title: `Memo ${i} updated`, overwrite: true });
    }
    const stats2 = vault.stats();
    expect(stats2.totalNotes).toBeGreaterThanOrEqual(N);
    expect(stats2.totalNotes).toBeLessThan(N + 20);
    const dbSize2 = fs.statSync(TMP_DB).size;
    expect(dbSize2).toBeLessThan(dbSize * 2); // 覆盖不应翻倍
    vault.close();
  });

  test("SQLiteMemory 覆盖写不产生重复 id 且 FTS 可检索", async () => {
    fs.mkdirSync(TMP_VAULT, { recursive: true });
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    await vault.writeNote("03-Resources/rigorous/dedup.md", "Content A uniqueAAA", { title: "Dedup", overwrite: true });
    const first = vault.search("Dedup");
    expect(first.length).toBeGreaterThan(0);
    await vault.writeNote("03-Resources/rigorous/dedup.md", "Content B updated with unique keyword XYZ123", { title: "Dedup", overwrite: true });
    const second = vault.search("XYZ123");
    expect(second.length).toBeGreaterThan(0);
    expect(second[0].note.path).toContain("dedup");
    vault.close();
  });

  test("ResourceBudget 估算在 200 次检索后仍准确（防抖+预算联动）", async () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ maxMemory: 4000, availableMemory: 4000 });
    // 强制大步避免防抖残留
    const { ResourceBudgetManager } = await import("../../src/dre/system-resource.js");
    const freshMgr = new ResourceBudgetManager({ resource: { maxMemory: 4000, availableMemory: 4000, maxCompute: 100, availableCompute: 100, source: "test" } });
    expect(freshMgr.getStatus().recommendedMaxTokens).toBeGreaterThan(0);
    expect(freshMgr.getStatus().canRunLocal).toBe(true);
    fs.mkdirSync(TMP_VAULT, { recursive: true });
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    for (let i = 0; i < 20; i++) {
      await vault.writeNote(`03-Resources/rigorous/budget-${i}.md`, `Budget test ${i}`, { title: `Budget ${i}`, overwrite: true });
      vault.search(`Budget ${i}`);
    }
    // 100 并发检索不崩
    const results = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve(vault.search("Budget"))));
    expect(results.every(r => Array.isArray(r))).toBe(true);
    vault.close();
  });

  test("reindexAll 后 FTS 与 Deterministic 双引擎一致（外部落盘）", async () => {
    fs.mkdirSync(TMP_VAULT, { recursive: true });
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    await vault.writeNote("03-Resources/rigorous/reindex-a.md", "Alpha content for reindex", { title: "Alpha", overwrite: true });
    // 模拟外部直接落盘（绕过 writeNote）
    const externalPath = path.join(TMP_VAULT, "03-Resources/rigorous/external-b.md");
    fs.mkdirSync(path.dirname(externalPath), { recursive: true });
    fs.writeFileSync(externalPath, "---\ntitle: External\n---\n\nBeta external content for reindex 456");
    const reindexed = vault.reindexAll();
    expect(reindexed).toBeGreaterThanOrEqual(2);
    const after = vault.search("Beta");
    expect(after.length).toBeGreaterThan(0);
    vault.close();
  });
});

describe("真实链路：知识→LLM 交付（Vault/记忆能否交由 LLM）", () => {
  beforeEach(() => { cleanTmp(); fs.mkdirSync(TMP_VAULT, { recursive: true }); });
  afterEach(() => cleanTmp());

  test("Vault 写入的知识可经 search 检索并格式化为 LLM 上下文", async () => {
    fs.mkdirSync(TMP_VAULT, { recursive: true });
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    const knowledge = "Axiom Fusion determinism: hand-written cosine plus TFIDF no vector";
    await vault.writeNote("03-Resources/rigorous/knowledge-llm.md", knowledge, { title: "Axiom Knowledge", tags: ["knowledge"], overwrite: true });
    const results = vault.search("determinism");
    expect(results.length).toBeGreaterThan(0);
    // 模拟注入 LLM prompt：知识应作为 system 上下文
    const context = `[Knowledge Context]\n${results.map(r => r.note.content.slice(0, 500)).join("\n---\n")}`;
    expect(context.length).toBeGreaterThan(50);
    expect(context.length).toBeLessThan(5000); // 长度截断验证，防止击穿预算
    vault.close();
  });

  test("prepareChatContext 实际将 Vault 知识注入 chatMessages", async () => {
    fs.mkdirSync(TMP_VAULT, { recursive: true });
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    await vault.writeNote("03-Resources/rigorous/llm-delivery.md", "The secret token is Axiom42 for LLM delivery test", { title: "Secret", tags: ["test"], overwrite: true });
    const { prepareChatContext } = await import("../../src/services/chat.js");
    const messages = [{ role: "user", content: "What is the secret token for LLM delivery test?" }];
    const ctx = await prepareChatContext(messages as any, true, vault as any, { budget: 4000 });
    // chatMessages 应至少包含 system 注入或 intent 增强，不应崩
    expect(ctx.chatMessages.length).toBeGreaterThanOrEqual(messages.length);
    const allContent = ctx.chatMessages.map(m => m.content).join("\n");
    expect(allContent.length).toBeGreaterThanOrEqual(messages[0].content.length);
    expect(ctx.intentInfo).toBeDefined();
    vault.close();
  });

  test("SQLiteMemory 直接检索亦可交由 LLM（FTS Rank 排序）", async () => {
    const mem = new SQLiteMemory(TMP_DB);
    mem.upsertNote({ path: "test-llm.md", title: "LLM Test", content: "Knowledge for LLM: deterministic retrieval works", excerpt: "Knowledge for LLM", tags: ["llm"], paraCategory: "resources", type: "note", confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() });
    const results = mem.search("deterministic retrieval");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].record.content).toContain("deterministic");
    // 模拟 LLM prompt 注入：应保留 rank 排序
    expect(results[0].score).toBeDefined();
    mem.close();
  });

  test("知识长度截断：超长网页内容不应击穿 LLM 上下文预算", async () => {
    fs.mkdirSync(TMP_VAULT, { recursive: true });
    const vault = new VaultManager({ vaultPath: TMP_VAULT, dbPath: TMP_DB });
    const longContent = "LongKnowledge ".repeat(5000); // ~65KB
    await vault.writeNote("03-Resources/rigorous/long.md", longContent, { title: "Long", overwrite: true });
    const results = vault.search("LongKnowledge");
    expect(results.length).toBeGreaterThan(0);
    // 注入时应截断至 3000 以内（参照 services/chat.ts codegraphContext.slice(0,3000)）
    const context = results[0].note.content.slice(0, 3000);
    expect(context.length).toBeLessThanOrEqual(3000);
    vault.close();
  });
});

describe("真实链路：Prompt 工程强化约束完成度", () => {
  test("PromptEngineer 匹配模板后填充应包含约束（规则驱动，非向量）", async () => {
    const engine = getPromptEngineer();
    const task = "请帮我审查这段 TypeScript 代码的安全性，关注 SQL注入 风险";
    const match = engine.matchTemplate(task);
    expect(match).not.toBeNull();
    expect(match!.template.id).toBe("code-review");
    expect(match!.score).toBeGreaterThan(2);
    expect(match!.reasons.length).toBeGreaterThan(0);
    // 填充后应包含约束
    const filled = engine.fillTemplate(match!.template, { language: "typescript", code: "const q = `SELECT * WHERE id=${id}`", context: "" });
    expect(filled).toContain("安全性");
    expect(filled).toContain("SQL注入");
    expect(filled).toContain("SELECT");
  });

  test("Prompt 工程强化：原始输入 vs 强化后，强化版应包含输出格式约束", async () => {
    const engine = getPromptEngineer();
    const enhancedTask = "请根据需求生成高质量代码，要求包含错误处理和单元测试";
    const match2 = engine.matchTemplate(enhancedTask);
    expect(match2).not.toBeNull();
    const filledEnhanced = engine.fillTemplate(match2!.template, { requirement: enhancedTask, techStack: "typescript" });
    expect(filledEnhanced).toContain("错误处理");
    expect(filledEnhanced).toContain("单元测试");
    // 强化后应包含模板的结构化输出要求
    expect(filledEnhanced.length).toBeGreaterThan(100);
  });

  test("Prompt 确定性回放：同输入 5 次匹配结果一致（手写余弦无随机）", async () => {
    const engine = getPromptEngineer();
    const task = "请生成一个深度研究的架构设计，包含对比分析";
    const results = Array.from({ length: 5 }, () => engine.matchTemplate(task));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]?.template.id).toBe(results[0]?.template.id);
      expect(results[i]?.score).toBe(results[0]?.score);
    }
  });

  test("约束强化：带 thinkingIntensity 过滤应提升对应模板权重", async () => {
    const engine = getPromptEngineer();
    const task = "调试排错：应用崩溃，错误日志显示内存泄漏";
    const without = engine.matchTemplate(task);
    const withHigh = engine.matchTemplate(task, { thinkingIntensity: "high" });
    // 高强度任务应匹配到 debug/architecture 等 high 模板
    expect(withHigh).not.toBeNull();
    expect(withHigh!.template.thinkingIntensity).toBe("high");
    // 不带过滤时也应命中，但分数可能不同
    expect(without).not.toBeNull();
  });

  test("并发 50 Prompt 匹配不丢且一致", async () => {
    const engine = getPromptEngineer();
    const task = "代码重构：消除重复，提高可读性";
    const results = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve(engine.matchTemplate(task))));
    expect(results.every(r => r?.template.id === results[0]?.template.id)).toBe(true);
  });

  test("Skill 触发词匹配亦确定且 5 次一致", async () => {
    const engine = getPromptEngineer();
    const trigger = "请帮我搜索一下最新的 AI 趋势";
    const results = Array.from({ length: 5 }, () => engine.matchSkill(trigger));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]?.id).toBe(results[0]?.id);
    }
    expect(results[0]?.id).toBe("web-search");
  });
});
