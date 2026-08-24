/**
 * 确定性记忆搜索引擎 — 磁盘优先、按需加载版
 *
 * 设计哲学：
 * - 检索以 FTS5 + 关键词打分为主（手写余弦仅 `settings-search` 可选语义层，需 embedding 时启用），PG vector 为可选历史能力
 * - 笔记内容常驻磁盘，内存仅保留轻量级索引
 * - 按需读取：匹配时用索引，返回结果时才读内容
 * - 可解释：每个结果都有明确的得分来源
 *
 * 索引结构（内存）：
 *   notes: Map<path, LiteNote> — 不含 content
 *   wikiLinkIndex, tagIndex, titleIndex, linkTargetIndex
 *
 * 内容访问（磁盘 → 可选缓存）：
 *   readContent(path) → 从 .md 文件读取，LRU 缓存热点内容
 */

import fs from "fs";
import nodePath from "path";

export interface VaultNote {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  wikiLinks: string[];
  backlinks: string[];
  wordCount: number;
  modifiedAt: number;
}

export interface SearchResult {
  note: VaultNote;
  score: number;
  reasons: string[];
  excerpt: string;
}

interface SearchOptions {
  limit?: number;
  types?: string[];
  tags?: string[];
  paraCategory?: string;
  dateRange?: { after?: string; before?: string };
  includeReasons?: boolean;
}

/** 内存中的轻量笔记索引 — 不含 content */
interface LiteNote {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  wikiLinks: string[];
  backlinks: string[];
  wordCount: number;
  modifiedAt: number;
}

interface CacheEntry {
  content: string;
  at: number; // timestamp for LRU
}

/** 纯确定性搜索引擎 — 磁盘优先、按需加载 */
export class DeterministicSearchEngine {
  private vaultPath: string;
  private notes = new Map<string, LiteNote>();
  private wikiLinkIndex = new Map<string, Set<string>>(); // link -> [paths]
  private tagIndex = new Map<string, Set<string>>();      // tag -> [paths]
  private titleIndex = new Map<string, Set<string>>();    // word -> [paths]
  private linkTargetIndex = new Map<string, Set<string>>(); // normalized -> [paths]

  // Memoization caches
  private tokenizeCache = new Map<string, string[]>();
  private paraCache = new Map<string, string>();
  /** 链接目标（文件名/归一化标题）→ 路径 映射缓存；仅在索引重建时失效 */
  private linkToPathCache: Map<string, string> | null = null;

  // Content LRU cache (on-demand disk reads)
  private contentCache = new Map<string, CacheEntry>();
  private readonly CONTENT_CACHE_MAX = 50;
  // 单次查询内容读盘的候选上限（P1-T1）：内存分降序截断，裁剪长尾零分候选的无效 IO
  private readonly CONTENT_SCAN_MAX = 200;
  // Memoization 缓存同样设上限（FIFO 驱逐），防止长运行期 tokenize/para 键无限增长
  private readonly TOKENIZE_CACHE_MAX = 200;
  private readonly PARA_CACHE_MAX = 500;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.buildIndex(vaultPath);
  }

  // ===== 索引构建（只提取元数据，不保留 content） =====

  private buildIndex(vaultPath: string) {
    this.scanDirectory(vaultPath, "");
    this.buildBacklinks();
  }

  private scanDirectory(basePath: string, relPath: string) {
    const fullPath = nodePath.join(basePath, relPath);
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "attachments") continue;
        this.scanDirectory(basePath, entryRel);
      } else if (entry.name.endsWith(".md")) {
        this.indexNote(basePath, entryRel);
      }
    }
  }

  private indexNote(basePath: string, relPath: string) {
    const fullPath = nodePath.join(basePath, relPath);
    // 读取完整文件用于索引提取（仅在 buildIndex 时发生一次）
    const raw = fs.readFileSync(fullPath, "utf-8");
    const { frontmatter, body } = this.parseFrontmatter(raw);

    const title = (frontmatter.title as string) || this.extractTitle(body) || nodePath.basename(relPath, ".md");
    const tags = this.extractTags(frontmatter, body);
    const wikiLinks = this.extractWikiLinks(body);
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const stat = fs.statSync(fullPath);

    const lite: LiteNote = {
      path: relPath,
      title,
      frontmatter,
      tags,
      wikiLinks,
      backlinks: [],
      wordCount,
      modifiedAt: stat.mtimeMs,
    };

    this.notes.set(relPath, lite);

    // 更新索引
    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
      this.tagIndex.get(tag)!.add(relPath);
    }

    for (const link of wikiLinks) {
      const normalized = this.normalizeLink(link);
      if (!this.wikiLinkIndex.has(normalized)) this.wikiLinkIndex.set(normalized, new Set());
      this.wikiLinkIndex.get(normalized)!.add(relPath);
    }

    const titleWords = this.tokenize(title);
    for (const word of titleWords) {
      if (!this.titleIndex.has(word)) this.titleIndex.set(word, new Set());
      this.titleIndex.get(word)!.add(relPath);
    }

    for (const link of wikiLinks) {
      const normalized = this.normalizeLink(link);
      if (!this.linkTargetIndex.has(normalized)) this.linkTargetIndex.set(normalized, new Set());
      this.linkTargetIndex.get(normalized)!.add(relPath);
    }
  }

  private buildBacklinks() {
    const linkToPath = this.getLinkToPath();

    for (const [sourcePath, note] of this.notes) {
      for (const link of note.wikiLinks) {
        const normalized = this.normalizeLink(link);
        const targetPath = linkToPath.get(normalized);
        if (targetPath && targetPath !== sourcePath) {
          this.notes.get(targetPath)?.backlinks.push(sourcePath);
        }
      }
    }
  }

  // ===== 内容按需读取（磁盘 → LRU 缓存） =====

  private readContent(relPath: string): string {
    const cached = this.contentCache.get(relPath);
    if (cached) {
      this.cacheHits++;
      cached.at = Date.now();
      return cached.content;
    }

    this.cacheMisses++;
    try {
      const fullPath = nodePath.join(this.vaultPath, relPath);
      const raw = fs.readFileSync(fullPath, "utf-8");
      const { body } = this.parseFrontmatter(raw);
      this.putContentCache(relPath, body);
      return body;
    } catch {
      return "";
    }
  }

  private putContentCache(relPath: string, content: string) {
    // 删除旧条目以更新 LRU 顺序
    this.contentCache.delete(relPath);
    if (this.contentCache.size >= this.CONTENT_CACHE_MAX) {
      // Map 保持插入顺序，第一个 entry 就是最旧的
      const oldest = this.contentCache.keys().next().value;
      if (oldest) this.contentCache.delete(oldest);
    }
    this.contentCache.set(relPath, { content, at: Date.now() });
  }

  private resolveNote(lite: LiteNote): VaultNote {
    return { ...lite, content: this.readContent(lite.path) };
  }

  private getNoteLite(path: string): LiteNote | undefined {
    return this.notes.get(path);
  }

  // ===== 核心搜索 =====

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const queryWords = this.tokenize(q);
    const scores = new Map<string, { s: number; r: string[] }>();

    const addScore = (path: string, delta: number, reason?: string) => {
      let entry = scores.get(path);
      if (!entry) {
        entry = { s: 0, r: [] };
        scores.set(path, entry);
      }
      entry.s += delta;
      if (reason) entry.r.push(reason);
    };

    const passesFilter = (note: LiteNote): boolean => {
      if (opts.types?.length && !opts.types.includes(String(note.frontmatter.type || ""))) return false;
      if (opts.tags?.length) {
        const noteTags = new Set(note.tags.map((t) => t.toLowerCase()));
        if (!opts.tags.every((t) => noteTags.has(t.toLowerCase()))) return false;
      }
      if (opts.paraCategory && this.getParaCategory(note.path) !== opts.paraCategory) return false;
      if (opts.dateRange) {
        const created = note.frontmatter.created as string;
        if (created) {
          if (opts.dateRange.after && created < opts.dateRange.after) return false;
          if (opts.dateRange.before && created > opts.dateRange.before) return false;
        }
      }
      return true;
    };

    // Stage 1: Exact match
    for (const [path, note] of this.notes) {
      if (!passesFilter(note)) continue;
      const fileName = nodePath.basename(path, ".md").toLowerCase();
      if (fileName === q || fileName.replace(/-/g, " ") === q) addScore(path, 100, "文件名精确匹配");
      if (note.title.toLowerCase() === q) addScore(path, 90, "标题精确匹配");
      if (note.frontmatter.id === q) addScore(path, 95, "ID 精确匹配");
      const aliases = this.getAliases(note);
      if (aliases.some((a) => a.toLowerCase() === q)) addScore(path, 85, "别名精确匹配");
    }

    // Stage 2: Keyword matching — 优先使用 titleIndex 筛选候选，避免全量扫描
    const candidatePaths = new Set<string>();
    for (const qw of queryWords) {
      const indexedPaths = this.titleIndex.get(qw);
      if (indexedPaths) {
        for (const p of indexedPaths) candidatePaths.add(p);
      }
    }
    // titleIndex 无命中时回退到全量扫描（冷启动或罕见词）；物化为数组，
    // 供主打分循环与内容有界扫描两段共用（迭代器只能消费一次）
    const pathsToScan = candidatePaths.size > 0 ? [...candidatePaths] : [...this.notes.keys()];

    // 确保候选路径在 scores 中有条目，让关系推导能正确处理
    for (const path of candidatePaths) {
      if (!scores.has(path)) {
        const note = this.notes.get(path);
        if (note && passesFilter(note)) {
          scores.set(path, { s: 0, r: [] });
        }
      }
    }

    for (const path of pathsToScan) {
      const note = this.notes.get(path);
      if (!note || !passesFilter(note)) continue;
      const entry = scores.get(path);
      const existingScore = entry?.s ?? 0;

      const titleWords = this.tokenize(note.title);
      let titleMatches = 0;
      for (const qw of queryWords) {
        for (const tw of titleWords) {
          if (tw.includes(qw) || qw.includes(tw)) titleMatches++;
        }
      }
      if (titleMatches > 0) addScore(path, Math.min(titleMatches * 15, 60), `标题关键词匹配 x${titleMatches}`);

      let tagMatches = 0;
      for (const qw of queryWords) {
        for (const tag of note.tags) {
          if (tag.toLowerCase() === qw || tag.toLowerCase().includes(qw)) tagMatches++;
        }
      }
      if (tagMatches > 0) addScore(path, Math.min(tagMatches * 12, 50), `标签匹配 x${tagMatches}`);

      // Content keywords — lazy disk read only when needed（P1-T1:移出主循环，见下方有界扫描）

      const pathLower = note.path.toLowerCase();
      let pathMatches = 0;
      for (const qw of queryWords) { if (pathLower.includes(qw)) pathMatches++; }
      if (pathMatches > 0) addScore(path, pathMatches * 5, `路径匹配 x${pathMatches}`);
    }

    // Content keywords — 有界磁盘扫描（P1-T1）：
    // 先内存打分，仅对 <80 分候选按"内存分降序"截断至 CONTENT_SCAN_MAX 后读盘，
    // 裁剪长尾冷查询的无效 IO；语义变化仅为超限零分长尾不再补内容分。
    const contentCandidates = [...pathsToScan]
      .filter((p) => {
        const n = this.notes.get(p);
        return n && passesFilter(n) && (scores.get(p)?.s ?? 0) < 80;
      })
      .sort((a, b) => (scores.get(b)?.s ?? 0) - (scores.get(a)?.s ?? 0))
      .slice(0, this.CONTENT_SCAN_MAX);
    for (const path of contentCandidates) {
      const contentLower = this.readContent(path).toLowerCase();
      let contentMatches = 0;
      for (const qw of queryWords) contentMatches += this.countOccurrences(contentLower, qw);
      if (contentMatches > 0) addScore(path, Math.min(contentMatches * 3, 30), `内容关键词 x${contentMatches}`);
    }

    // Stage 3: Relation boosting
    this.boostByRelations(scores, queryWords);

    // Stage 4: PARA semantics
    this.boostByParaSemantics(scores, q);

    // Build results: resolve VaultNote on-demand + 过滤
    const limit = opts.limit ?? 20;
    const results: SearchResult[] = [];

    for (const [path, { s, r }] of scores) {
      if (s <= 0) continue;
      const lite = this.notes.get(path);
      if (!lite || !passesFilter(lite)) continue;
      const note = this.resolveNote(lite);
      results.push({
        note,
        score: s,
        reasons: r,
        excerpt: this.generateExcerpt(note, queryWords),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.length > limit ? results.slice(0, limit) : results;
  }

  // ===== 关系推导 =====

  private boostByRelations(scores: Map<string, { s: number; r: string[] }>, queryWords: string[]) {
    const linkToPath = this.getLinkToPath();

    const mentionedPaths = new Set<string>();
    for (const [path, note] of this.notes) {
      const name = nodePath.basename(path, ".md").toLowerCase();
      const title = note.title.toLowerCase();
      for (const qw of queryWords) {
        if (name === qw || title === qw || name.includes(qw) || title.includes(qw) || name.replace(/-/g, "") === qw.replace(/\s/g, "")) {
          mentionedPaths.add(path);
        }
        // wikiLinks 匹配查询词也视为 mentioned（如 [[SQLite]] 匹配 "sqlite"）
        for (const link of note.wikiLinks) {
          if (this.normalizeLink(link) === qw) {
            mentionedPaths.add(path);
          }
        }
      }
    }

    const boost = (path: string, delta: number, reason: string) => {
      let e = scores.get(path);
      if (!e) {
        e = { s: 0, r: [] };
        scores.set(path, e);
      }
      e.s += delta;
      e.r.push(reason);
    };

    for (const mentioned of mentionedPaths) {
      const note = this.notes.get(mentioned);
      if (!note) continue;

      // 出链提升：mentioned 引用的笔记获得加分
      for (const link of note.wikiLinks) {
        const normalized = this.normalizeLink(link);
        const targetPath = linkToPath.get(normalized);
        if (targetPath && targetPath !== mentioned) {
          boost(targetPath, 10, `被 [[${note.title}]] 引用`);
        }
      }

      // 入链提升：引用 mentioned 的笔记获得加分
      for (const backPath of note.backlinks) {
        boost(backPath, 8, `引用了 [[${note.title}]]`);
      }

      // 二级关联：共同关联的笔记
      for (const link of note.wikiLinks) {
        const normalized = this.normalizeLink(link);
        const midPath = linkToPath.get(normalized);
        if (!midPath || midPath === mentioned) continue;
        const mid = this.notes.get(midPath);
        if (!mid) continue;
        for (const midLink of mid.wikiLinks) {
          const midNorm = this.normalizeLink(midLink);
          const targetPath = linkToPath.get(midNorm);
          if (!targetPath || targetPath === mentioned) continue;
          boost(targetPath, 4, `与 [[${note.title}]] 有共同关联`);
        }
      }
    }
  }

  // ===== PARA 语义 =====

  private boostByParaSemantics(scores: Map<string, { s: number; r: string[] }>, query: string) {
    const paraKeywords: Record<string, string[]> = {
      project: ["项目", "project", "proj"],
      area: ["领域", "area", "关注"],
      resource: ["资源", "resource", "参考", "ref"],
      archive: ["归档", "archive", "历史"],
    };

    for (const [paraType, keywords] of Object.entries(paraKeywords)) {
      if (keywords.some((k) => query.includes(k))) {
        for (const [path, entry] of scores) {
          if (this.getParaCategory(path) === paraType) {
            entry.s += 5;
            entry.r.push(`PARA 分类: ${paraType}`);
          }
        }
      }
    }
  }

  // ===== 辅助方法 =====

  /** 链接目标（文件名/归一化标题）→ 路径 映射；懒构建并缓存，索引重建时置空 */
  private getLinkToPath(): Map<string, string> {
    if (!this.linkToPathCache) {
      const map = new Map<string, string>();
      for (const [path, note] of this.notes) {
        const baseName = nodePath.basename(path, ".md").toLowerCase();
        map.set(baseName, path);
        map.set(this.normalizeLink(note.title), path);
      }
      this.linkToPathCache = map;
    }
    return this.linkToPathCache;
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

  private extractTitle(body: string): string | undefined {
    const m = body.match(/^#\s+(.+)$/m);
    return m?.[1]?.trim();
  }

  private extractTags(frontmatter: Record<string, unknown>, body: string): string[] {
    const tags = new Set<string>();
    const fmTags = frontmatter.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) tags.add(String(t));
    } else if (fmTags) {
      tags.add(String(fmTags));
    }
    const inlineTags = body.match(/#([\w\-\u4e00-\u9fa5]+)/g);
    if (inlineTags) {
      for (const t of inlineTags) tags.add(t.slice(1));
    }
    return Array.from(tags);
  }

  private extractWikiLinks(body: string): string[] {
    const links: string[] = [];
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    for (const m of body.matchAll(re)) {
      links.push(m[1].trim());
    }
    return links;
  }

  private getAliases(note: LiteNote): string[] {
    const alias = note.frontmatter.alias || note.frontmatter.aliases;
    if (Array.isArray(alias)) return alias.map(String);
    if (alias) return [String(alias)];
    return [];
  }

  private getParaCategory(notePath: string): string {
    let cached = this.paraCache.get(notePath);
    if (cached) return cached;
    const parts = notePath.split("/");
    if (parts[0] === "01-Projects") cached = "projects";
    else if (parts[0] === "02-Areas") cached = "areas";
    else if (parts[0] === "03-Resources") cached = "resources";
    else if (parts[0] === "04-Conversations") cached = "conversations";
    else if (parts[0] === "05-Archives") cached = "archives";
    else if (parts[0] === "05-Tasks") cached = "tasks";
    else if (parts[0] === "00-Meta") cached = "meta";
    else cached = "uncategorized";
    this.paraCache.set(notePath, cached);
    if (this.paraCache.size > this.PARA_CACHE_MAX) {
      const oldest = this.paraCache.keys().next().value;
      if (oldest) this.paraCache.delete(oldest);
    }
    return cached;
  }

  private tokenize(text: string): string[] {
    let cached = this.tokenizeCache.get(text);
    if (cached) return cached;
    cached = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 || /[\u4e00-\u9fa5]/.test(w));
    this.tokenizeCache.set(text, cached);
    if (this.tokenizeCache.size > this.TOKENIZE_CACHE_MAX) {
      const oldest = this.tokenizeCache.keys().next().value;
      if (oldest) this.tokenizeCache.delete(oldest);
    }
    return cached;
  }

  private countOccurrences(text: string, substring: string): number {
    let count = 0;
    let pos = text.indexOf(substring);
    while (pos !== -1) {
      count++;
      pos = text.indexOf(substring, pos + 1);
    }
    return count;
  }

  private normalizeLink(link: string): string {
    return link.toLowerCase().replace(/\s+/g, "-").replace(/[#^].*$/, "");
  }

  private generateExcerpt(note: VaultNote, queryWords: string[]): string {
    const lines = note.content.split("\n");
    for (const line of lines) {
      const lineLower = line.toLowerCase();
      for (const qw of queryWords) {
        if (lineLower.includes(qw) && line.trim().length > 10) {
          return line.trim().slice(0, 200);
        }
      }
    }
    return note.content.slice(0, 200).replace(/\n/g, " ");
  }

  // ===== 公共 API =====

  /** 获取单篇笔记（按需读取 content） */
  getNote(path: string): VaultNote | undefined {
    const lite = this.notes.get(path);
    if (!lite) return undefined;
    return this.resolveNote(lite);
  }

  /** 按 PARA 分类浏览（按需读取 content） */
  browseByPara(category: string): VaultNote[] {
    return Array.from(this.notes.values())
      .filter((n) => this.getParaCategory(n.path) === category)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map((lite) => this.resolveNote(lite));
  }

  /** 按标签浏览（按需读取 content） */
  browseByTag(tag: string): VaultNote[] {
    const paths = this.tagIndex.get(tag.toLowerCase());
    if (!paths) return [];
    return Array.from(paths)
      .map((p) => this.notes.get(p))
      .filter(Boolean)
      .map((lite) => this.resolveNote(lite!))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** wiki-link 入链（来源路径+标题），供 KAL 跨存储引用查询（P1-T2） */
  getWikiBacklinks(notePath: string): Array<{ path: string; title: string }> {
    const lite = this.notes.get(notePath);
    if (!lite) return [];
    return lite.backlinks
      .map((p) => this.notes.get(p))
      .filter((b): b is LiteNote => Boolean(b))
      .map((b) => ({ path: b.path, title: b.title }));
  }

  /** 获取笔记的关联网络 */
  getNetwork(notePath: string, depth = 1): { notes: VaultNote[]; relationships: Array<{ from: string; to: string; type: string }> } {
    const linkToPath = this.getLinkToPath();

    const visited = new Set<string>();
    const queue: Array<{ path: string; d: number }> = [{ path: notePath, d: 0 }];
    const notes: VaultNote[] = [];
    const relationships: Array<{ from: string; to: string; type: string }> = [];
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++];
      if (visited.has(current.path)) continue;
      visited.add(current.path);

      const lite = this.notes.get(current.path);
      if (!lite) continue;
      notes.push(this.resolveNote(lite));
      if (current.d >= depth) continue;

      for (const link of lite.wikiLinks) {
        const normalized = this.normalizeLink(link);
        const targetPath = linkToPath.get(normalized);
        if (targetPath) {
          relationships.push({ from: current.path, to: targetPath, type: "links_to" });
          if (!visited.has(targetPath)) queue.push({ path: targetPath, d: current.d + 1 });
        }
      }

      for (const back of lite.backlinks) {
        if (!visited.has(back)) {
          relationships.push({ from: back, to: current.path, type: "linked_by" });
          queue.push({ path: back, d: current.d + 1 });
        }
      }
    }

    return { notes, relationships };
  }

  /** 索引统计 */
  stats(): { totalNotes: number; totalWords: number; totalTags: number; totalLinks: number; paraDistribution: Record<string, number>; cacheHitRate: number } {
    const paraDistribution: Record<string, number> = {};
    let totalWords = 0;
    let totalTags = 0;
    let totalLinks = 0;

    for (const note of this.notes.values()) {
      const para = this.getParaCategory(note.path);
      paraDistribution[para] = (paraDistribution[para] || 0) + 1;
      totalWords += note.wordCount;
      totalTags += note.tags.length;
      totalLinks += note.wikiLinks.length;
    }

    const total = this.cacheHits + this.cacheMisses;
    const cacheHitRate = total > 0 ? Math.round((this.cacheHits / total) * 100) : 0;

    return {
      totalNotes: this.notes.size,
      totalWords,
      totalTags,
      totalLinks,
      paraDistribution,
      cacheHitRate,
    };
  }

  /** 重新加载索引 */
  /** 列出所有笔记相对路径（供 SQLite FTS 重建） */
  listNotePaths(): string[] {
    return [...this.notes.keys()];
  }

  reload(vaultPath: string) {
    this.notes.clear();
    this.wikiLinkIndex.clear();
    this.tagIndex.clear();
    this.titleIndex.clear();
    this.linkTargetIndex.clear();
    this.tokenizeCache.clear();
    this.paraCache.clear();
    this.contentCache.clear();
    this.linkToPathCache = null;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.vaultPath = vaultPath;
    this.buildIndex(vaultPath);
  }
}

export default DeterministicSearchEngine;
