/**
 * S-A8 演进切片 1：级 4 符号相似度纯函数（方案 A+B，去 embedding 化）
 *
 * 计划口径（docs/superpowers/plans/2026-09-10-sa8-evolution-l4-symbolic-plan.md 第二节 D1）：
 * 级 4 上下文连贯的实体匹配从"字符频率向量 + 余弦"替换为确定性符号判定，本模块承载
 * 腿 1（归一化精确匹配的表面形式）与腿 3（字符 bigram Jaccard）；腿 2（KG 一跳邻域）
 * 在 validation-pipeline 级 4 实装（复用已注入的 getOutEdges/getNode，本模块不触碰）。
 *
 * 设计约束：纯函数、零依赖、零网络、确定性（规则 6 反馈回路可离线秒级复跑）；
 * 分词范式对齐 settings-search.charBigrams / deterministic-search CJK bigram，
 * 独立实现不跨模块 import 私有函数（切片计划 D1-3）。
 */

/** 参与切分的文字段：CJK 连续段 或 拉丁/数字连续段（normalize 后小写） */
const SEGMENT_RE = /[\u4e00-\u9fff]+|[a-z0-9]+/gu;

/**
 * 实体表面归一化（腿 1 判定基础）：
 * 全角→半角折叠（U+FF01-FF5E 平移 0xFEE0，U+3000 全角空格→半角）→ 小写 → trim
 * → 去除 [\s\-_./]（连接符/分隔符/空格差异不构成不同实体）。
 */
export function normalizeEntity(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/gu, " ")
    .toLowerCase()
    .trim()
    .replace(/[\s\-_./]/gu, "");
}

/**
 * 混合文字二元组集合（先归一化再切分）：
 * CJK 段切相邻二字组（"机器学习"→机器/器学/学习），拉丁/数字段切字符二元组
 * （"docker"→do/oc/ck/ke/er）；段间互不跨越，杜绝跨脚本伪 bigram
 * （self-evolve/engine.ts 2026-09-02 教训）。单字段段无二元组。
 */
export function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const normalized = normalizeEntity(s);
  for (const match of normalized.matchAll(SEGMENT_RE)) {
    const seg = match[0];
    for (let i = 0; i + 1 < seg.length; i++) {
      out.add(seg.slice(i, i + 2));
    }
  }
  return out;
}

/**
 * 字符 bigram Jaccard 相似度 = |A∩B| / |A∪B|。
 * 任一侧空集（空串/纯符号/单字符）→ 0，fail 向不匹配侧（与原向量实现零向量口径一致）。
 */
export function bigramJaccard(a: string, b: string): number {
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const g of setA) {
    if (setB.has(g)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
