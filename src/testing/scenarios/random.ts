/**
 * 确定性 PRNG（mulberry32）— 用于可复现的随机测试场景。
 *
 * 相同的 seed 总是产生完全相同的序列，使随机模拟（串词/幻觉注入等）
 * 在测试中可复现、可校验。生产默认仍使用 Math.random（不传 seed）。
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
