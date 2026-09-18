---
id: code-memory.vault-manager
type: code-index
source: memory\vault-manager.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 1333
tags: [code, auto-indexed]
exports: ["VaultManager"]
imports: ["fs", "path", "deterministic-search.js", "code-indexer.js", "utils-logger.js"]
---

# memory.vault-manager

## 元信息

- **源文件**: `memory\vault-manager.ts`
- **模块**: `memory.vault-manager`
- **行数**: 458
- **索引时间**: 2026-05-25T05:11:12.538Z

## 依赖

- [[fs]]
- [[path]]
- [[deterministic-search.js]]
- [[code-indexer.js]]
- [[utils-logger.js]]

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| class | `VaultManager` | 44 |

## 代码

```typescript
/**
 * VaultManager — 核心记忆引擎
 *
 * 设计原则：
 * - Obsidian Vault 是唯一的真理来源（Source of Truth）
 * - 所有记忆以 Markdown 形式存储，人类可读、可版本控制
 * - SQLite 仅作为性能索引（可重建），不存储独立数据
 * - 确定性检索：零向量、零概率、零 embedding
 * - 所有 Agent 通过 Vault 文件系统共享记忆
 *
 * 记忆类型：
 *   00-Meta/        — 元数据（人格、规则、身份）
 *   01-Projects/    — 项目（有明确截止日期）
 *   02-Areas/       — 领域（长期责任）
 *   03-Resources/   — 资源（参考材料、代码索引）
 *   04-Conversations/ — 会话日志
 *   05-Archives/    — 归档
 *   memory/         — 每日日志
 */

import fs from "fs";
import path from "path";
import { DeterministicSearchEngine, type SearchResult, type VaultNote } from "./deterministic-search.js";
import { CodeIndexer } from "./code-indexer.js";
import { logger } from "../utils/logger.js";

interface VaultConfig {
  vaultPath: string;
  apiPort: number;
  apiToken: string;
}

interface WriteNoteOptions {
  title?: string;
  tags?: string[];
  type?: string;
  source?: string;
  confidence?: number;
  paraCategory?: "projects" | "areas" | "resources" | "archives" | "conversations" | "meta" | "memory";
  append?: boolean;
  overwrite?: boolean;
}

export class VaultManager {
  private config: VaultConfig;
  private engine: DeterministicSearchEngine;
  private baseUrl: string;
  private codeIndexer: CodeIndexer;

  constructor(config: Partial<VaultConfig> = {}) {
    this.config = {
      vaultPath: config.vaultPath || process.env.OBSIDIAN_VAULT_PATH || "./axiom-memory",
      apiPort: config.apiPort || Number(process.env.OBSIDIAN_API_PORT) || 27124,
      apiToken: config.apiToken || process.env.OBSIDIAN_API_TOKEN || "",
    };
    this.baseUrl = `https://127.0.0.1:${this.config.apiPort}`;

    this.engine = new DeterministicSearchEngine(this.config.vaultPath);
    this.codeIndexer = new CodeIndexer({
      sourceRoot: "./src",
      vaultRoot: this.config.vaultPath,
    });

    logger.info("VaultManager initialized", {
      vaultPath: this.config.vaultPath,
      notes: this.engine.stats().totalNotes,
    });
  }

  // ===== 确定性检索 =====

  /** 全文搜索 — 四阶段确定性漏斗 */
  search(query: string, opts?: { limit?: number; types?: string[]; tags?: string[]; paraCategory?: string }): SearchResult[] {
    const results = this.engine.search(query, opts);
    logger.debug("Vault search", { query, results: results.length });
    return results;
  }

  /** 精确读取单篇笔记 */
  readNote(notePath: string): { content: string; frontmatter: Record<string, unknown> } | null {
    const fullPath = path.join(this.config.vaultPath, notePath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const { frontmatter, body } = this.parseFrontmatter(content);
      return { content: body, frontmatter };
    } catch {
      return null;
    }
  }

  /** 按 PARA 分类浏览 */
  browsePara(category: string): VaultNote[] {
    return this.engine.browseByPara(category);
  }

  /** 按标签浏览 */
  browseTag(tag: string): VaultNote[] {
    return this.engine.browseByTag(tag);
  }

  /** 获取笔记的关联网络 */
  getNetwork(notePath: string, depth = 1) {
    return this.engine.getNetwork(notePath, depth);
  }

  // ===== 记忆写入 =====

  /**
   * 写入记忆笔记
   * 自动处理 frontmatter、路径、PARA 分类
   */
  async writeNote(notePath: string, content: string, opts: WriteNoteOptions = {}): Promise<string> {
    const fullPath = path.join(this.config.vaultPath, notePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();
    const frontmatter = this.buildFrontmatter({ ...opts, created: now });

    let finalContent: string;
    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : null;

    if (opts.append && existing) {
      // 追加模式：保留原 frontmatter，追加内容
      const { body } = this.parseFrontmatter(existing);
      finalContent = frontmatter + "\n\n" + body + "\n\n" + content;
    } else if (opts.overwrite || !existing) {
      finalContent = frontmatter + "\n\n" + content;
    } else {
      throw new Error(`Note already exists: ${notePath} (use overwrite=true or append=true)`);
    }

    fs.writeFileSync(fullPath, finalContent, "utf-8");

    // 刷新索引
    this.engine.reload(this.config.vaultPath);

    logger.info("Vault note written", { path: notePath, type: opts.type });
    return notePath;
  }

  /** 追加内容到现有笔记 */
  async appendNote(notePath: string, content: string): Promise<void> {
    await this.writeNote(notePath, content, { append: true });
  }

  /** 写入原子笔记（Zettelkasten 风格） */
  async writeAtomicNote(
    title: string,
    coreIdea: string,
    opts: WriteNoteOptions & { context?: string; relatedNotes?: string[] } = {}
  ): Promise<string> {
    const slug = this.slugify(title);
    const notePath = `03-Resources/atomic-notes/${slug}.md`;
    const now = new Date().toISOString();

    const related = opts.relatedNotes?.map((r) => `- [[${r}]]`).join("\n") || "（待补充）";

    const content = `
# ${title}

## 核心观点

${coreIdea}

## 上下文

${opts.context || "（待补充）"}

## 关联

${related}

## 验证状态

- [ ] 已验证
- [ ] 待验证
`.trim();

    return this.writeNote(notePath, content, {
      ...opts,
      title,
      type: opts.type || "atomic-note",
      paraCategory: "resources",
    });
  }

  /** 写入会话日志 */
  async writeConversationLog(sessionId: string, messages: Array<{ role: string; content: string; timestamp?: string }>): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const notePath = `04-Conversations/${today.slice(0, 4)}/${today.slice(5, 7)}/${today}-${sessionId.slice(0, 8)}.md`;

    const messageLines = messages.map((m) => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("zh-CN") : "--:--";
      return `### [${time}] ${m.role}\n\n${m.content}\n`;
    }).join("\n");

    const content = `
# 会话日志 — ${today}

## 元信息

- **会话 ID**: ${sessionId}
- **时间**: ${new Date().toISOString()}
- **消息数**: ${messages.length}

## 详细记录

${messageLines}
`.trim();

    return this.writeNote(notePath, content, {
      type: "conversation-log",
      paraCategory: "conversations",
      tags: ["conversation", sessionId.slice(0, 8)],
    });
  }

  /** 写入爬取结果 */
  async writeCrawlResult(result: {
    url: string;
    title: string;
    description?: string;
    author?: string;
    siteName?: string;
    markdown: string;
    headings: Array<{ level: number; text: string }>;
    tags?: string[];
  }): Promise<string> {
    const domain = result.siteName || new URL(result.url).hostname.replace(/^www\./, "");
    const slug = this.slugify(result.title).slice(0, 60);
    const notePath = `03-Resources/web-clips/${domain}/${slug}.md`;

    const sectionList = result.headings.slice(0, 15).map((h) => `  - "${h.text.replace(/"/g, '\\"')}"`).join("\n");

    const content = result.markdown;

    return this.writeNote(notePath, content, {
      title: result.title,
      type: "web-clip",
      source: result.url,
      paraCategory: "resources",
      tags: ["web-clip", domain.replace(/\./g, "-"), ...(result.tags || [])],
    });
  }

  /** 写入搜索结果 */
  async writeSearchResult(
    query: string,
    engines: string[],
    results: Array<{ title: string; link: string; snippet: string }>
  ): Promise<string> {
    const now = new Date().toISOString();
    const slug = this.slugify(query).slice(0, 40);
    const notePath = `03-Resources/search-results/${slug}-${Date.now()}.md`;

    const resultLines = results.map((r, i) =>
      `${i + 1}. [${r.title}](${r.link})\n   > ${r.snippet.slice(0, 200)}`
    ).join("\n\n");

    const content = `
# 搜索结果 — "${query}"

## 元信息

- **查询**: ${query}
- **引擎**: ${engines.join(", ")}
- **时间**: ${now}
- **结果数**: ${results.length}

## 结果列表

${resultLines}
`.trim();

    return this.writeNote(notePath, content, {
      title: `搜索: ${query}`,
      type: "search-result",
      source: `engines:${engines.join(",")}`,
      paraCategory: "resources",
      tags: ["search", ...engines],
    });
  }

  /** 写入项目文档 */
  async writeProjectDoc(
    projectName: string,
    docName: string,
    content: string,
    opts: WriteNoteOptions = {}
  ): Promise<string> {
    const notePath = `01-Projects/${this.slugify(projectName)}/${this.slugify(docName)}.md`;
    return this.writeNote(notePath, content, {
      ...opts,
      type: opts.type || "project-doc",
      paraCategory: "projects",
    });
  }

  // ===== 代码索引 =====

  /** 索引项目代码到 Vault */
  async indexCode(): Promise<{ indexed: number; errors: string[] }> {
    const errors: string[] = [];
    try {
      const entries = await this.codeIndexer.indexAll();
      this.engine.reload(this.config.vaultPath);
      logger.info("Code indexed to Vault", { indexed: entries.length });
      return { indexed: entries.length, errors };
    } catch (e: any) {
      errors.push(e.message);
      return { indexed: 0, errors };
    }
  }

  /** 索引单个代码文件 */
  async indexCodeFile(filePath: string): Promise<boolean> {
    try {
      const entry = await this.codeIndexer.indexFile(filePath);
      if (entry) {
        this.engine.reload(this.config.vaultPath);
        return true;
      }
      return false;
    } catch (e: any) {
      logger.warn("Code index failed", { file: filePath, error: e.message });
      return false;
    }
  }

  // ===== 记忆操作 =====

  /** 创建每日日志 */
  async createDailyNote(): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const notePath = `memory/${today}.md`;
    const content = `
## 完成事项

- [ ]

## 关键配置

## 待办

- [ ]
`.trim();

    return this.writeNote(notePath, content, {
      title: today,
      type: "daily-log",
      paraCategory: "memory",
    });
  }

  /** 检查今日日志是否存在，不存在则创建 */
  async ensureDailyNote(): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const notePath = `memory/${today}.md`;
    const fullPath = path.join(this.config.vaultPath, notePath);
    if (!fs.existsSync(fullPath)) {
      return this.createDailyNote();
    }
    return notePath;
  }

  /** 获取 Vault 统计 */
  stats() {
    return this.engine.stats();
  }

  /** 重新构建索引 */
  reload(): void {
    this.engine.reload(this.config.vaultPath);
    logger.info("Vault index reloaded");
  }

  // ===== 辅助方法 =====

  private buildFrontmatter(opts: Record<string, unknown>): string {
    const lines = ["---"];
    const ordered = ["title", "type", "created", "updated", "source", "tags", "confidence"];

    for (const key of ordered) {
      if (opts[key] !== undefined) {
        const val = opts[key];
        if (Array.isArray(val)) {
          lines.push(`${key}: [${val.map((v) => `"${v}"`).join(", ")}]`);
        } else if (typeof val === "number") {
          lines.push(`${key}: ${val}`);
        } else {
          lines.push(`${key}: ${val}`);
        }
      }
    }

    // 其余未处理的字段
    for (const [key, val] of Object.entries(opts)) {
      if (ordered.includes(key)) continue;
      if (val === undefined) continue;
      if (Array.isArray(val)) {
        lines.push(`${key}: [${val.map((v) => `"${v}"`).join(", ")}]`);
      } else if (typeof val === "number") {
        lines.push(`${key}: ${val}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }

    lines.push("---");
    return lines.join("\n");
  }

  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { frontmatter: {}, body: content };

    const fm: Record<string, unknown> = {};
    const lines = match[1].split("\n");
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        if (val.startsWith("[") && val.endsWith("]")) {
          fm[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        } else if (val === "true") {
          fm[key] = true;
        } else if (val === "false") {
          fm[key] = false;
        } else if (/^\d+$/.test(val)) {
          fm[key] = Number(val);
        } else if (/^\d+\.\d+$/.test(val)) {
          fm[key] = parseFloat(val);
        } else {
          fm[key] = val.replace(/^["']|["']$/g, "");
        }
      }
    }

    return { frontmatter: fm, body: content.slice(match[0].length).trim() };
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80);
  }

  close() {
    // VaultManager 不持有需要关闭的资源
  }
}

export default VaultManager;

```