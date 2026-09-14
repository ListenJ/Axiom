/**
 * 确定性关键词检索的文本处理与打分
 *
 * 背景（T3 步骤 1.2）：知识后端要收敛到 DRE SQLite 一处，但 DRE 现有的
 * `atomStore.search()` / `knowledgeNetwork.search()` 都是**朴素子串匹配**
 * （整串 `toLowerCase().includes()` + 凑够 limit 即 break），三个缺陷：
 *   1. 无分词：查询 `"确定性 检索"`（带空格）匹配不到内容 `"确定性检索"`，
 *      多词查询几乎必然 0 结果；中文无 CJK 分词尤甚
 *   2. 无打分排序：结果按 Map 插入顺序截断，相关项可能排在无关项之后
 *   3. 提前 break：凑够 limit 即停，可能整体漏掉更相关的项
 *
 * 本模块提供该问题的**最小可行**修复：分词 + 打分。排序与截断由调用方负责。
 *
 * 硬约束（与"确定性检索 / 零向量"两个卖点绑定）
 *   - **确定性**：同一输入必须给出同一输出（同分数、同顺序）。不引入随机、不依赖时间。
 *   - **零向量**：纯词法匹配，不引入 embedding / 向量库。
 *   - **深模块**（规则 8）：对外只有两个函数，复杂度藏在内部。
 *
 * 打分公式（可解释、可复现）：
 *     fieldScore = (命中词数 × 0.6 + 覆盖率 × 0.4) × 字段权重
 *     字段权重 = 1 / (1 + 字段下标)     // 越靠前的字段越重要
 *     整串短语命中额外 +0.5
 *   命中词数项保证"匹配到更多查询词"的文档排更前；覆盖率项避免长文档因字段长而虚高。
 */

/** CJK 统一表意文字区段（含扩展 A） */
const CJK = "\\u4e00-\\u9fff\\u3400-\\u4dbf";
const SEG_RE = new RegExp(`[${CJK}]+|[A-Za-z0-9]+`, "g");
const CJK_ONLY_RE = new RegExp(`^[${CJK}]+$`);

/**
 * 分词。
 *
 * - 拉丁/数字段：按非字母数字切分并小写化
 * - CJK 段：生成**二元组**（中文无空格可分，单字切分召回过低）
 *   单个汉字退化为其自身，避免完全丢失
 *
 * 输出顺序 = 输入中出现顺序，保证确定性。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const matches = text.match(SEG_RE);
  if (!matches) return [];

  const out: string[] = [];
  for (const seg of matches) {
    if (CJK_ONLY_RE.test(seg)) {
      if (seg.length === 1) {
        out.push(seg);
      } else {
        for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
      }
    } else {
      out.push(seg.toLowerCase());
    }
  }
  return out;
}

/** 每个字段的权重：越靠前越高 */
function fieldWeight(index: number): number {
  return 1 / (1 + index);
}

/** 短语命中加分 */
const PHRASE_BONUS = 0.5;
/** 命中词数项系数 */
const HIT_WEIGHT = 0.6;
/** 覆盖率项系数 */
const COVERAGE_WEIGHT = 0.4;

/**
 * 计算查询与文档的匹配分。
 *
 * @param query  查询串
 * @param fields 文档字段，**按重要性从高到低排列**（如 [name, content]）
 * @returns ≥ 0 的分数；0 表示不匹配。空查询或空字段返回 0（不抛错）。
 */
export function scoreMatch(query: string, fields: string[]): number {
  if (!query || fields.length === 0) return 0;

  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const qSet = new Set(qTokens);

  let score = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const dTokens = tokenize(field);
    if (dTokens.length === 0) continue;

    const dSet = new Set(dTokens);
    let hits = 0;
    for (const t of qSet) if (dSet.has(t)) hits++;
    if (hits === 0) continue;

    const coverage = hits / qSet.size;
    score += (hits * HIT_WEIGHT + coverage * COVERAGE_WEIGHT) * fieldWeight(i);
  }

  if (score === 0) return 0;

  // 整串短语命中：与"分词命中"叠加，用于区分"确实连续出现"与"词都出现过但散落"
  const q = query.trim().toLowerCase();
  if (q.length > 0 && fields.some((f) => f && f.toLowerCase().includes(q))) {
    score += PHRASE_BONUS;
  }

  return score;
}
