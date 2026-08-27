/**
 * ConformalHallucinationDetector 回归测试 — P1-9（调研清单顺延项）
 *
 * 安全关键模块（FDR/共形预测）此前无针对性测试。本文件经公共接口验证行为：
 * 1. 空陈述保守放行（pValue=1）
 * 2. 未校准（n=0）恒判非幻觉（computePValue 直接返回 1.0）
 * 3. 共形判定：校准集以事实为主、少量离群时，新离群陈述被标记为幻觉，
 *    而事实陈述保持非幻觉（pValue=(countGeq+1)/(n+1) < α）
 * 4. 增量 addFact 后证据可见
 * 5. 校准质量诊断：n/分布有序性；resetCalibration 归零
 * 6. alpha 越界构造拒绝
 */

import { describe, test, expect } from "bun:test";
import {
  ConformalHallucinationDetector,
  type CalibrationPair,
  type FactEntry,
} from "../../src/memory/hallucination-detector.js";

const FACTS: FactEntry[] = [
  { text: "water boils at one hundred degrees celsius", confidence: 0.95 },
  { text: "light travels fastest in vacuum", confidence: 0.9 },
];

/** 构造"以事实为主 + 单条离群"的校准集：使新离群陈述 pValue=(1+1)/(n+1)<α */
function buildCalibrationPairs(): CalibrationPair[] {
  const pairs: CalibrationPair[] = FACTS.map((f) => ({
    statement: f.text,
    isFact: true,
  }));
  // 复制事实陈述至 40 条（高重叠 → 低非一致性得分）
  for (let i = 0; i < 39; i++) {
    pairs.push({ statement: FACTS[i % FACTS.length].text, isFact: true });
  }
  // 单条离群（零重叠 → 非一致性得分 1）
  pairs.push({ statement: "zzz qqq xxx yyy", isFact: false });
  return pairs;
}

describe("ConformalHallucinationDetector 行为规格", () => {
  test("空陈述保守放行：非幻觉、pValue=1、无证据", () => {
    const d = new ConformalHallucinationDetector({ factBase: FACTS });
    const v = d.verify("");
    expect(v.isHallucination).toBe(false);
    expect(v.pValue).toBe(1);
    expect(v.evidence.length).toBe(0);
  });

  test("未校准（n=0）恒判非幻觉", () => {
    const d = new ConformalHallucinationDetector({ factBase: FACTS });
    const v = d.verify("zzz qqq xxx yyy");
    expect(v.isHallucination).toBe(false);
    expect(v.pValue).toBe(1);
  });

  test("共形判定：事实陈述非幻觉；新离群陈述被判幻觉", () => {
    const d = new ConformalHallucinationDetector({ factBase: FACTS });
    d.calibrate(buildCalibrationPairs());
    const factVerdict = d.verify("water boils at one hundred degrees celsius");
    expect(factVerdict.isHallucination).toBe(false);

    const outlier = d.verify("zzz qqq www vvv");
    expect(outlier.isHallucination).toBe(true);
    expect(outlier.pValue).toBeLessThan(0.05);
  });

  test("addFact 增量生效：新事实进入证据列表且按相似度参与匹配", () => {
    const d = new ConformalHallucinationDetector({ factBase: [] });
    d.addFact({ text: "quantum entanglement links particles", confidence: 0.9 });
    const v = d.verify("quantum entanglement links particles strongly");
    expect(v.evidence.length).toBeGreaterThan(0);
    expect(v.evidence[0].text).toContain("quantum");
  });

  test("getCalibrationQuality：n 与分布有序性；resetCalibration 归零", () => {
    const d = new ConformalHallucinationDetector({ factBase: FACTS });
    const pairs = buildCalibrationPairs();
    d.calibrate(pairs);
    const q = d.getCalibrationQuality();
    expect(q.n).toBe(pairs.length);
    expect(q.scoreDistribution.min).toBeLessThanOrEqual(q.scoreDistribution.median);
    expect(q.scoreDistribution.median).toBeLessThanOrEqual(q.scoreDistribution.max);

    d.resetCalibration();
    expect(d.getCalibrationQuality().n).toBe(0);
  });

  test("alpha 越界构造拒绝", () => {
    expect(() => new ConformalHallucinationDetector({ alpha: 0 })).toThrow();
    expect(() => new ConformalHallucinationDetector({ alpha: 1.5 })).toThrow();
    expect(() => new ConformalHallucinationDetector({ alpha: 0.05 })).not.toThrow();
  });
});
