/**
 * S5 校准数据积累测试 — 2026-08-29（docs/superpowers/specs/2026-08-29-p1-lift-design.md §S5）
 *
 * P0-C 校准债：双缝 verify 已运行但 verdict 未持久化，calibrate 零数据 → 防线判别力锁死。
 * 本文件经公共接口验证四组行为：
 * ① verdict 落库与读取：digest = sha256(statement.slice(0,2000))、fingerprint 与证据顺序无关、
 *    is_accepted 0/1、seam 标记；record 吞错不抛出
 * ② calibrateFromStored：极化对 < minPairs 时跳过（返回 null，detector 未校准）
 * ③ calibrateFromStored：≥ minPairs（造数）时 detector.calibrate 被调用且返回质量对象
 * ④ 建表幂等：ensure 可重复执行且不丢数据（与 migrate.ts 同一 DDL）
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ConformalHallucinationDetector } from "../src/memory/hallucination-detector.js";
import {
  ensureHallucinationVerdictsTable,
  recordHallucinationVerdict,
  readHallucinationVerdicts,
  computeStatementDigest,
  computeEvidenceFingerprint,
  calibrateFromStored,
  MIN_CALIBRATION_PAIRS,
  type HallucinationVerdictInput,
} from "../src/db/hallucination-verdicts.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function verdictInput(over: Partial<HallucinationVerdictInput> = {}): HallucinationVerdictInput {
  return {
    statement: "quicksort runs in o(n log n) average time",
    evidenceTexts: ["quicksort is a sorting algorithm", "arrays are zero indexed"],
    pValue: 1,
    verdict: "accepted",
    isAccepted: true,
    seam: "chat",
    ...over,
  };
}

describe("① verdict 落库与读取", () => {
  test("record → read 往返：digest / fingerprint / is_accepted / seam 持久化", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    recordHallucinationVerdict(db, verdictInput());
    recordHallucinationVerdict(db, verdictInput({
      statement: "the platypus lays transparent eggs on mars every leap year",
      pValue: 1,
      verdict: "anomalous",
      isAccepted: false,
      seam: "dre",
    }));

    const rows = readHallucinationVerdicts(db);
    expect(rows.length).toBe(2);

    const accepted = rows.find((r) => r.verdict === "accepted")!;
    expect(accepted.statement_digest).toBe(computeStatementDigest("quicksort runs in o(n log n) average time"));
    expect(accepted.statement_digest).toBe(sha256("quicksort runs in o(n log n) average time"));
    expect(accepted.is_accepted).toBe(1);
    expect(accepted.seam).toBe("chat");

    const anomalous = rows.find((r) => r.verdict === "anomalous")!;
    expect(anomalous.is_accepted).toBe(0);
    expect(anomalous.seam).toBe("dre");
  });

  test("evidence_fingerprint：排序后拼接 → 与证据输入顺序无关且稳定", () => {
    expect(computeEvidenceFingerprint(["b fact", "a fact", "c fact"]))
      .toBe(computeEvidenceFingerprint(["c fact", "a fact", "b fact"]));
    expect(computeEvidenceFingerprint(["a fact"])).toBe(sha256("a fact"));
  });

  test("statement_digest：超长 statement 截断到 2000 字符再哈希", () => {
    const long = "x".repeat(3000);
    expect(computeStatementDigest(long)).toBe(sha256("x".repeat(2000)));
  });

  test("record 吞错：落库失败不抛出（不阻塞响应）", () => {
    const db = new Database(":memory:");
    db.close();
    expect(() => recordHallucinationVerdict(db, verdictInput())).not.toThrow();
  });
});

describe("② calibrateFromStored：极化对不足 minPairs 时跳过", () => {
  test("6 对 < 50：返回 null，detector 保持未校准", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const detector = new ConformalHallucinationDetector({
      factBase: [{ text: "alpha supported statement", confidence: 1 }],
    });
    for (let i = 0; i < 3; i++) {
      recordHallucinationVerdict(db, verdictInput({
        statement: `alpha supported statement number ${i}`,
        evidenceTexts: ["shared evidence base"],
        isAccepted: true,
        verdict: "accepted",
      }));
      recordHallucinationVerdict(db, verdictInput({
        statement: `zeta unsupported statement number ${i}`,
        evidenceTexts: ["shared evidence base"],
        isAccepted: false,
        verdict: "anomalous",
      }));
    }
    expect(calibrateFromStored(db, detector)).toBeNull();
    expect(detector.isValid()).toBe(false);
  });

  test("同指纹组无极化（全 accepted）不构成对比对：等效不足，跳过", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const detector = new ConformalHallucinationDetector({
      factBase: [{ text: "alpha supported statement", confidence: 1 }],
    });
    for (let i = 0; i < 60; i++) {
      recordHallucinationVerdict(db, verdictInput({
        statement: `alpha supported statement number ${i}`,
        evidenceTexts: ["shared evidence base"],
        isAccepted: true,
        verdict: "accepted",
      }));
    }
    expect(calibrateFromStored(db, detector)).toBeNull();
    expect(detector.isValid()).toBe(false);
  });
});

describe("③ calibrateFromStored：≥ minPairs 时自动校准生效", () => {
  test("同证据基 30 accepted + 30 anomalous → 60 对，calibrate 被调用且返回质量对象", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const detector = new ConformalHallucinationDetector({
      factBase: [{ text: "alpha supported statement", confidence: 1 }],
    });
    for (let i = 0; i < 30; i++) {
      recordHallucinationVerdict(db, verdictInput({
        statement: `alpha supported statement number ${i}`,
        evidenceTexts: ["shared evidence base"],
        isAccepted: true,
        verdict: "accepted",
      }));
      recordHallucinationVerdict(db, verdictInput({
        statement: `zeta unsupported statement number ${i}`,
        evidenceTexts: ["shared evidence base"],
        isAccepted: false,
        verdict: "anomalous",
      }));
    }
    const quality = calibrateFromStored(db, detector);
    expect(quality).not.toBeNull();
    expect(quality!.n).toBe(60);
    expect(quality!.scoreDistribution.max).toBeGreaterThanOrEqual(quality!.scoreDistribution.min);
    expect(detector.isValid()).toBe(true);
  });

  test("minPairs 参数可覆盖默认值（MIN_CALIBRATION_PAIRS=50）", () => {
    expect(MIN_CALIBRATION_PAIRS).toBe(50);
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const detector = new ConformalHallucinationDetector({
      factBase: [{ text: "alpha supported statement", confidence: 1 }],
    });
    for (let i = 0; i < 4; i++) {
      recordHallucinationVerdict(db, verdictInput({
        statement: `alpha supported statement number ${i}`,
        evidenceTexts: ["fp"],
        isAccepted: true,
        verdict: "accepted",
      }));
      recordHallucinationVerdict(db, verdictInput({
        statement: `zeta unsupported statement number ${i}`,
        evidenceTexts: ["fp"],
        isAccepted: false,
        verdict: "anomalous",
      }));
    }
    // 8 对 ≥ minPairs=8 → 生效
    const quality = calibrateFromStored(db, detector, 8);
    expect(quality).not.toBeNull();
    expect(quality!.n).toBe(8);
  });
});

describe("④ 建表幂等（与 migrate.ts 同一 DDL）", () => {
  test("重复 ensure 不抛错且不丢数据", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    ensureHallucinationVerdictsTable(db);
    recordHallucinationVerdict(db, verdictInput());
    ensureHallucinationVerdictsTable(db);
    expect(readHallucinationVerdicts(db).length).toBe(1);
  });
});
