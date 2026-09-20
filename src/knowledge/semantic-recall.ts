/**
 * 语义**候选召回** + 稳定排序（知识库语义层计划 · 切片 4/5）
 *
 * ## 本模块只做 D3 允许的那一半
 * 用户裁定（D3）：**向量只做候选召回**；最终排序必须带**稳定 tie-breaker（同分按 node_id 升序）**，
 * 且**不得依赖 `Map` 遍历顺序**。本模块正是这条约束的实现处。
 *
 * ## 为什么"只做候选召回"很重要
 * 若让向量分数直接决定排序，则同一内容在不同模型/不同批次下可能得到微差分数（浮点非结合），
 * 排序随之抖动 —— 而本项目的核心承诺是**同输入同输出**。故：
 *   - 词法分（FTS5/BM25）是**基础分**；
 *   - 向量分只用于**把语义相近但词面不重合的条目拉进候选集**；
 *   - 两者取 **max**（与 `settings-search` 既有语义层口径一致），再用 **id 升序**兜平**一切同分**。
 *
 * ## 确定性来源
 * - 排序键是 **(score desc, id asc)**，其中 id 比较用**码元序**（`<`/`>`），**不用 `localeCompare`**（避免 locale 依赖）；
 * - 输入按**数组下标**遍历并记录首次出现位置，**不依赖 Map/Set 的遍历顺序**；
 * - 全函数无时钟、无随机、无网络（embedder 与词法分均由调用方注入）。
 */

export interface RecallItem {
  id: string;
  content: string;
}

export interface SemanticCandidate {
  id: string;
  /** 向量相似度（0–1 量级由调用方保证） */
  score: number;
}

export interface RankedRecall {
  id: string;
  score: number;
  /** 该条命中的来源，便于解释与调试（固定顺序：lexical → semantic） */
  reasons: string[];
}

export interface RankOptions {
  items: readonly RecallItem[];
  /** 词法腿得分（调用方注入：FTS5/BM25/关键词）；缺省 0 */
  lexicalScore?: (item: RecallItem) => number;
  /** 向量候选（只用于召回，不单独决定排序）；缺省空 */
  semanticCandidates?: readonly SemanticCandidate[];
  limit?: number;
}

/**
 * 融合词法分与语义候选，产出**确定性**排序。
 *
 * 步骤：①对每个 item 取词法分；②把语义候选的 id 并入候选集（即使词法分为 0）；
 * ③总分 = max(词法分, 语义分)；④按 (score desc, id 码元升序) 排序；⑤截断。
 * 注意：③ 取 max 而非相加 —— 相加会让"词法强但语义弱"与"词法弱但语义强"不可比，且放大小分数抖动。
 */
export function rankWithSemanticRecall(opts: RankOptions): RankedRecall[] {
  const items = opts.items ?? [];
  const lexical = opts.lexicalScore ?? (() => 0);

  // 语义候选：按 id 建索引，但**排序不依赖**该 Map 的遍历顺序 —— 它只用于查分。
  const semById = new Map<string, number>();
  for (const c of opts.semanticCandidates ?? []) {
    const prev = semById.get(c.id);
    if (prev === undefined || c.score > prev) semById.set(c.id, c.score);
  }

  // 候选取并集：以 items 数组顺序为准（确定性），再补语义候选里"词法没召回"的 id。
  // 说明：语义候选若指向 items 之外的 id，会被忽略（候选必须存在于语料）。
  const byId = new Map<string, RecallItem>();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);

  const out: RankedRecall[] = [];
  for (const it of items) {
    const lex = lexical(it) || 0;
    const sem = semById.get(it.id) ?? 0;
    const score = Math.max(lex, sem);
    if (score <= 0) continue;
    const reasons: string[] = [];
    if (lex > 0) reasons.push("lexical");
    if (sem > 0) reasons.push("semantic");
    out.push({ id: it.id, score, reasons });
  }

  // 排序：score desc，其次 **id 码元升序**（不用 localeCompare）
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : out.length;
  return out.slice(0, limit);
}
