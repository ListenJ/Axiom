/**
 * 知识编译（Knowledge Wiki）— Layer 2
 *
 * 设计目标（对应用户方向二：彻底抛弃向量数据库——"无向量"RAG）：
 *   - LLM Wiki（知识编译）：将原始文档"编译"成结构化知识条目，查询时直接读取精炼知识，
 *     提升推理可靠性和效率。
 *
 * 确定性实现（与 Layer 0/1/3 一致，消除"黑盒套黑盒"）：
 *   原始 LLM Wiki 概念使用 LLM 预编译，但本架构强约束"确定性推理"——
 *   因此采用确定性规则提取（词频/正则/交叉引用检测），零 LLM 调用，
 *   编译过程完全可复现、可追溯。
 *
 * 编译维度（5 项确定性提取）：
 *   1. 标题提取：首行 / # 标题 / 文件名
 *   2. 摘要：首 200 字符
 *   3. 关键词：词频分析（去停用词，取 top 10）
 *   4. 概念：大写词 / camelCase / 技术术语（正则）
 *   5. 数值事实：数值 + ±50 字符上下文
 *   6. 交叉引用：其他文档标题在本文档内容中的出现
 *
 * 架构分层位置：
 *   Layer 0（检索）→ Layer 1（GraphRAG）→ Layer 2（知识编译）→ Layer 3（验证）
 *   编译后的 WikiEntry 可作为 KeywordSearcher 注入 Layer 0，或注入知识图谱。
 *
 * 设计原则（遵循 AGENTS.md 规则 8 深模块设计）：
 *   - 小接口：compileDocument / searchByKeyword / getEntry
 *   - 接受依赖不创建依赖：CompiledDocument 作为参数传入
 *   - 接口即测试面：全部可通过公共接口验证
 */

import { logger } from "../../utils/logger.js";

// ─── 公共类型 ────────────────────────────────────────────────────────────

/** 数值事实 — 数值 + 上下文 */
export interface NumericalFact {
  /** 数值 */
  value: number;
  /** 周围文本（前后各 ~50 字符） */
  context: string;
}

/** 编译后的知识条目 — 结构化知识单元 */
export interface WikiEntry {
  /** 条目 ID（source + title 的哈希） */
  id: string;
  /** 提取的标题 */
  title: string;
  /** 摘要（首 200 字符） */
  summary: string;
  /** 关键词（词频 top N，去停用词） */
  keywords: string[];
  /** 概念（大写词 / camelCase / 技术术语） */
  concepts: string[];
  /** 数值事实 */
  numericalFacts: NumericalFact[];
  /** 交叉引用（其他文档标题在本文档中出现） */
  relatedTitles: string[];
  /** 原始文档路径 */
  source: string;
  /** 编译时间戳 */
  compiledAt: number;
}

/** 待编译的原始文档 */
export interface CompiledDocument {
  /** 文档路径（唯一标识） */
  path: string;
  /** 文档标题（可选，缺省则从内容提取） */
  title?: string;
  /** 文档内容 */
  content: string;
}

/** Wiki 统计信息 */
export interface WikiStats {
  totalEntries: number;
  totalKeywords: number;
  totalConcepts: number;
  totalNumericalFacts: number;
  totalCrossRefs: number;
}

/** 编译选项 */
export interface CompileOptions {
  /** 关键词提取数量上限（默认 10） */
  maxKeywords?: number;
  /** 概念提取数量上限（默认 15） */
  maxConcepts?: number;
  /** 数值事实提取数量上限（默认 20） */
  maxNumericalFacts?: number;
  /** 摘要长度（默认 200） */
  summaryLength?: number;
}

// ─── 停用词（中英文）────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // 英文
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "must", "can", "this", "that",
  "these", "those", "i", "you", "he", "she", "it", "we", "they",
  "what", "which", "who", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such",
  "no", "not", "only", "own", "same", "so", "than", "too", "very",
  "as", "if", "then", "else", "when", "up", "out", "into", "over",
  // 中文单字（无实义）
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
  "一", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没", "看", "好", "自", "己", "这", "那", "他", "她", "们", "个",
]);

// ─── 分词器（与 deterministic-retrieval-engine 一致）────────────────────

function tokenize(text: string): string[] {
  if (!text) return [];
  const english = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  return [
    ...english.filter((t) => t.length >= 2),
    ...chinese,
  ];
}

// ─── 知识编译器 ──────────────────────────────────────────────────────────

/**
 * 知识编译器 — 将原始文档确定性编译为结构化知识条目
 *
 * 编译流程（纯确定性，可复现）：
 *   1. 标题提取
 *   2. 摘要截取
 *   3. 词频分析 → 关键词
 *   4. 正则匹配 → 概念
 *   5. 数值提取 → 数值事实
 *   6. 标题匹配 → 交叉引用
 */
export class KnowledgeWiki {
  private readonly entries = new Map<string, WikiEntry>();
  private readonly titleIndex = new Map<string, string>(); // title -> entryId
  private readonly sourceIndex = new Map<string, string>(); // source -> entryId
  private readonly keywordIndex = new Map<string, Set<string>>(); // keyword -> entryIds
  private readonly conceptIndex = new Map<string, Set<string>>(); // concept -> entryIds
  private readonly options: Required<CompileOptions>;

  constructor(opts: CompileOptions = {}) {
    this.options = {
      maxKeywords: opts.maxKeywords ?? 10,
      maxConcepts: opts.maxConcepts ?? 15,
      maxNumericalFacts: opts.maxNumericalFacts ?? 20,
      summaryLength: opts.summaryLength ?? 200,
    };
  }

  /**
   * 编译单个文档 — 返回结构化知识条目
   *
   * 若同一 source 已存在，覆盖旧条目（重新编译）。
   */
  compileDocument(doc: CompiledDocument): WikiEntry {
    const title = this.extractTitle(doc);
    const summary = this.extractSummary(doc.content);
    const keywords = this.extractKeywords(doc.content);
    const concepts = this.extractConcepts(doc.content);
    const numericalFacts = this.extractNumericalFacts(doc.content);
    const relatedTitles = this.detectCrossReferences(doc.content, title);
    const id = this.computeId(doc.path, title);

    const entry: WikiEntry = {
      id,
      title,
      summary,
      keywords,
      concepts,
      numericalFacts,
      relatedTitles,
      source: doc.path,
      compiledAt: Date.now(),
    };

    // 更新索引（若覆盖旧条目，先清理旧索引）
    // 1. 同 ID 的旧条目（标题未变）
    const existingById = this.entries.get(id);
    if (existingById) {
      this.removeFromIndex(existingById);
    }
    // 2. 同 source 的旧条目（标题变化导致 ID 变化）
    const existingBySource = this.sourceIndex.get(doc.path);
    if (existingBySource && existingBySource !== id) {
      const oldEntry = this.entries.get(existingBySource);
      if (oldEntry) this.removeFromIndex(oldEntry);
    }
    this.entries.set(id, entry);
    this.addToIndex(entry);

    logger.debug("[DRE/Wiki] 文档编译完成", {
      source: doc.path,
      title: title.slice(0, 50),
      keywords: keywords.length,
      concepts: concepts.length,
      numericalFacts: numericalFacts.length,
      crossRefs: relatedTitles.length,
    });

    return entry;
  }

  /**
   * 批量编译 — 编译多个文档并建立交叉引用
   *
   * 两轮编译：
   *   1. 第一轮：编译所有文档（交叉引用检测仅基于已编译条目）
   *   2. 第二轮：重新检测交叉引用（此时所有条目都已存在）
   */
  compileBatch(docs: CompiledDocument[]): WikiEntry[] {
    // 第一轮：编译所有文档
    const entries = docs.map((doc) => this.compileDocument(doc));

    // 第二轮：重新检测交叉引用（所有标题现已可用）
    for (const entry of entries) {
      const allTitles = entries
        .map((e) => e.title)
        .filter((t) => t !== entry.title);
      const content = entry.summary; // 仅用摘要做交叉引用检测（性能）
      const crossRefs = this.findTitleMatches(content, allTitles, entry.title);
      if (crossRefs.length > 0) {
        entry.relatedTitles = [...new Set([...entry.relatedTitles, ...crossRefs])];
      }
    }

    logger.debug("[DRE/Wiki] 批量编译完成", {
      total: entries.length,
      crossRefs: entries.reduce((sum, e) => sum + e.relatedTitles.length, 0),
    });

    return entries;
  }

  /** 获取条目 by ID */
  getEntry(id: string): WikiEntry | undefined {
    return this.entries.get(id);
  }

  /** 获取条目 by 标题 */
  getByTitle(title: string): WikiEntry | undefined {
    const id = this.titleIndex.get(title);
    return id ? this.entries.get(id) : undefined;
  }

  /**
   * 按关键词搜索 — 返回包含该关键词的条目
   *
   * 匹配范围：keywords + concepts + title
   */
  searchByKeyword(keyword: string, limit = 20): WikiEntry[] {
    const lower = keyword.toLowerCase();
    const ids = new Set<string>();

    // 从关键词索引查找
    const kwIds = this.keywordIndex.get(lower);
    if (kwIds) for (const id of kwIds) ids.add(id);

    // 从概念索引查找
    const conceptIds = this.conceptIndex.get(keyword);
    if (conceptIds) for (const id of conceptIds) ids.add(id);

    // 从标题索引查找（子串匹配）
    for (const [title, id] of this.titleIndex) {
      if (title.toLowerCase().includes(lower)) ids.add(id);
    }

    return Array.from(ids)
      .map((id) => this.entries.get(id)!)
      .filter((e) => e !== undefined)
      .slice(0, limit);
  }

  /** 按概念搜索 */
  searchByConcept(concept: string, limit = 20): WikiEntry[] {
    const ids = this.conceptIndex.get(concept);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.entries.get(id)!)
      .filter((e) => e !== undefined)
      .slice(0, limit);
  }

  /** 获取所有条目 */
  getAllEntries(): WikiEntry[] {
    return Array.from(this.entries.values());
  }

  /** 获取统计信息 */
  getStats(): WikiStats {
    let totalKeywords = 0;
    let totalConcepts = 0;
    let totalNumericalFacts = 0;
    let totalCrossRefs = 0;
    for (const entry of this.entries.values()) {
      totalKeywords += entry.keywords.length;
      totalConcepts += entry.concepts.length;
      totalNumericalFacts += entry.numericalFacts.length;
      totalCrossRefs += entry.relatedTitles.length;
    }
    return {
      totalEntries: this.entries.size,
      totalKeywords,
      totalConcepts,
      totalNumericalFacts,
      totalCrossRefs,
    };
  }

  /** 清空所有条目 */
  clear(): void {
    this.entries.clear();
    this.titleIndex.clear();
    this.sourceIndex.clear();
    this.keywordIndex.clear();
    this.conceptIndex.clear();
  }

  // ─── 编译子流程（私有，确定性）────────────────────────────────────────

  /** 提取标题：显式标题 > 首行 > 文件名 */
  private extractTitle(doc: CompiledDocument): string {
    if (doc.title && doc.title.trim().length > 0) return doc.title.trim();

    const lines = doc.content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return doc.path;

    // 检查首行是否是 Markdown 标题
    const firstLine = lines[0];
    const mdHeading = firstLine.match(/^#+\s*(.+)$/);
    if (mdHeading) return mdHeading[1].trim();

    // 首行作为标题（截断到 80 字符）
    return firstLine.slice(0, 80);
  }

  /** 提取摘要：首 N 字符（去除 Markdown 标记） */
  private extractSummary(content: string): string {
    const cleaned = content
      .replace(/^#+\s*/gm, "") // 去除标题标记
      .replace(/\*\*(.+?)\*\*/g, "$1") // 去除粗体
      .replace(/\*(.+?)\*/g, "$1") // 去除斜体
      .replace(/`(.+?)`/g, "$1") // 去除行内代码
      .replace(/\[(.+?)\]\(.+?\)/g, "$1") // 去除链接
      .trim();
    return cleaned.slice(0, this.options.summaryLength);
  }

  /** 提取关键词：词频分析（去停用词） */
  private extractKeywords(content: string): string[] {
    const tokens = tokenize(content);
    const freq = new Map<string, number>();
    for (const token of tokens) {
      if (STOP_WORDS.has(token)) continue;
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.options.maxKeywords)
      .map(([token]) => token);
  }

  /** 提取概念：大写词 / camelCase / 技术术语 */
  private extractConcepts(content: string): string[] {
    const concepts = new Set<string>();

    // 大写开头的词（含 PascalCase 如 "TypeScript"）
    const capitalized = content.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
    for (const c of capitalized) concepts.add(c);

    // camelCase 词
    const camelCase = content.match(/\b[a-z]+[A-Z][a-zA-Z]+\b/g) ?? [];
    for (const c of camelCase) concepts.add(c);

    // 全大写缩写（2-6 字符）
    const acronyms = content.match(/\b[A-Z]{2,6}\b/g) ?? [];
    for (const a of acronyms) concepts.add(a);

    // 技术术语（含连字符的复合词）
    const hyphenated = content.match(/\b[a-zA-Z]+-[a-zA-Z]+\b/g) ?? [];
    for (const h of hyphenated) concepts.add(h);

    return Array.from(concepts).slice(0, this.options.maxConcepts);
  }

  /** 提取数值事实：数值 + 上下文 */
  private extractNumericalFacts(content: string): NumericalFact[] {
    const facts: NumericalFact[] = [];
    const regex = /\d+(?:\.\d+)?/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const value = parseFloat(match[0]);
      if (value <= 0) continue; // 忽略 0

      const start = Math.max(0, match.index - 50);
      const end = Math.min(content.length, match.index + match[0].length + 50);
      const context = content.slice(start, end).replace(/\s+/g, " ").trim();

      facts.push({ value, context });
      if (facts.length >= this.options.maxNumericalFacts) break;
    }
    return facts;
  }

  /** 检测交叉引用：其他文档标题在本文档内容中出现 */
  private detectCrossReferences(content: string, selfTitle: string): string[] {
    const allTitles = Array.from(this.titleIndex.keys());
    return this.findTitleMatches(content, allTitles, selfTitle);
  }

  /** 在内容中查找匹配的标题 */
  private findTitleMatches(content: string, titles: string[], selfTitle: string): string[] {
    const matches: string[] = [];
    const lowerContent = content.toLowerCase();
    for (const title of titles) {
      if (title === selfTitle) continue;
      if (title.length < 3) continue; // 忽略过短标题
      if (lowerContent.includes(title.toLowerCase())) {
        matches.push(title);
      }
    }
    return matches;
  }

  /** 计算条目 ID（source + title 的简单哈希） */
  private computeId(source: string, title: string): string {
    return `${source}::${title}`;
  }

  // ─── 索引管理 ─────────────────────────────────────────────────────────

  private addToIndex(entry: WikiEntry): void {
    this.titleIndex.set(entry.title, entry.id);
    this.sourceIndex.set(entry.source, entry.id);
    for (const kw of entry.keywords) {
      if (!this.keywordIndex.has(kw)) this.keywordIndex.set(kw, new Set());
      this.keywordIndex.get(kw)!.add(entry.id);
    }
    for (const concept of entry.concepts) {
      if (!this.conceptIndex.has(concept)) this.conceptIndex.set(concept, new Set());
      this.conceptIndex.get(concept)!.add(entry.id);
    }
  }

  private removeFromIndex(entry: WikiEntry): void {
    this.entries.delete(entry.id);
    this.titleIndex.delete(entry.title);
    this.sourceIndex.delete(entry.source);
    for (const kw of entry.keywords) {
      this.keywordIndex.get(kw)?.delete(entry.id);
      if (this.keywordIndex.get(kw)?.size === 0) this.keywordIndex.delete(kw);
    }
    for (const concept of entry.concepts) {
      this.conceptIndex.get(concept)?.delete(entry.id);
      if (this.conceptIndex.get(concept)?.size === 0) this.conceptIndex.delete(concept);
    }
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────

let _instance: KnowledgeWiki | null = null;

/** 获取知识编译器单例 */
export function getKnowledgeWiki(): KnowledgeWiki {
  if (!_instance) _instance = new KnowledgeWiki();
  return _instance;
}

/** 测试用：重置单例 */
export function _resetKnowledgeWikiForTest(): void {
  _instance = null;
}

/** 测试用：设置自定义实例 */
export function _setKnowledgeWikiForTest(wiki: KnowledgeWiki | null): void {
  _instance = wiki;
}
