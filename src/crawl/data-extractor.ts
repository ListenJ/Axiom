/**
 * 结构化数据抽取器 (Task 2.3)
 *
 * 从 markdown 内容抽取 (subject, predicate, object) 三元组。
 * 基于正则 + 启发式，无 LLM 依赖。
 *
 * 降级策略：抽取失败返回空数组，不阻塞流程。
 *
 * API: extractFacts(markdown: string, source: string): ExtractedFact[]
 */
import { z } from "zod";

/** 抽取出的结构化事实三元组 */
export const ExtractedFactSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

/** 句子分割正则 */
const SENTENCE_SPLIT_RE = /[^.!?。！？\n]+[.!?。！？]?/g;

/** 中文 "X 是 Y" 模式（中文不需空格分隔） */
const IS_PATTERN_CN = /^(.{2,40}?)(?:是|就是|是指|指的是)(.{2,200})$/;

/** 英文 "X is/are Y" 模式（英文需空格分隔） */
const IS_PATTERN_EN = /^(.+?)\s+(?:means|refers to|is|are|was|were)\s+(.+)$/i;

/** 中文 "X 定义为 Y" 模式 */
const DEFINE_PATTERN_CN = /^(.{2,40}?)(?:定义为|定义是)(.{2,200})$/;

/** 英文 "X is defined as Y" 模式 */
const DEFINE_PATTERN_EN = /^(.+?)\s+(?:is defined as|stands for)\s+(.+)$/i;

/** 中文 "X 位于 Y" 模式 */
const LOCATE_PATTERN_CN = /^(.{2,40}?)(?:位于|在)(.{2,200})$/;

/** 英文 "X is located in Y" 模式 */
const LOCATE_PATTERN_EN = /^(.+?)\s+(?:is located in|is in)\s+(.+)$/i;

/** 中文 "X 由 Y 创建/发明" 模式 */
const CREATE_PATTERN = /^(.{2,40}?)(?:由|被)(.{2,80}?)(?:创建|发明|提出|创立)/;

/** 列表项模式（- X: Y 或 * X - Y） */
const LIST_ITEM_PATTERN = /^[-*]\s*(.+?)\s*[:：-]\s*(.+)$/;

/** markdown 链接模式 [text](url) */
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;

/** 去除 markdown 格式标记，保留纯文本 */
function stripMarkdown(text: string): string {
  return text
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

/** 尝试从单个句子抽取三元组 */
function tryExtractFromSentence(sentence: string): Omit<ExtractedFact, "source"> | null {
  const cleaned = stripMarkdown(sentence).trim();
  if (cleaned.length < 5 || cleaned.length > 300) return null;

  // 按优先级尝试各类模式（中英文分离 pattern，避免中文 "是" 后要求空格导致漏匹配）
  const patterns: Array<{ re: RegExp; predicate: string; confidence: number }> = [
    { re: DEFINE_PATTERN_CN, predicate: "定义为", confidence: 0.85 },
    { re: DEFINE_PATTERN_EN, predicate: "定义为", confidence: 0.85 },
    { re: IS_PATTERN_CN, predicate: "是", confidence: 0.7 },
    { re: IS_PATTERN_EN, predicate: "是", confidence: 0.7 },
    { re: LOCATE_PATTERN_CN, predicate: "位于", confidence: 0.75 },
    { re: LOCATE_PATTERN_EN, predicate: "位于", confidence: 0.75 },
    { re: CREATE_PATTERN, predicate: "创建者", confidence: 0.8 },
  ];

  for (const { re, predicate, confidence } of patterns) {
    const match = cleaned.match(re);
    if (match && match[1] && match[2]) {
      const subject = match[1].trim();
      const object = match[2].trim();
      if (subject.length < 2 || object.length < 2) continue;
      if (subject.length > 100 || object.length > 200) continue;
      return { subject, predicate, object, confidence };
    }
  }

  // 列表项模式
  const listMatch = cleaned.match(LIST_ITEM_PATTERN);
  if (listMatch && listMatch[1] && listMatch[2]) {
    return {
      subject: listMatch[1].trim(),
      predicate: "描述",
      object: listMatch[2].trim(),
      confidence: 0.6,
    };
  }

  return null;
}

/**
 * 从 markdown 抽取事实三元组。
 * 失败时返回空数组（降级策略）。
 */
export function extractFacts(markdown: string, source: string): ExtractedFact[] {
  if (!markdown || typeof markdown !== "string") return [];
  if (!source || typeof source !== "string") return [];

  try {
    // 先对整个文档去除 markdown 标记（链接 [text](url) → text），
    // 避免 URL 中的 `.` 被句子分割器误判为句子边界。
    const cleaned = stripMarkdown(markdown);
    const sentences = cleaned.match(SENTENCE_SPLIT_RE) ?? [];
    const facts: ExtractedFact[] = [];
    const seen = new Set<string>(); // 去重键 (subject+predicate+object)

    for (const sentence of sentences) {
      const extracted = tryExtractFromSentence(sentence);
      if (!extracted) continue;

      const key = `${extracted.subject}|${extracted.predicate}|${extracted.object}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const fact: ExtractedFact = {
        ...extracted,
        source,
      };

      // zod 校验
      const parsed = ExtractedFactSchema.safeParse(fact);
      if (parsed.success) {
        facts.push(parsed.data);
      }

      // 单文档最多抽取 30 条，避免爆炸
      if (facts.length >= 30) break;
    }

    return facts;
  } catch {
    // 降级：返回空数组，不阻塞流程
    return [];
  }
}
