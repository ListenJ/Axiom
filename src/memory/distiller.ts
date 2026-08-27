/**
 * 记忆蒸馏器
 *
 * 从原始内容（会话日志、爬取结果、搜索记录）中自动提炼原子笔记，
 * 存入 Vault 的 03-Resources/atomic-notes/ 目录。
 *
 * 蒸馏原则：
 * - 一个想法 = 一个笔记（Zettelkasten）
 * - 每个笔记必须有独立的上下文和意义
 * - 通过 wiki-link 建立与其他笔记的关联
 * - YAML frontmatter 标注来源、置信度、验证状态
 */

import { VaultManager } from "./vault-manager.js";
import { generateTagsWithEdge } from "./edge-assist.js";
import { getEdgeClient, isEdgeEnabled } from "../local-llm/edge-client.js";
import { logger } from "../utils/logger.js";


/** Try to extract a hostname from a URL string, returning a fallback on failure */
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Strip protocol-less strings like "localhost" or "example.com/foo"
    const cleaned = url.replace(/^https?:\/\//, "").split("/")[0].split("?")[0];
    return cleaned || url;
  }
}

interface DistillOptions {
  source: string;           // 来源路径或 URL
  sourceType: "conversation" | "web-clip" | "search-result" | "code" | "manual";
  confidence?: number;      // 0.0 - 1.0
  tags?: string[];
  relatedNotes?: string[];  // wiki-link 目标
}

interface ExtractedIdea {
  title: string;
  content: string;
  reason: string;           // 为什么这个想法值得记录
}

export class MemoryDistiller {
  private vault: VaultManager;

  constructor(vaultPath?: string) {
    this.vault = new VaultManager({ vaultPath });
  }

  /**
   * 从会话日志中提取关键信息并创建原子笔记
   */
  async distillConversation(sessionPath: string): Promise<string[]> {
    const note = this.vault.readNote(sessionPath);
    if (!note) {
      logger.warn("Cannot distill: note not found", { path: sessionPath });
      return [];
    }

    const ideas = this.extractFromConversation(note.content);
    const created: string[] = [];

    for (const idea of ideas) {
      const path = await this.vault.writeAtomicNote(idea.title, idea.content, {
        context: `Distilled from [[${sessionPath}]]`,
        relatedNotes: [sessionPath],
        tags: ["distilled", "conversation"],
      });
      created.push(path);
      logger.info("Distilled atomic note", { title: idea.title, source: sessionPath });
    }

    return created;
  }

  /**
   * 从爬取结果中提取知识
   */
  async distillWebClip(clipPath: string): Promise<string[]> {
    const note = this.vault.readNote(clipPath);
    if (!note) return [];

    const ideas = this.extractFromWebContent(note.content, note.frontmatter.source as string);
    const created: string[] = [];

    for (const idea of ideas) {
      const path = await this.vault.writeAtomicNote(idea.title, idea.content, {
        context: `Distilled from web clip: ${note.frontmatter.source || clipPath}`,
        relatedNotes: [clipPath],
        tags: ["distilled", "web-clip", ...(Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags.filter((t): t is string => typeof t === "string") : [])],
      });
      created.push(path);
    }

    return created;
  }

  /**
   * 手动蒸馏：将任意内容提炼为原子笔记
   */
  async distillManual(title: string, rawContent: string, opts: DistillOptions): Promise<string> {
    // 简化处理：如果内容较短，直接作为原子笔记
    const coreIdea = await this.summarizeWithEdge(rawContent, 300);
    const edgeTags = await generateTagsWithEdge(rawContent);

    return this.vault.writeAtomicNote(title, coreIdea, {
      context: `Source: ${opts.source} (${opts.sourceType})`,
      tags: ["distilled", opts.sourceType, ...(opts.tags || []), ...(edgeTags || [])],
      relatedNotes: opts.relatedNotes,
    });
  }

  /** 边缘摘要（回退：规则截断） */
  private async summarizeWithEdge(text: string, maxLength: number): Promise<string> {
    if (text.length <= maxLength) return this.summarize(text, maxLength);
    if (!isEdgeEnabled("EDGE_MEMORY_ASSIST")) return this.summarize(text, maxLength);
    try {
      const resp = await getEdgeClient().generate(
        `用不超过100字概括以下内容的核心要点，只输出概括本身：【${text.slice(0, 1500)}】`,
        { maxTokens: 160 },
      );
      const summary = (resp.content ?? "").trim();
      if (summary.length >= 10) return summary;
    } catch (err) {
      logger.debug("[Distiller] edge summary failed, fallback to truncation", { error: (err as Error).message });
    }
    return this.summarize(text, maxLength);
  }

  // ===== 提取算法（确定性） =====

  private extractFromConversation(content: string): ExtractedIdea[] {
    const ideas: ExtractedIdea[] = [];

    // 1. 提取用户明确标记的重要信息（如 "记住："、"注意："）
    const importantRe = /^(?:记住|注意|重要|关键点|核心)\s*[：:]\s*(.+)$/gim;
    for (const m of content.matchAll(importantRe)) {
      ideas.push({
        title: this.generateTitle(m[1]),
        content: m[1].trim(),
        reason: "用户明确标记为重要",
      });
    }

    // 2. 提取配置变更（如 "端口改为"、"设置为"）
    const configRe = /(?:设置|配置|改为|调整为|更新为)\s*[:：]\s*(.+)$/gim;
    for (const m of content.matchAll(configRe)) {
      ideas.push({
        title: `配置: ${this.generateTitle(m[1])}`,
        content: m[1].trim(),
        reason: "配置变更记录",
      });
    }

    // 3. 提取待办事项中的已完成项（从日志中沉淀）
    const doneRe = /^- \[x\]\s+(.+)$/gm;
    for (const m of content.matchAll(doneRe)) {
      const text = m[1].trim();
      if (text.length > 10 && text.length < 200) {
        ideas.push({
          title: this.generateTitle(text),
          content: text,
          reason: "已完成的重要任务",
        });
      }
    }

    // 去重（基于内容相似度：简单字符串包含）
    const unique: ExtractedIdea[] = [];
    for (const idea of ideas) {
      const isDup = unique.some((u) =>
        u.content.includes(idea.content) || idea.content.includes(u.content)
      );
      if (!isDup) unique.push(idea);
    }

    return unique.slice(0, 5); // 每次最多提炼 5 条
  }

  private extractFromWebContent(content: string, sourceUrl?: string): ExtractedIdea[] {
    const ideas: ExtractedIdea[] = [];

    // 1. 提取标题（H1/H2）作为潜在原子笔记
    const headingRe = /^#{1,2}\s+(.+)$/gm;
    const headings: string[] = [];
    for (const m of content.matchAll(headingRe)) {
      headings.push(m[1].trim());
    }

    // 2. 提取代码块中的关键配置/算法
    const codeRe = /```\w*\n([\s\S]*?)```/g;
    let codeIndex = 0;
    for (const m of content.matchAll(codeRe)) {
      codeIndex++;
      const code = m[1].trim();
      if (code.length > 50 && code.length < 500) {
    ideas.push({
      title: `代码片段 #${codeIndex} (${sourceUrl ? safeHostname(sourceUrl) : "web"})`,
      content: `\`\`\`\n${code}\n\`\`\``,
      reason: "有价值的代码参考",
    });
      }
    }

    // 3. 提取列表项中的关键事实
    const listRe = /^[-*]\s+(.+)$/gm;
    let listCount = 0;
    for (const m of content.matchAll(listRe)) {
      listCount++;
      const text = m[1].trim();
      // 选择较长的、包含具体信息的列表项
      if (text.length > 30 && text.length < 200 && !text.startsWith("http")) {
        ideas.push({
          title: this.generateTitle(text),
          content: text,
          reason: "结构化信息点",
        });
      }
      if (listCount > 20) break; // 限制处理数量
    }

    // 去重
    const unique: ExtractedIdea[] = [];
    for (const idea of ideas) {
      const isDup = unique.some((u) =>
        this.similarity(u.content, idea.content) > 0.7
      );
      if (!isDup) unique.push(idea);
    }

    return unique.slice(0, 5);
  }

  // ===== 辅助方法 =====

  private generateTitle(text: string): string {
    // 取前 40 个字符作为标题
    const clean = text.replace(/[#*`\[\]]/g, "").trim();
    if (clean.length <= 40) return clean;
    return clean.slice(0, 37) + "...";
  }

  private summarize(text: string, maxLength: number): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= maxLength) return clean;
    return clean.slice(0, maxLength - 3) + "...";
  }

  /** 简单的字符串相似度（基于公共子串比例） */
  private similarity(a: string, b: string): number {
    const aWords = new Set(this.tokenize(a));
    const bWords = new Set(this.tokenize(b));
    const intersection = new Set([...aWords].filter((x) => bWords.has(x)));
    const union = new Set([...aWords, ...bWords]);
    return intersection.size / union.size;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
  }
}

export default MemoryDistiller;
