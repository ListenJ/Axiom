/**
 * 共享数值工具（L9 审计修复：收敛三处重复的手写余弦实现）
 *
 * 语义：零向量 / 长度不匹配 → 0（与 settings-search 版一致，消除
 * context-manager 旧版在零向量时返回 NaN 的隐患）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
