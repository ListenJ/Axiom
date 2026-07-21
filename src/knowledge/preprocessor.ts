/**
 * 知识预处理器 (Task 3.2)
 *
 * 将原始 markdown 清洗为模型可消费的标准化格式，并抽取 metadata、估算 token 数。
 *
 * 流程：
 *   1. 清洗：去除 HTML 残留、规范化空白、去除超长行
 *   2. 标准化：统一标题层级（顶层 # → ##）、统一代码块标记
 *   3. 特征提取：从 front-matter / 首个 # 标题 / 元数据行 抽出 title/author/date
 *   4. tokenCount：粗略估算（中英混合 ~4 字符/token）
 *
 * API: preprocessKnowledge(rawMarkdown: string): PreprocessedKnowledge
 *
 * 降级策略：清洗失败返回原始输入（不阻塞流程）。
 */
import { z } from "zod";

/** 抽取出的元数据 */
export interface ExtractedMetadata {
  title?: string;
  author?: string;
  date?: string;
}

/** 预处理结果 */
export interface PreprocessedKnowledge {
  cleanedMarkdown: string;
  extractedMetadata: ExtractedMetadata;
  tokenCount: number;
}

/** zod schema — 仅供下游验证 PreprocessedKnowledge 结构时使用 */
export const PreprocessedKnowledgeSchema = z.object({
  cleanedMarkdown: z.string(),
  extractedMetadata: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    date: z.string().optional(),
  }),
  tokenCount: z.number().int().nonnegative(),
});

// ============================================================================
// 清洗规则
// ============================================================================

/** HTML 残留标签（开/闭） */
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

/** HTML 实体（覆盖常见项） */
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#[0-9]+|#[xX][0-9a-fA-F]+);/g;

/** front-matter（YAML 风格 --- ... ---） */
const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** 顶层标题（首个 `# ` 开头的行） */
const TOP_HEADING_RE = /^#\s+(.+?)\s*$/m;

/** 元数据行：`**Author:** xxx` / `Author: xxx` / `作者：xxx`（兼容 markdown 加粗包裹） */
const AUTHOR_META_RE = /^(?:\*\*)?(?:author|作者|作者名)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?$/im;
const DATE_META_RE = /^(?:\*\*)?(?:date|发布日期|日期|published)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?$/im;

/** 超长行阈值（字符） */
const MAX_LINE_LENGTH = 2000;

/** 单行代码块标记统一为 ``` */
const TILDE_CODEBLOCK_RE = /^~~~([a-zA-Z0-9_-]*)\s*$/gm;

// ============================================================================
// 工具函数
// ============================================================================

function decodeHtmlEntities(text: string): string {
  const map: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&apos;": "'", "&nbsp;": " ",
  };
  return text.replace(HTML_ENTITY_RE, (e) => {
    if (map[e]) return map[e];
    // 数字 / 十六进制实体
    const numMatch = e.match(/^&#([0-9]+);$/);
    if (numMatch) return String.fromCodePoint(parseInt(numMatch[1], 10));
    const hexMatch = e.match(/^&#x([0-9a-fA-F]+);$/i);
    if (hexMatch) return String.fromCodePoint(parseInt(hexMatch[1], 16));
    return e;
  });
}

/** 提取 front-matter 字段（简易 key: value 解析） */
function parseFrontMatter(fm: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (m) result[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

/** 估算 token 数（粗略 4 字符/token，对中文偏保守） */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 预处理原始 markdown。
 * 失败时降级：返回原始输入 + 空 metadata + 估算 token 数。
 */
export function preprocessKnowledge(rawMarkdown: string): PreprocessedKnowledge {
  if (!rawMarkdown || typeof rawMarkdown !== "string") {
    return { cleanedMarkdown: "", extractedMetadata: {}, tokenCount: 0 };
  }

  try {
    let md = rawMarkdown;

    // 1. 抽取 front-matter（在清洗前）
    const metadata: ExtractedMetadata = {};
    const fmMatch = md.match(FRONT_MATTER_RE);
    if (fmMatch) {
      const fm = parseFrontMatter(fmMatch[1]);
      if (fm.title) metadata.title = fm.title;
      if (fm.author) metadata.author = fm.author;
      if (fm.date) metadata.date = fm.date;
      md = md.slice(fmMatch[0].length);
    }

    // 2. 清洗 HTML 残留
    md = md.replace(HTML_TAG_RE, "");
    md = decodeHtmlEntities(md);

    // 3. 标准化代码块（~~~ → ```）
    md = md.replace(TILDE_CODEBLOCK_RE, "```$1");

    // 4. 规范化空白：连续 3+ 空行折叠为 2 行
    md = md.replace(/\n{3,}/g, "\n\n");

    // 5. 去除超长行（可能是数据 URL / base64 / 日志残留）
    md = md
      .split("\n")
      .filter((line) => line.length <= MAX_LINE_LENGTH)
      .join("\n");

    // 6. 标准化标题层级：顶层 `#` (level 1) → `##` (level 2)，避免与文档元标题混淆
    //    仅当文档中存在多个 `# ` 开头行时执行
    const topHeadings = md.match(/^#\s+(.+?)\s*$/gm);
    if (topHeadings && topHeadings.length > 1) {
      md = md.replace(/^#\s+/gm, "## ");
    }

    // 7. 提取首个顶层标题作为 title（若 front-matter 未提供）
    if (!metadata.title) {
      const hMatch = md.match(TOP_HEADING_RE);
      if (hMatch) metadata.title = hMatch[1].trim();
    }

    // 8. 提取元数据行
    if (!metadata.author) {
      const aMatch = md.match(AUTHOR_META_RE);
      if (aMatch) metadata.author = aMatch[1].trim();
    }
    if (!metadata.date) {
      const dMatch = md.match(DATE_META_RE);
      if (dMatch) metadata.date = dMatch[1].trim();
    }

    // 9. 去除首尾空白
    md = md.trim();

    return {
      cleanedMarkdown: md,
      extractedMetadata: metadata,
      tokenCount: estimateTokens(md),
    };
  } catch {
    // 降级：返回原始输入
    return {
      cleanedMarkdown: rawMarkdown,
      extractedMetadata: {},
      tokenCount: estimateTokens(rawMarkdown),
    };
  }
}
