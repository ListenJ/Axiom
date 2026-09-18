/**
 * S4 HITL 真值标注管道测试 — 2026-08-30（docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S4）
 *
 * P1-S5 校准债最后一环：verdict 已持久化 + 保守自动校准已跑，但人工真值无入口。
 * 本文件经公共接口验证四组行为：
 * ① setLabel 落库/读取：label 0=幻觉/1=事实/null=未标注；has-label 过滤；吞错
 * ② hallucination_feedback MCP 工具：handler 合法入参落库返回 {success,id,label}，
 *    非法入参被 zod 拒绝（success:false，不落库）
 * ③ calibrateFromStored 优先真值：label 直接定 isFact（无需极化、可矛盾于 is_accepted），
 *    无 label 对仍走极化组保守策略（保留）
 * ④ label 列迁移幂等：旧库（无 label 列）ensure 后补列不丢数据，重复 ensure 幂等
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ConformalHallucinationDetector } from "../src/memory/hallucination-detector.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { registerSafetyTools } from "../src/mcp/server/safety-tools.js";
import {
  ensureHallucinationVerdictsTable,
  recordHallucinationVerdict,
  readHallucinationVerdicts,
  setLabel,
  calibrateFromStored,
  type HallucinationVerdictInput,
} from "../src/db/hallucination-verdicts.js";

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

/** 造一条 verdict 并返回其行 id */
function seed(db: Database, over: Partial<HallucinationVerdictInput> = {}): number {
  recordHallucinationVerdict(db, verdictInput(over));
  const rows = readHallucinationVerdicts(db);
  return rows[0]!.id;
}

describe("① setLabel 落库与读取", () => {
  test("setLabel(true) → label=1；setLabel(false) → label=0；行读取带 label 字段", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const idFact = seed(db, { statement: "water boils at one hundred degrees celsius" });
    const idHalluc = seed(db, {
      statement: "the platypus lays transparent eggs on mars every leap year",
      isAccepted: false,
      verdict: "anomalous",
    });

    expect(setLabel(db, idFact, true, "user confirmed by lookup")).toEqual({ id: idFact, label: 1 });
    expect(setLabel(db, idHalluc, false)).toEqual({ id: idHalluc, label: 0 });

    const rows = readHallucinationVerdicts(db);
    expect(rows.find((r) => r.id === idFact)!.label).toBe(1);
    expect(rows.find((r) => r.id === idHalluc)!.label).toBe(0);
  });

  test("未标注行 label 为 null；readHallucinationVerdicts 按 hasLabel 过滤", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const idLabeled = seed(db, { statement: "fact one for label filter" });
    seed(db, { statement: "fact two unlabeled" });
    seed(db, { statement: "fact three unlabeled" });
    setLabel(db, idLabeled, true);

    expect(readHallucinationVerdicts(db).find((r) => r.id !== idLabeled)!.label).toBeNull();

    const labeled = readHallucinationVerdicts(db, 1000, { hasLabel: true });
    expect(labeled.length).toBe(1);
    expect(labeled[0]!.id).toBe(idLabeled);

    const unlabeled = readHallucinationVerdicts(db, 1000, { hasLabel: false });
    expect(unlabeled.length).toBe(2);
    expect(unlabeled.every((r) => r.label === null)).toBe(true);

    expect(readHallucinationVerdicts(db).length).toBe(3);
  });

  test("吞错：不存在的 id 返回 null 不抛出；库不可用返回 null 不抛出", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    expect(setLabel(db, 424242, true)).toBeNull();

    const broken = new Database(":memory:");
    broken.close();
    expect(() => setLabel(broken, 1, true)).not.toThrow();
    expect(setLabel(broken, 1, true)).toBeNull();
  });
});

describe("② hallucination_feedback MCP 工具", () => {
  function makeRegistry(db: Database) {
    const registry = new ToolRegistry();
    registerSafetyTools(registry, db);
    return registry;
  }

  test("工具注册名为 hallucination_feedback，经 buildHttpHandlers 可取到 handler", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const registry = makeRegistry(db);
    expect(registry.getToolsMeta().some((t) => t.name === "hallucination_feedback")).toBe(true);
    expect(registry.buildHttpHandlers()["hallucination_feedback"]).toBeFunction();
  });

  test("合法入参：isFact=true 落库 label=1，返回 {success,id,label}", async () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const id = seed(db);
    const handler = makeRegistry(db).buildHttpHandlers()["hallucination_feedback"]!;

    const result = (await handler({ verdictId: id, isFact: true, note: "human verified" })) as Record<string, unknown>;
    expect(result).toEqual({ success: true, id, label: 1 });
    expect(readHallucinationVerdicts(db).find((r) => r.id === id)!.label).toBe(1);
  });

  test("合法入参：isFact=false 落库 label=0（无 note 亦可）", async () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const id = seed(db);
    const handler = makeRegistry(db).buildHttpHandlers()["hallucination_feedback"]!;

    const result = (await handler({ verdictId: id, isFact: false })) as Record<string, unknown>;
    expect(result).toEqual({ success: true, id, label: 0 });
  });

  test("非法入参被 zod 拒绝：缺 isFact / verdictId 非整数 / 类型错误，均 success:false 且不落库", async () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const id = seed(db);
    const handler = makeRegistry(db).buildHttpHandlers()["hallucination_feedback"]!;

    for (const bad of [
      { verdictId: id },
      { isFact: true },
      { verdictId: String(id), isFact: true },
      { verdictId: id, isFact: "yes" },
      { verdictId: 1.5, isFact: true },
      {},
    ]) {
      const result = (await handler(bad as Record<string, unknown>)) as Record<string, unknown>;
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
    // 非法入参不改变库内标签
    expect(readHallucinationVerdicts(db).find((r) => r.id === id)!.label).toBeNull();
  });

  test("不存在的 verdictId → success:false（吞错不抛出）", async () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const handler = makeRegistry(db).buildHttpHandlers()["hallucination_feedback"]!;
    const result = (await handler({ verdictId: 987654, isFact: true })) as Record<string, unknown>;
    expect(result.success).toBe(false);
  });
});

describe("③ calibrateFromStored 优先真值（label 对）", () => {
  test("label 对无需极化即入校准集：label 即真值，不足时无 label 极化对补足", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const detector = new ConformalHallucinationDetector({
      factBase: [{ text: "alpha supported statement", confidence: 1 }],
    });
    // 组 B（fpB）：全 is_accepted=1（非极化组，旧策略下整体被排除），
    // 但两条均带人工 label：1=事实（支撑陈述）、0=幻觉（无支撑陈述）
    for (let i = 0; i < 2; i++) {
      recordHallucinationVerdict(db, verdictInput({
        statement: `alpha supported statement number ${i}`,
        evidenceTexts: ["fpB"],
        isAccepted: true,
        verdict: "accepted",
      }));
      recordHallucinationVerdict(db, verdictInput({
        statement: `zeta unsupported statement number ${i}`,
        evidenceTexts: ["fpB"],
        isAccepted: true,
        verdict: "accepted",
      }));
    }
    const rowsB = readHallucinationVerdicts(db);
    setLabel(db, rowsB.find((r) => r.statement!.startsWith("alpha"))!.id, true);
    setLabel(db, rowsB.find((r) => r.statement!.startsWith("zeta"))!.id, false);

    // 组 A（fpA）：无 label 极化对 2 条（保守策略保留）
    recordHallucinationVerdict(db, verdictInput({
      statement: "alpha supported statement pair",
      evidenceTexts: ["fpA"],
      isAccepted: true,
      verdict: "accepted",
    }));
    recordHallucinationVerdict(db, verdictInput({
      statement: "zeta unsupported statement pair",
      evidenceTexts: ["fpA"],
      isAccepted: false,
      verdict: "anomalous",
    }));

    // 4 对 ≥ minPairs=4 → 生效。若 label 对被旧极化策略排除，仅剩 2 对 → null。
    const quality = calibrateFromStored(db, detector, 4);
    expect(quality).not.toBeNull();
    expect(quality!.n).toBe(4);
    expect(detector.isValid()).toBe(true);
  });

  test("label 直接定 isFact：与 is_accepted 矛盾时以人工 label 为准；无 label 对 isFact 仍取 is_accepted", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const captured: Array<{ statement: string; isFact: boolean }> = [];
    const stub = {
      calibrate(pairs: Array<{ statement: string; isFact: boolean }>) {
        captured.push(...pairs);
        return stub;
      },
      getCalibrationQuality() {
        return {
          n: captured.length,
          meanScore: 0,
          scoreDistribution: { min: 0, max: 0, median: 0, p25: 0, p75: 0 },
        };
      },
    } as unknown as ConformalHallucinationDetector;

    // 组 A：极化组（accepted + anomalous），其中 accepted 行被人工标为幻觉（矛盾标签）；
    // 另补一对无 label 极化行（保守策略保留）
    const idAccepted = seed(db, { statement: "alpha supported statement", evidenceTexts: ["fpA"], isAccepted: true });
    seed(db, { statement: "zeta unsupported statement", evidenceTexts: ["fpA"], isAccepted: false, verdict: "anomalous" });
    seed(db, { statement: "zeta supported second statement", evidenceTexts: ["fpA"], isAccepted: true });
    setLabel(db, idAccepted, false, "human: this is actually a hallucination");

    // 组 B：非极化 + label（label 对独立入集）
    const idLabeled = seed(db, { statement: "gamma labeled statement", evidenceTexts: ["fpB"], isAccepted: true });
    setLabel(db, idLabeled, true);

    const quality = calibrateFromStored(db, stub, 4);
    expect(quality).not.toBeNull();

    const byStatement = new Map(captured.map((p) => [p.statement, p.isFact]));
    // 矛盾标签：is_accepted=1 但人工 label=0 → isFact=false（label 赢）
    expect(byStatement.get("alpha supported statement")).toBe(false);
    // 无 label 行：isFact 取 is_accepted（极化组保留）
    expect(byStatement.get("zeta unsupported statement")).toBe(false);
    expect(byStatement.get("zeta supported second statement")).toBe(true);
    // label 对：isFact=true
    expect(byStatement.get("gamma labeled statement")).toBe(true);
    expect(captured.length).toBe(4);
  });

  test("无 label 且无极化对 → 仍跳过（null）", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    const detector = new ConformalHallucinationDetector({
      factBase: [{ text: "alpha supported statement", confidence: 1 }],
    });
    for (let i = 0; i < 3; i++) {
      recordHallucinationVerdict(db, verdictInput({
        statement: `alpha supported statement number ${i}`,
        evidenceTexts: ["fp"],
        isAccepted: true,
        verdict: "accepted",
      }));
    }
    expect(calibrateFromStored(db, detector)).toBeNull();
    expect(detector.isValid()).toBe(false);
  });
});

describe("④ label 列迁移幂等（migrate.ts 同语义）", () => {
  /** P1-S5 旧 DDL（无 label 列）——模拟存量库 */
  const LEGACY_DDL = `
    CREATE TABLE IF NOT EXISTS hallucination_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      statement_digest TEXT NOT NULL,
      statement TEXT,
      p_value REAL NOT NULL,
      verdict TEXT NOT NULL,
      is_accepted INTEGER NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      seam TEXT,
      created_at INTEGER NOT NULL
    )
  `;

  test("旧库（无 label 列）ensure 后补列：存量数据保留，且可标注", () => {
    const db = new Database(":memory:");
    db.run(LEGACY_DDL);
    db.run(
      `INSERT INTO hallucination_verdicts
         (statement_digest, statement, p_value, verdict, is_accepted, evidence_fingerprint, seam, created_at)
       VALUES ('d', 'legacy statement', 1, 'accepted', 1, 'fp', 'chat', 0)`,
    );

    expect(() => ensureHallucinationVerdictsTable(db)).not.toThrow();

    const rows = readHallucinationVerdicts(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.statement).toBe("legacy statement");
    expect(rows[0]!.label).toBeNull();

    // 存量行可直接标注
    expect(setLabel(db, rows[0]!.id, true)).toEqual({ id: rows[0]!.id, label: 1 });
  });

  test("重复 ensure 幂等：label 列不重复添加、不抛错", () => {
    const db = new Database(":memory:");
    ensureHallucinationVerdictsTable(db);
    ensureHallucinationVerdictsTable(db);
    ensureHallucinationVerdictsTable(db);
    const cols = (db.query("PRAGMA table_info(hallucination_verdicts)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols.filter((c) => c === "label").length).toBe(1);
  });
});
