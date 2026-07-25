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
import { SQLiteMemory } from "./sqlite-memory.js";
import { getMemoryGate, type SignificanceContext } from "./memory-gate.js";
import { logger } from "../utils/logger.js";

interface VaultConfig {
  vaultPath: string;
  apiPort: number;
  apiToken: string;
  dbPath?: string;
}

interface WriteNoteOptions {
  title?: string | undefined;
  tags?: string[] | undefined;
  type?: string | undefined;
  source?: string | undefined;
  confidence?: number | undefined;
  paraCategory?: "projects" | "areas" | "resources" | "archives" | "conversations" | "meta" | "memory" | undefined;
  append?: boolean | undefined;
  overwrite?: boolean | undefined;
  /** Smart gate context — if provided, memory-gate decides whether to write */
  gateContext?: SignificanceContext | undefined;
}

export class VaultManager {
  private config: VaultConfig;
  private engine: DeterministicSearchEngine;
  private baseUrl: string;
  private codeIndexer: CodeIndexer;
  private sqliteMemory: SQLiteMemory;
  private slugifyCache = new Map<string, string>();
  private readonly SLUGIFY_CACHE_MAX = 1000;

  constructor(config: Partial<VaultConfig> = {}) {
    this.config = {
      vaultPath: config.vaultPath || process.env.OBSIDIAN_VAULT_PATH || "./axiom-memory",
      apiPort: config.apiPort || Number(process.env.OBSIDIAN_API_PORT) || 27124,
      apiToken: config.apiToken || process.env.OBSIDIAN_API_TOKEN || "",
      dbPath: config.dbPath,
    };
    this.baseUrl = `https://127.0.0.1:${this.config.apiPort}`;

    this.engine = new DeterministicSearchEngine(this.config.vaultPath);
    this.codeIndexer = new CodeIndexer({
      sourceRoot: "./src",
      vaultRoot: this.config.vaultPath,
    });

    this.sqliteMemory = new SQLiteMemory(this.config.dbPath);

    logger.info("VaultManager initialized", {
      vaultPath: this.config.vaultPath,
      notes: this.engine.stats().totalNotes,
    });
  }

  // ===== 确定性检索 =====

  /** 全文搜索 — SQLite FTS5 为主，确定性引擎为 fallback */
  search(query: string, opts?: { limit?: number; types?: string[]; tags?: string[]; paraCategory?: string }): SearchResult[] {
    const limit = opts?.limit ?? 10;

    // 1. SQLite FTS5 搜索（主要）
    const ftsResults = this.sqliteMemory.search(query, {
      limit,
      tags: opts?.tags,
      paraCategory: opts?.paraCategory,
      type: opts?.types?.[0],
    });

    let results: SearchResult[] = ftsResults.map((r) => ({
      note: this.memoryRecordToVaultNote(r.record),
      score: r.score,
      reasons: ["fts5-match"],
      excerpt: r.excerpt,
    }));

    // 2. 结果不足或质量低时用确定性引擎补充
    const minResults = 3;
    const minQuality = -2.0; // FTS rank 是负数，越接近 0 越差
    const needsFallback = results.length < minResults ||
      (results.length > 0 && results[0].score > minQuality);
    if (needsFallback) {
      const fallback = this.engine.search(query, opts);
      const seen = new Set(results.map((r) => r.note.path));
      for (const r of fallback) {
        if (!seen.has(r.note.path)) {
          results.push(r);
          seen.add(r.note.path);
        }
      }
      results = results.slice(0, limit);
    }

    logger.debug("Vault search", { query, fts: ftsResults.length, total: results.length });
    return results;
  }

  private memoryRecordToVaultNote(record: import("./sqlite-memory.js").MemoryRecord): VaultNote {
    return {
      path: record.path,
      title: record.title,
      content: record.content,
      frontmatter: {}, // FTS index 不保留 frontmatter，需要时可从文件读取
      tags: record.tags,
      wikiLinks: [],
      backlinks: [],
      wordCount: record.content.split(/\s+/).length,
      modifiedAt: record.updatedAt,
    };
  }

  /** 精确读取单篇笔记 */
  readNote(notePath: string): { content: string; frontmatter: Record<string, unknown> } | null {
    try {
      const fullPath = this.resolveSafePath(notePath);
      const content = fs.readFileSync(fullPath, "utf-8");
      const { frontmatter, body } = this.parseFrontmatter(content);
      return { content: body, frontmatter };
    } catch (e) {
      logger.warn("readNote failed", { path: notePath, error: e instanceof Error ? e.message : String(e) });
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
    // Smart gate: skip low-value writes if context provided
    // 边缘增强版：规则灰区由边缘小模型裁决（失败回退规则结果）
    if (opts.gateContext) {
      const gate = getMemoryGate();
      const decision = await gate.shouldWriteWithEdge(content, content, opts.gateContext);
      if (!decision.shouldWrite) {
        logger.info("[MemoryGate] Write skipped", { path: notePath, reason: decision.reason, category: decision.category });
        return notePath;
      }
    }

    const fullPath = this.resolveSafePath(notePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();
    const frontmatter = this.buildFrontmatter({ ...opts, created: now });

    let finalContent: string;
    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : null;

    if (opts.append && existing) {
      const { body } = this.parseFrontmatter(existing);
      finalContent = frontmatter + "\n\n" + body + "\n\n" + content;
    } else if (opts.overwrite || !existing) {
      finalContent = frontmatter + "\n\n" + content;
    } else {
      throw new Error(`Note already exists: ${notePath} (use overwrite=true or append=true)`);
    }

    fs.writeFileSync(fullPath, finalContent, "utf-8");

    // Sync to SQLite index
    const stat = fs.statSync(fullPath);
    this.sqliteMemory.upsertNote({
      path: notePath,
      title: opts.title || path.basename(notePath, ".md"),
      content: finalContent,
      excerpt: finalContent.slice(0, 500).replace(/\n/g, " "),
      tags: opts.tags || [],
      paraCategory: opts.paraCategory || "resources",
      type: opts.type || "note",
      source: opts.source,
      confidence: opts.confidence ?? 0.7,
      createdAt: stat.birthtimeMs || stat.ctimeMs,
      updatedAt: stat.mtimeMs,
    });

    // SQLite FTS index updated via upsertNote above.
    // Deterministic engine rebuilds lazily on next search if needed.

    // Record write for gate dedup tracking
    if (opts.gateContext) {
      const gate = getMemoryGate();
      const hash = `${notePath}:${content.slice(0, 200)}`;
      gate.recordWrite(hash, notePath);
    }

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

  /** 写入 SerpAPI 完整结构化搜索结果 */
  async writeSerpApiResult(
    query: string,
    response: Record<string, unknown>,
    opts?: {
      location?: string;
      googleDomain?: string;
      lang?: string;
      region?: string;
      latencyMs?: number;
    }
  ): Promise<string> {
    const now = new Date().toISOString();
    const slug = this.slugify(query).slice(0, 40);
    const notePath = `03-Resources/search-results/${slug}-${Date.now()}.md`;

    const meta = response.search_metadata as Record<string, unknown> | undefined;
    const params = response.search_parameters as Record<string, unknown> | undefined;
    const info = response.search_information as Record<string, unknown> | undefined;
    const organic = (response.organic_results || []) as Array<Record<string, unknown>>;
    const knowledgeGraph = response.knowledge_graph as Record<string, unknown> | undefined;
    const relatedQuestions = (response.related_questions || []) as Array<Record<string, unknown>>;
    const relatedSearches = (response.related_searches || []) as Array<Record<string, unknown>>;
    const images = (response.images_results || []) as Array<Record<string, unknown>>;
    const videos = (response.videos_results || []) as Array<Record<string, unknown>>;
    const news = (response.news_results || []) as Array<Record<string, unknown>>;
    const searchId = (meta?.id as string) || "unknown";

    // 有机结果
    const organicLines = organic
      .slice(0, 20)
      .map((r, i) => {
        const title = String(r.title || "Untitled");
        const link = String(r.link || "");
        const snippet = String(r.snippet || "").slice(0, 300);
        const date = r.date ? ` (${r.date})` : "";
        const displayed = r.displayed_link ? ` — \`${r.displayed_link}\`` : "";
        return `${i + 1}. **[${title}](${link})**${date}${displayed}\n   > ${snippet}`;
      })
      .join("\n\n");

    // 知识图谱
    let kgSection = "";
    if (knowledgeGraph) {
      const kgTitle = String(knowledgeGraph.title || "");
      const kgType = String(knowledgeGraph.type || "");
      const kgDesc = String(knowledgeGraph.description || "");
      const kgWebsite = String(knowledgeGraph.website || "");
      const kgImage = String(knowledgeGraph.image || "");
      const formatKgValue = (v: unknown): string => {
        if (v === null || v === undefined) return "—";
        if (typeof v === "string") return v.slice(0, 200);
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (Array.isArray(v)) {
          if (v.length === 0) return "[]";
          const first = v[0];
          if (typeof first === "object" && first !== null) {
            const names = v.map((item: any) => item.name || item.title || item.query || JSON.stringify(item).slice(0, 40)).join(", ");
            return `[${v.length} items] ${names.slice(0, 160)}`;
          }
          return JSON.stringify(v).slice(0, 200);
        }
        if (typeof v === "object") {
          const obj = v as Record<string, unknown>;
          const name = obj.name || obj.title || obj.text || obj.link;
          if (name) return String(name).slice(0, 200);
          return JSON.stringify(v).slice(0, 200);
        }
        return String(v).slice(0, 200);
      };

      const extraRows = Object.entries(knowledgeGraph)
        .filter(([k]) => !["title", "type", "description", "website", "image", "thumbnail"].includes(k))
        .slice(0, 10)
        .map(([k, v]) => `| ${k} | ${formatKgValue(v)} |`)
        .join("\n");

      kgSection = `\n## 知识图谱\n\n| 字段 | 内容 |\n|------|------|\n| 标题 | ${kgTitle} |\n| 类型 | ${kgType} |\n| 描述 | ${kgDesc.slice(0, 300)} |${kgWebsite ? `\n| 网站 | ${kgWebsite} |` : ""}${kgImage ? `\n| 图片 | ![KG](${kgImage}) |` : ""}${extraRows ? "\n" + extraRows : ""}\n`;
    }

    // 相关问题
    let rqSection = "";
    if (relatedQuestions.length > 0) {
      const lines = relatedQuestions
        .slice(0, 10)
        .map((q) => `- **${q.question}**${q.snippet ? `\n  > ${String(q.snippet).slice(0, 200)}` : ""}`)
        .join("\n");
      rqSection = `\n## 相关问题 (People Also Ask)\n\n${lines}\n`;
    }

    // 关联搜索
    let rsSection = "";
    if (relatedSearches.length > 0) {
      const chips = relatedSearches
        .slice(0, 15)
        .map((r) => `\`#${this.slugify(String(r.query)).replace(/-/g, " ")}\``)
        .join(" ");
      rsSection = `\n## 关联搜索\n\n${chips}\n`;
    }

    // 图片结果
    let imgSection = "";
    if (images.length > 0) {
      const imgLines = images
        .slice(0, 8)
        .map((img) => `- ![${img.title || ""}](${img.thumbnail || img.original || ""}) [${img.title || ""}](${img.link || ""})`)
        .join("\n");
      imgSection = `\n## 图片结果 (${images.length})\n\n${imgLines}\n`;
    }

    // 视频结果
    let vidSection = "";
    if (videos.length > 0) {
      const vidLines = videos
        .slice(0, 8)
        .map((v) => `- [${v.title || ""}](${v.link || ""}) (${v.channel || ""} · ${v.duration || ""})`)
        .join("\n");
      vidSection = `\n## 视频结果 (${videos.length})\n\n${vidLines}\n`;
    }

    // 新闻结果
    let newsSection = "";
    if (news.length > 0) {
      const newsLines = news
        .slice(0, 8)
        .map((n) => `- **[${n.title || ""}](${n.link || ""})** — ${n.source || ""} · ${n.date || ""}\n  > ${String(n.snippet || "").slice(0, 150)}`)
        .join("\n");
      newsSection = `\n## 新闻结果 (${news.length})\n\n${newsLines}\n`;
    }

    // 原始 JSON 折叠块
    const rawJson = JSON.stringify(response, null, 2);
    const rawSection = `\n## 原始数据 (JSON)\n\n> 以下数据为 SerpAPI 返回的完整原始响应，供程序化使用。\n\n<details>\n<summary>展开查看原始 JSON (${rawJson.length.toLocaleString()} 字符)</summary>\n\n\`\`\`json\n${rawJson}\n\`\`\`\n\n</details>\n`;

    const content = `
# SerpAPI 搜索结果 — "${query}"

## 查询摘要

| 字段 | 值 |
|------|-----|
| 查询词 | ${query} |
| 搜索引擎 | Google (via SerpAPI) |
| 搜索 ID | \`${searchId}\` |
| 结果总数 | ${info?.total_results ?? organic.length} |
| 有机结果 | ${organic.length} |
| 知识图谱 | ${knowledgeGraph ? "[有]" : "[无]"} |
| 相关问题 | ${relatedQuestions.length} |
| 关联搜索 | ${relatedSearches.length} |
| 图片结果 | ${images.length} |
| 视频结果 | ${videos.length} |
| 新闻结果 | ${news.length} |
| 地理位置 | ${opts?.location || params?.location || "—"} |
| 语言/区域 | ${opts?.lang || params?.hl || "—"} / ${opts?.region || params?.gl || "—"} |
| 耗时 | ${opts?.latencyMs ?? "—"} ms |
| 抓取时间 | ${now} |
| 原始链接 | ${meta?.google_url || "—"} |

## 有机结果 (${organic.length})

${organicLines || "（无）"}
${kgSection}${rqSection}${rsSection}${imgSection}${vidSection}${newsSection}${rawSection}
## 索引与标签

#search #serpapi #google${query.split(/\s+/).map((w) => ` #${this.slugify(w).replace(/-/g, "_")}`).join("")}
`.trim();

    return this.writeNote(notePath, content, {
      title: `SerpAPI: ${query}`,
      type: "serpapi-search-result",
      source: `https://serpapi.com/searches/${searchId}`,
      paraCategory: "resources",
      tags: ["search", "serpapi", "google", "structured-data", ...query.split(/\s+/).filter((w) => w.length > 1).slice(0, 5)],
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
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
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
    } catch (e) {
      logger.warn("Code index failed", { file: filePath, error: e instanceof Error ? e.message : String(e) });
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
    const fullPath = this.resolveSafePath(notePath);
    if (!fs.existsSync(fullPath)) {
      return this.createDailyNote();
    }
    return notePath;
  }

  /** 获取 Vault 统计 */
  stats() {
    return this.engine.stats();
  }

  /** 获取搜索引擎实例（用于外部同步，如文件监视器） */
  getEngine(): DeterministicSearchEngine {
    return this.engine;
  }

  /** 获取SQLite记忆索引实例 */
  getSqliteMemory(): SQLiteMemory {
    return this.sqliteMemory;
  }

  /** 重新构建索引 */
  reload(): void {
    this.engine.reload(this.config.vaultPath);
    logger.info("Vault index reloaded");
  }

  // ===== 辅助方法 =====

  /**
   * Resolve a note path safely within the vault directory.
   * Blocks path traversal attempts (e.g. ../../etc/passwd).
   */
  private resolveSafePath(notePath: string): string {
    const resolved = path.resolve(this.config.vaultPath, notePath);
    const base = path.resolve(this.config.vaultPath);
    const relative = path.relative(base, resolved);
    if (relative.startsWith("..") || relative === "..") {
      throw new Error(`Path traversal blocked: ${notePath}`);
    }
    return resolved;
  }

  private buildFrontmatter(opts: Record<string, unknown>): string {
    const fmKeys = ["title", "type", "created", "updated", "source", "tags", "confidence"];
    const fmEntries: Array<[string, unknown]> = [];
    const extraEntries: Array<[string, unknown]> = [];

    // Single-pass partition: ordered keys first, rest after
    for (const [k, v] of Object.entries(opts)) {
      if (v === undefined) continue;
      if (fmKeys.includes(k)) fmEntries.push([k, v]);
      else extraEntries.push([k, v]);
    }

    // Ensure order
    fmEntries.sort((a, b) => fmKeys.indexOf(a[0]) - fmKeys.indexOf(b[0]));

    const formatVal = (val: unknown): string => {
      if (Array.isArray(val)) return `[${val.map((v) => `"${v}"`).join(", ")}]`;
      return String(val);
    };

    const lines: string[] = ["---"];
    for (const [k, v] of fmEntries) lines.push(`${k}: ${formatVal(v)}`);
    for (const [k, v] of extraEntries) lines.push(`${k}: ${formatVal(v)}`);
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
    let cached = this.slugifyCache.get(text);
    if (cached) return cached;
    cached = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80);
    // LRU: evict oldest entries when cache grows too large
    if (this.slugifyCache.size >= this.SLUGIFY_CACHE_MAX) {
      const firstKey = this.slugifyCache.keys().next().value;
      if (firstKey !== undefined) {
        this.slugifyCache.delete(firstKey);
      }
    }
    this.slugifyCache.set(text, cached);
    return cached;
  }

  close() {
    this.sqliteMemory.close();
  }
}

/** 全局 VaultManager 单例 — 防止同一进程中重复实例化导致内存浪费 */
let _globalVault: VaultManager | null = null;
export function getGlobalVault(): VaultManager {
  if (!_globalVault) {
    _globalVault = new VaultManager();
  }
  return _globalVault;
}

export default VaultManager;
