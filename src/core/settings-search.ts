/**
 * Settings semantic/keyword search — 设置项语义检索
 *
 * 设计（边缘增强·失败回退）：
 *  1. 本地 embedding（edge-embeddings，见 src/local-llm/edge-embeddings.ts）
 *  2. 模型路由 embedding（role="embedding" 的 bge-m3）
 *  3. 纯关键词兜底（中文二元组 + 英文 token + 同义词表）
 * 任何一级失败都自动降级，绝不抛错；embedder 可注入以便测试。
 */
import { cosineSimilarity } from "../utils/math.js";
import { SETTINGS_CATALOG, getSectionLabel, type SettingItem } from "./settings-catalog.js";
import { getEdgeEmbeddings } from "../local-llm/edge-embeddings.js";
import { router as modelRouter } from "../router/model-router.js";

export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface SearchResult {
  key: string;
  label: string;
  desc: string;
  section: string;
  score: number;
  matchType: "semantic" | "keyword";
}

export interface SearchResponse {
  query: string;
  engine: "semantic" | "keyword" | "hybrid";
  results: SearchResult[];
}

const SEMANTIC_THRESHOLD = 0.15;
const KEYWORD_THRESHOLD = 0.25;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

/** 同义词表：用户口语 → 目录关键词/标签 */
const SYNONYMS: Record<string, string[]> = {
  通知: ["提醒", "消息", "弹窗"],
  提醒: ["通知", "消息"],
  隐私: ["安全", "本地", "私密"],
  安全: ["隐私", "权限", "确认"],
  缓存: ["清除", "清理", "临时"],
  权限: ["审批", "确认", "auto", "HITL"],
  动画: ["引导", "开场", "intro"],
  模型: ["提供商", "API", "模型配置"],
  端口: ["服务", "监听", "网关"],
  并发: ["限流", "压力", "爬取"],
  思考: ["推理", "reasoning", "轨迹"],
  工具: ["调用", "参数", "tool"],
};

/** 条目检索文本（label + desc + keywords） */
export function itemText(item: SettingItem): string {
  return [item.label, item.desc, ...item.keywords].join(" ");
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/** 中文二元组集合（对长度≥2 的中文片段切 bigram） */
function charBigrams(s: string): Set<string> {
  const out = new Set<string>();
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2));
  return out;
}

function latinTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/** 关键词打分：中文子串 + bigram 重叠 + 英文 token 重叠 + 同义词 */
export function keywordScore(item: SettingItem, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const text = normalize(itemText(item));
  let score = 0;

  // 精确子串（label 权重最高）
  if (normalize(item.label).includes(q)) score += 1.2;
  else if (text.includes(q)) score += 1.0;

  // 中文 bigram 重叠（近似语义）
  const qBigrams = charBigrams(q);
  if (qBigrams.size > 0) {
    const textBigrams = charBigrams(text);
    let hit = 0;
    for (const b of qBigrams) if (textBigrams.has(b)) hit++;
    score += (hit / qBigrams.size) * 0.7;
  }

  // 英文 token 重叠
  const qTokens = latinTokens(q);
  if (qTokens.size > 0) {
    const textTokens = latinTokens(text);
    let hit = 0;
    for (const t of qTokens) if (textTokens.has(t)) hit++;
    score += (hit / qTokens.size) * 0.6;
  }

  // 同义词命中（双字词查表；单字如"隐私"也查表）
  for (const token of qBigrams) {
    const syn = SYNONYMS[token];
    if (syn && syn.some((s) => text.includes(s))) score += 0.5;
  }
  if (q.length === 2 && SYNONYMS[q] && SYNONYMS[q].some((s) => text.includes(s))) score += 0.6;

  return score;
}

// L9：余弦实现收敛至 src/utils/math.ts

/** 默认 embedding 链：本地边缘 → 模型路由 → null（关键词兜底） */
export async function defaultEmbedder(texts: string[]): Promise<number[][] | null> {
  try {
    const edge = await getEdgeEmbeddings(texts);
    if (edge) return edge;
  } catch {
    // 边缘不可用 → 回落模型路由
  }
  try {
    return await modelRouter.embeddings(texts);
  } catch {
    return null;
  }
}

export interface SearchOptions {
  /** null = 仅关键词；函数 = 语义+关键词混合；缺省 = 默认链 */
  embedder?: Embedder | null;
  catalog?: SettingItem[];
  limit?: number;
}

/**
 * 设置项搜索主入口。
 * embedder 返回 null 或抛错 → 纯关键词（engine="keyword"）。
 * 语义命中 → 与关键词分数取最大（engine="semantic" 或 "hybrid"）。
 */
export async function searchSettings(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const q = (query ?? "").trim();
  if (!q) {
    return { query: q, engine: "keyword", results: [] };
  }
  const catalog = opts.catalog ?? SETTINGS_CATALOG;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const semanticScores = new Map<string, number>();
  let semanticUsed = false;

  const embedder = opts.embedder === undefined ? defaultEmbedder : opts.embedder;
  if (embedder) {
    try {
      const texts = [q, ...catalog.map(itemText)];
      const vectors = await embedder(texts);
      if (vectors && vectors.length === texts.length) {
        const qv = vectors[0];
        for (let i = 0; i < catalog.length; i++) {
          const s = cosineSimilarity(qv, vectors[i + 1]);
          if (s >= SEMANTIC_THRESHOLD) {
            semanticScores.set(catalog[i].key, s);
            semanticUsed = true;
          }
        }
      }
    } catch {
      // embedding 失败 → 关键词兜底
    }
  }

  const results: SearchResult[] = catalog
    .map((item) => {
      const sem = semanticScores.get(item.key) ?? 0;
      const kw = keywordScore(item, q);
      const score = Math.max(sem, kw);
      return {
        key: item.key,
        label: item.label,
        desc: item.desc,
        section: getSectionLabel(item.section),
        score,
        matchType: sem >= kw && sem > 0 ? ("semantic" as const) : ("keyword" as const),
      };
    })
    .filter((r) => r.score > 0 && r.score >= (r.matchType === "semantic" ? SEMANTIC_THRESHOLD : KEYWORD_THRESHOLD))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const hasSemantic = results.some((r) => r.matchType === "semantic");
  const hasKeyword = results.some((r) => r.matchType === "keyword");
  const engine: SearchResponse["engine"] =
    semanticUsed && hasKeyword ? "hybrid" : hasSemantic ? "semantic" : "keyword";

  return { query: q, engine, results };
}