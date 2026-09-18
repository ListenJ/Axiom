---
id: code-memory.deterministic-search
type: code-index
source: memory\deterministic-search.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 1978
tags: [code, auto-indexed]
exports: ["VaultNote", "SearchResult", "DeterministicSearchEngine"]
imports: ["fs", "path"]
---

# memory.deterministic-search

## 元信息

- **源文件**: `memory\deterministic-search.ts`
- **模块**: `memory.deterministic-search`
- **行数**: 608
- **索引时间**: 2026-05-25T05:11:12.537Z

## 依赖

- [[fs]]
- [[path]]

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| interface | `VaultNote` | 19 |
| interface | `SearchResult` | 31 |
| class | `DeterministicSearchEngine` | 48 |

## 代码

```typescript
/**
 * 确定性记忆搜索引擎
 *
 * 设计哲学：
 * - 零概率、零向量、零 embedding
 * - 所有匹配基于精确规则、关键词频率、图谱关系、目录结构
 * - 可解释：每个结果都有明确的得分来源
 *
 * 检索管道（四阶段漏斗）：
 *   1. 精确匹配 → 文件名/id/alias/wiki-link
 *   2. 关键词匹配 → 标题(3x) + 标签(2.5x) + 内容(1x) + 路径(0.5x)
 *   3. 关系推导 → 图谱关联 + wiki-link 网络遍历(2跳)
 *   4. PARA 语义 → 同项目/区域/资源笔记
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
  backlinks: string[];  // 被哪些笔记引用
  wordCount: number;
  modifiedAt: number;
}

export interface SearchResult {
  note: VaultNote;
  score: number;
  reasons: string[];  // 为什么匹配，用于可解释性
  excerpt: string;
}

interface SearchOptions {
  limit?: number;
  types?: string[];        // 按 frontmatter.type 过滤
  tags?: string[];         // 必须包含的标签
  paraCategory?: string;   // PARA 分类: projects/areas/resources/archives
  dateRange?: { after?: string; before?: string };
  includeReasons?: boolean;
}

/** 纯确定性搜索引擎 */
export class DeterministicSearchEngine {
  private notes = new Map<string, VaultNote>();
  private wikiLinkIndex = new Map<string, Set<string>>(); // link -> [paths]
  private tagIndex = new Map<string, Set<string>>();      // tag -> [paths]
  private titleIndex = new Map<string, Set<string>>();    // lowercase word -> [paths]

  constructor(vaultPath: string) {
    this.buildIndex(vaultPath);
  }

  // ===== 索引构建 =====

  private buildIndex(vaultPath: string) {
    this.scanDirectory(vaultPath, "");
    this.buildBacklinks();
  }

  private scanDirectory(basePath: string, relPath: string) {
    const fullPath = nodePath.join(basePath, relPath);
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      const entryFull = nodePath.join(basePath, entryRel);

      if (entry.isDirectory()) {
        // 跳过隐藏目录和附件目录
        if (entry.name.startsWith(".") || entry.name === "attachments") continue;
        this.scanDirectory(basePath, entryRel);
      } else if (entry.name.endsWith(".md")) {
        this.indexNote(basePath, entryRel);
      }
    }
  }

  private indexNote(basePath: string, relPath: string) {
    const fullPath = nodePath.join(basePath, relPath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const { frontmatter, body } = this.parseFrontmatter(content);

    const title = (frontmatter.title as string) || this.extractTitle(body) || nodePath.basename(relPath, ".md");
    const tags = this.extractTags(frontmatter, body);
    const wikiLinks = this.extractWikiLinks(body);
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const stat = fs.statSync(fullPath);

    const note: VaultNote = {
      path: relPath,
      title,
      content: body,
      frontmatter,
      tags,
      wikiLinks,
      backlinks: [],
      wordCount,
      modifiedAt: stat.mtimeMs,
    };

    this.notes.set(relPath, note);

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

    // 标题词索引
    const titleWords = this.tokenize(title);
    for (const word of titleWords) {
      if (!this.titleIndex.has(word)) this.titleIndex.set(word, new Set());
      this.titleIndex.get(word)!.add(relPath);
    }
  }

  private buildBacklinks() {
    for (const note of this.notes.values()) {
      for (const link of note.wikiLinks) {
        const normalized = this.normalizeLink(link);
        // 查找被链接的笔记
        for (const [path, target] of this.notes) {
          if (this.noteMatchesLink(target, normalized)) {
            target.backlinks.push(note.path);
          }
        }
      }
    }
  }

  private noteMatchesLink(note: VaultNote, link: string): boolean {
    const baseName = nodePath.basename(note.path, ".md").toLowerCase();
    const title = note.title.toLowerCase();
    const linkLower = link.toLowerCase();
    return baseName === linkLower || title.toLowerCase() === linkLower;
  }

  // ===== 核心搜索 =====

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const queryWords = this.tokenize(q);
    const scores = new Map<string, { score: number; reasons: Set<string> }>();

    // 阶段 1: 精确匹配（最高权重）
    for (const [path, note] of this.notes) {
      const r = new Set<string>();
      let s = 0;

      // 1a: 文件名精确匹配
      const fileName = nodePath.basename(path, ".md").toLowerCase();
      if (fileName === q || fileName.replace(/-/g, " ") === q) {
        s += 100;
        r.add("文件名精确匹配");
      }

      // 1b: 标题精确匹配
      if (note.title.toLowerCase() === q) {
        s += 90;
        r.add("标题精确匹配");
      }

      // 1c: alias 精确匹配
      const aliases = this.getAliases(note);
      if (aliases.some((a) => a.toLowerCase() === q)) {
        s += 85;
        r.add("别名精确匹配");
      }

      // 1d: id 精确匹配
      if (note.frontmatter.id === q) {
        s += 95;
        r.add("ID 精确匹配");
      }

      if (s > 0) scores.set(path, { score: s, reasons: r });
    }

    // 阶段 2: 关键词匹配
    for (const [path, note] of this.notes) {
      const existing = scores.get(path);
      const r = existing ? new Set(existing.reasons) : new Set<string>();
      let s = existing ? existing.score : 0;

      // 2a: 标题关键词（权重 3x）
      const titleWords = this.tokenize(note.title);
      let titleMatches = 0;
      for (const qw of queryWords) {
        for (const tw of titleWords) {
          if (tw.includes(qw) || qw.includes(tw)) titleMatches++;
        }
      }
      if (titleMatches > 0) {
        s += Math.min(titleMatches * 15, 60);
        r.add(`标题关键词匹配 x${titleMatches}`);
      }

      // 2b: 标签精确/前缀匹配（权重 2.5x）
      let tagMatches = 0;
      for (const qw of queryWords) {
        for (const tag of note.tags) {
          if (tag.toLowerCase() === qw || tag.toLowerCase().includes(qw)) tagMatches++;
        }
      }
      if (tagMatches > 0) {
        s += Math.min(tagMatches * 12, 50);
        r.add(`标签匹配 x${tagMatches}`);
      }

      // 2c: 内容关键词（权重 1x）
      const contentLower = note.content.toLowerCase();
      let contentMatches = 0;
      for (const qw of queryWords) {
        const count = this.countOccurrences(contentLower, qw);
        contentMatches += count;
      }
      if (contentMatches > 0) {
        s += Math.min(contentMatches * 3, 30);
        r.add(`内容关键词 x${contentMatches}`);
      }

      // 2d: 路径关键词（权重 0.5x）
      const pathLower = note.path.toLowerCase();
      let pathMatches = 0;
      for (const qw of queryWords) {
        if (pathLower.includes(qw)) pathMatches++;
      }
      if (pathMatches > 0) {
        s += pathMatches * 5;
        r.add(`路径匹配 x${pathMatches}`);
      }

      if (s > 0) scores.set(path, { score: s, reasons: r });
    }

    // 阶段 3: 关系推导（图谱 + wiki-link 网络）
    this.boostByRelations(scores, queryWords);

    // 阶段 4: PARA 语义提升
    this.boostByParaSemantics(scores, q);

    // 过滤
    let results = Array.from(scores.entries())
      .map(([path, { score, reasons }]) => {
        const note = this.notes.get(path)!;
        return {
          note,
          score,
          reasons: Array.from(reasons),
          excerpt: this.generateExcerpt(note, queryWords),
        };
      })
      .filter((r) => this.applyFilters(r.note, opts));

    // 排序
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, opts.limit ?? 20);
  }

  // ===== 关系推导 =====

  private boostByRelations(scores: Map<string, { score: number; reasons: Set<string> }>, queryWords: string[]) {
    // 找出查询中提到的已知笔记名
    const mentionedPaths = new Set<string>();
    for (const [path, note] of this.notes) {
      const name = nodePath.basename(path, ".md").toLowerCase();
      const title = note.title.toLowerCase();
      for (const qw of queryWords) {
        if (name === qw || title === qw || name.replace(/-/g, "") === qw.replace(/\s/g, "")) {
          mentionedPaths.add(path);
        }
      }
    }

    for (const mentioned of mentionedPaths) {
      const note = this.notes.get(mentioned);
      if (!note) continue;

      // 提升 wiki-link 出链（1 跳 +10）
      for (const link of note.wikiLinks) {
        const normalized = this.normalizeLink(link);
        for (const [targetPath, target] of this.notes) {
          if (this.noteMatchesLink(target, normalized)) {
            const existing = scores.get(targetPath);
            if (existing) {
              existing.score += 10;
              existing.reasons.add(`被 [[${note.title}]] 引用`);
            }
          }
        }
      }

      // 提升 backlink（被引用 +8）
      for (const backPath of note.backlinks) {
        const existing = scores.get(backPath);
        if (existing) {
          existing.score += 8;
          existing.reasons.add(`引用了 [[${note.title}]]`);
        }
      }

      // 2 跳网络
      for (const link of note.wikiLinks) {
        const normalized = this.normalizeLink(link);
        for (const [midPath, mid] of this.notes) {
          if (!this.noteMatchesLink(mid, normalized)) continue;
          for (const midLink of mid.wikiLinks) {
            const midNormalized = this.normalizeLink(midLink);
            for (const [targetPath, target] of this.notes) {
              if (targetPath === mentioned) continue;
              if (this.noteMatchesLink(target, midNormalized)) {
                const existing = scores.get(targetPath);
                if (existing) {
                  existing.score += 4;
                  existing.reasons.add(`与 [[${note.title}]] 有共同关联`);
                }
              }
            }
          }
        }
      }
    }
  }

  // ===== PARA 语义 =====

  private boostByParaSemantics(scores: Map<string, { score: number; reasons: Set<string> }>, query: string) {
    // 如果查询包含项目名，提升同一项目下的笔记
    const paraKeywords: Record<string, string[]> = {
      project: ["项目", "project", "proj"],
      area: ["领域", "area", "关注"],
      resource: ["资源", "resource", "参考", "ref"],
      archive: ["归档", "archive", "历史"],
    };

    for (const [paraType, keywords] of Object.entries(paraKeywords)) {
      if (keywords.some((k) => query.includes(k))) {
        for (const [path, entry] of scores) {
          const para = this.getParaCategory(path);
          if (para === paraType) {
            entry.score += 5;
            entry.reasons.add(`PARA 分类: ${paraType}`);
          }
        }
      }
    }
  }

  // ===== 过滤 =====

  private applyFilters(note: VaultNote, opts: SearchOptions): boolean {
    if (opts.types && opts.types.length > 0) {
      const noteType = String(note.frontmatter.type || "");
      if (!opts.types.includes(noteType)) return false;
    }

    if (opts.tags && opts.tags.length > 0) {
      const noteTags = new Set(note.tags.map((t) => t.toLowerCase()));
      for (const tag of opts.tags) {
        if (!noteTags.has(tag.toLowerCase())) return false;
      }
    }

    if (opts.paraCategory) {
      if (this.getParaCategory(note.path) !== opts.paraCategory) return false;
    }

    if (opts.dateRange) {
      const created = note.frontmatter.created as string;
      if (created) {
        if (opts.dateRange.after && created < opts.dateRange.after) return false;
        if (opts.dateRange.before && created > opts.dateRange.before) return false;
      }
    }

    return true;
  }

  // ===== 辅助方法 =====

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
    // 内联标签 #tag
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

  private getAliases(note: VaultNote): string[] {
    const alias = note.frontmatter.alias || note.frontmatter.aliases;
    if (Array.isArray(alias)) return alias.map(String);
    if (alias) return [String(alias)];
    return [];
  }

  private getParaCategory(notePath: string): string {
    const parts = notePath.split("/");
    if (parts[0] === "01-Projects") return "project";
    if (parts[0] === "02-Areas") return "area";
    if (parts[0] === "03-Resources") return "resource";
    if (parts[0] === "04-Conversations") return "conversation";
    if (parts[0] === "05-Archives") return "archive";
    if (parts[0] === "05-Tasks") return "task";
    if (parts[0] === "00-Meta") return "meta";
    return "uncategorized";
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 || /[\u4e00-\u9fa5]/.test(w));
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

  /** 获取单篇笔记 */
  getNote(path: string): VaultNote | undefined {
    return this.notes.get(path);
  }

  /** 按 PARA 分类浏览 */
  browseByPara(category: string): VaultNote[] {
    return Array.from(this.notes.values())
      .filter((n) => this.getParaCategory(n.path) === category)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** 按标签浏览 */
  browseByTag(tag: string): VaultNote[] {
    const paths = this.tagIndex.get(tag.toLowerCase());
    if (!paths) return [];
    return Array.from(paths)
      .map((p) => this.notes.get(p)!)
      .filter(Boolean)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** 获取笔记的关联网络（wiki-link 1跳） */
  getNetwork(notePath: string, depth = 1): { notes: VaultNote[]; relationships: Array<{ from: string; to: string; type: string }> } {
    const visited = new Set<string>();
    const queue: Array<{ path: string; d: number }> = [{ path: notePath, d: 0 }];
    const notes: VaultNote[] = [];
    const relationships: Array<{ from: string; to: string; type: string }> = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);

      const note = this.notes.get(current.path);
      if (!note) continue;
      notes.push(note);
      if (current.d >= depth) continue;

      // 出链
      for (const link of note.wikiLinks) {
        const normalized = this.normalizeLink(link);
        for (const [p, n] of this.notes) {
          if (this.noteMatchesLink(n, normalized)) {
            relationships.push({ from: current.path, to: p, type: "links_to" });
            if (!visited.has(p)) queue.push({ path: p, d: current.d + 1 });
          }
        }
      }

      // 入链
      for (const back of note.backlinks) {
        if (!visited.has(back)) {
          relationships.push({ from: back, to: current.path, type: "linked_by" });
          queue.push({ path: back, d: current.d + 1 });
        }
      }
    }

    return { notes, relationships };
  }

  /** 索引统计 */
  stats(): { totalNotes: number; totalWords: number; totalTags: number; totalLinks: number; paraDistribution: Record<string, number> } {
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

    return {
      totalNotes: this.notes.size,
      totalWords,
      totalTags,
      totalLinks,
      paraDistribution,
    };
  }

  /** 重新加载索引 */
  reload(vaultPath: string) {
    this.notes.clear();
    this.wikiLinkIndex.clear();
    this.tagIndex.clear();
    this.titleIndex.clear();
    this.buildIndex(vaultPath);
  }
}

export default DeterministicSearchEngine;

```