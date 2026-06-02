/**
 * Agent Bootstrap — 会话启动记忆加载器
 *
 * 每次 Agent 会话启动时执行的标准化流程：
 * 1. 读取核心元文件（SOUL / IDENTITY / USER）
 * 2. 加载当日日志
 * 3. 检索与当前上下文相关的记忆
 * 4. 检查系统状态（模型可用性、健康检查）
 * 5. 返回完整的启动上下文
 *
 * 输出格式可直接注入到 LLM 的 system prompt 中。
 */

import { VaultManager } from "./vault-manager.js";
import { SQLiteMemory } from "./sqlite-memory.js";
import { logger } from "../utils/logger.js";

interface BootstrapContext {
  /** Agent 人格定义 */
  personality: string;
  /** 用户偏好 */
  userPreferences: string;
  /** 系统身份 */
  identity: string;
  /** 今日日志摘要 */
  dailyLog: string;
  /** 相关记忆笔记 */
  relevantMemories: Array<{ title: string; path: string; excerpt: string }>;
  /** 系统状态 */
  systemStatus: {
    version: string;
    vaultNotes: number;
    availableModels: string[];
    lastBoot: string;
  };
  /** 启动时间 */
  bootTime: string;
}

interface BootstrapOptions {
  vaultPath?: string;
  topic?: string;           // 当前会话主题，用于检索相关记忆
  memoryDepth?: number;     // 检索深度（相关记忆数量）
  includeCodeIndex?: boolean; // 是否包含代码索引相关记忆
}

export class AgentBootstrap {
  private vault: VaultManager;
  private sqliteMemory: SQLiteMemory;

  constructor(vaultPath?: string) {
    this.vault = new VaultManager({ vaultPath });
    this.sqliteMemory = this.vault.getSqliteMemory();
  }

  /** 执行完整启动流程 */
  async run(opts: BootstrapOptions = {}): Promise<BootstrapContext> {
    const startTime = performance.now();
    const topic = opts.topic || "";
    const depth = opts.memoryDepth ?? 5;

    logger.info("Agent bootstrap starting", { topic, depth });

    // 1. 读取核心元文件
    const personality = this.readMetaFile("SOUL.md");
    const identity = this.readMetaFile("IDENTITY.md");
    const userPreferences = this.readMetaFile("USER.md");

    // 2. 加载当日日志
    const dailyLog = await this.loadDailyLog();

    // 3. 检索相关记忆
    const relevantMemories = this.searchRelevantMemories(topic, depth, opts.includeCodeIndex);

    // 4. 系统状态
    const stats = this.vault.stats();
    const systemStatus = {
      version: "2.1.0",
      vaultNotes: stats.totalNotes,
      availableModels: this.getAvailableModels(),
      lastBoot: new Date().toISOString(),
    };

    const context: BootstrapContext = {
      personality: personality.content,
      userPreferences: userPreferences.content,
      identity: identity.content,
      dailyLog: dailyLog.content,
      relevantMemories,
      systemStatus,
      bootTime: new Date().toISOString(),
    };

    logger.info("Agent bootstrap complete", {
      durationMs: Math.round(performance.now() - startTime),
      memoriesLoaded: relevantMemories.length,
    });

    return context;
  }

  /** 生成可用于 LLM system prompt 的文本 */
  toSystemPrompt(context: BootstrapContext): string {
    const lines: string[] = [];

    lines.push("=== AGENT BOOTSTRAP CONTEXT ===");
    lines.push(`Boot Time: ${context.bootTime}`);
    lines.push(`Vault Notes: ${context.systemStatus.vaultNotes}`);
    lines.push("");

    if (context.personality) {
      lines.push("--- PERSONALITY ---");
      lines.push(context.personality.slice(0, 2000));
      lines.push("");
    }

    if (context.identity) {
      lines.push("--- IDENTITY ---");
      lines.push(context.identity.slice(0, 1000));
      lines.push("");
    }

    if (context.userPreferences) {
      lines.push("--- USER PREFERENCES ---");
      lines.push(context.userPreferences.slice(0, 1000));
      lines.push("");
    }

    if (context.dailyLog) {
      lines.push("--- TODAY'S LOG ---");
      lines.push(context.dailyLog.slice(0, 1500));
      lines.push("");
    }

    if (context.relevantMemories.length > 0) {
      lines.push("--- RELEVANT MEMORIES ---");
      for (const m of context.relevantMemories) {
        lines.push(`[${m.title}] ${m.path}`);
        lines.push(m.excerpt.slice(0, 300));
        lines.push("");
      }
    }

    lines.push("=== END BOOTSTRAP ===");

    return lines.join("\n");
  }

  private readMetaFile(name: string): { content: string; exists: boolean } {
    const note = this.vault.readNote(name);
    if (note) {
      return { content: note.content, exists: true };
    }
    return { content: `<!-- ${name} not found -->`, exists: false };
  }

  private async loadDailyLog(): Promise<{ content: string; exists: boolean }> {
    const today = new Date().toISOString().slice(0, 10);
    const note = this.vault.readNote(`memory/${today}.md`);
    if (note) {
      return { content: note.content, exists: true };
    }

    // 创建当日日志
    await this.vault.ensureDailyNote();
    const created = this.vault.readNote(`memory/${today}.md`);
    return { content: created?.content || "", exists: !!created };
  }

  private searchRelevantMemories(
    topic: string,
    depth: number,
    includeCodeIndex?: boolean
  ): Array<{ title: string; path: string; excerpt: string }> {
    const memories: Array<{ title: string; path: string; excerpt: string }> = [];
    const seen = new Set<string>();

    // 如果有主题，先搜索SQLite（快速），再搜索Vault（确定性）
    if (topic.trim()) {
      // SQLite FTS5 优先搜索
      const sqliteResults = this.sqliteMemory.search(topic, { limit: depth });
      for (const r of sqliteResults) {
        if (seen.has(r.record.path)) continue;
        seen.add(r.record.path);
        if (!includeCodeIndex && r.record.path.includes("code-index")) continue;
        memories.push({
          title: r.record.title,
          path: r.record.path,
          excerpt: r.excerpt,
        });
      }

      // 如果SQLite结果不足，用Vault确定性搜索补充
      if (memories.length < depth) {
        const vaultResults = this.vault.search(topic, { limit: depth - memories.length });
        for (const r of vaultResults) {
          if (seen.has(r.note.path)) continue;
          seen.add(r.note.path);
          if (!includeCodeIndex && r.note.path.includes("code-index")) continue;
          memories.push({
            title: r.note.title,
            path: r.note.path,
            excerpt: r.excerpt,
          });
        }
      }
    }

    // 如果没有主题或结果不足，补充最近修改的笔记
    if (memories.length < depth) {
      const recent = this.vault.browsePara("resources")
        .concat(this.vault.browsePara("projects"))
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, depth - memories.length);

      for (const n of recent) {
        if (seen.has(n.path)) continue;
        seen.add(n.path);
        if (!includeCodeIndex && n.path.includes("code-index")) continue;
        memories.push({
          title: n.title,
          path: n.path,
          excerpt: n.content.slice(0, 200),
        });
      }
    }

    return memories;
  }

  private getAvailableModels(): string[] {
    const models: string[] = [];
    if (process.env.SILICONFLOW_API_KEY) models.push("siliconflow");
    if (process.env.OFOXAI_API_KEY) models.push("ofoxai");
    if (process.env.DEEPSEEK_API_KEY) models.push("deepseek");
    if (process.env.OPENROUTER_API_KEY) models.push("openrouter");
    return models;
  }
}

export default AgentBootstrap;
