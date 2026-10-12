/**
 * 漂移套件守卫（label-free 自一致性探针）
 *
 * 依据：skill §5 实测——同一命题换措辞可在 0.30↔0.83 间翻面（措辞敏感性是
 * Laya 最大已知弱点）。漂移探针不需要人工标注：对**同一命题的多份措辞**，
 * 比 choice 是否一致 + margin 极差是否超稳定性带（ADR-008 台账 0.15）。
 *
 * 锁住：稳定判定、不稳定计数与明细、paraphrase<2 拒跑（单措辞测不出漂移）、
 * 缺 LAYA_DECISION_URL 拒跑、--strict 下不稳定即非零退出。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeDrift, runDrift } from "../../src/decision/laya-calibrate.js";
import { snapshotEnv } from "../helpers/env-snapshot.js";

const REAL_FETCH = globalThis.fetch;
// 轮 7 审计三梯队⑤：delete 不恢复会把运行环境已配置的 LAYA_DECISION_URL
// 泄漏为"已删除"状态给同进程后续测试（对齐 laya-http.test.ts 的 ENV_KEYS 范本）。
const restoreLayaEnv = snapshotEnv(["LAYA_DECISION_URL"]);
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  restoreLayaEnv();
});

describe("judgeDrift —— 纯判定（无 fetch）", () => {
  test("措辞一致且 margin 极差 ≤0.15 ⇒ stable", () => {
    const r = judgeDrift([
      { choice: "auto_fix", margin: 0.4 },
      { choice: "auto_fix", margin: 0.5 },
    ]);
    expect(r.verdict).toBe("stable");
    expect(r.spread).toBeCloseTo(0.1);
  });

  test("choice 翻面 ⇒ unstable（即便 margin 都很大）", () => {
    const r = judgeDrift([
      { choice: "auto_fix", margin: 0.9 },
      { choice: "manual_review", margin: 0.9 },
    ]);
    expect(r.verdict).toBe("unstable");
    expect(r.reason).toContain("choice");
  });

  test("margin 极差 >0.15 ⇒ unstable（choice 相同也算）", () => {
    const r = judgeDrift([
      { choice: "auto_fix", margin: 0.9 },
      { choice: "auto_fix", margin: 0.2 },
    ]);
    expect(r.verdict).toBe("unstable");
    expect(r.reason).toContain("margin");
  });

  test("边界：极差恰为 0.15 ⇒ stable（带内）", () => {
    const r = judgeDrift([
      { choice: "x", margin: 0.5 },
      { choice: "x", margin: 0.65 },
    ]);
    expect(r.verdict).toBe("stable");
  });

  test("单措辞 ⇒ 不可判（拒判，不假绿）", () => {
    const r = judgeDrift([{ choice: "x", margin: 0.5 }]);
    expect(r.verdict).toBe("insufficient");
  });
});

function setup(suite: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "laya-drift-"));
  const file = join(dir, "suite.json");
  writeFileSync(file, JSON.stringify(suite));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mockByState(choiceFor: (state: string) => { choice: string; p1: number; p2: number }) {
  process.env.LAYA_DECISION_URL = "http://laya.test:18081";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { items: Array<{ id: string; state: string; questions: Record<string, unknown> }> };
    return new Response(
      JSON.stringify({
        total: body.items.length,
        ok: body.items.length,
        failed: 0,
        results: body.items.map((it) => {
          const q = Object.keys(it.questions)[0];
          const c = choiceFor(it.state);
          const otherChoice = c.choice === "reject" ? "auto_fix" : "reject";
          return {
            id: it.id,
            ok: true,
            answers: { [q]: { type: "choice", choice: c.choice, probabilities: { [c.choice]: c.p1, [otherChoice]: c.p2 } } },
          };
        }),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe("runDrift —— 套件级行为", () => {
  test("单措辞命题拒跑（exit 2，防假绿）", async () => {
    const { file, cleanup } = setup([
      { id: "p1", question: "action", criteria: ["a", "b"], paraphrases: ["只有一份措辞"] },
    ]);
    try {
      expect(await runDrift(["--drift", file])).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("多命题聚合：稳定/不稳定计数与明细落盘", async () => {
    const { file, cleanup } = setup([
      { id: "stable-p", question: "action", criteria: ["auto_fix", "reject"], paraphrases: ["稳定甲", "稳定乙"] },
      { id: "unstable-p", question: "action", criteria: ["auto_fix", "reject"], paraphrases: ["翻面甲", "翻面乙"] },
    ]);
    // 只有 unstable-p 的第二份措辞翻面；其余一致
    mockByState((state) => (state === "翻面乙" ? { choice: "reject", p1: 0.85, p2: 0.1 } : { choice: "auto_fix", p1: 0.9, p2: 0.1 }));
    try {
      const out = join(file.replace(/\.json$/, "") + ".drift.json");
      const code = await runDrift(["--drift", file, "--out", out]);
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as {
        total: number;
        unstable: number;
        propositions: Array<{ id: string; verdict: string }>;
      };
      expect(report.total).toBe(2);
      expect(report.unstable).toBe(1);
      expect(report.propositions.map((p) => p.id)).toEqual(["stable-p", "unstable-p"]);
      expect(report.propositions[0].verdict).toBe("stable");
      expect(report.propositions[1].verdict).toBe("unstable");
    } finally {
      cleanup();
    }
  });

  test("缺 LAYA_DECISION_URL 拒跑（exit 2）", async () => {
    const { file, cleanup } = setup([
      { id: "p1", question: "action", criteria: ["a", "b"], paraphrases: ["甲", "乙"] },
    ]);
    try {
      expect(await runDrift(["--drift", file])).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("--strict：存在不稳定命题 ⇒ 非零退出（默认仅报告）", async () => {
    const { file, cleanup } = setup([
      { id: "p1", question: "action", criteria: ["auto_fix", "reject"], paraphrases: ["A", "B"] },
    ]);
    mockByState((state) => (state === "B" ? { choice: "reject", p1: 0.9, p2: 0.05 } : { choice: "auto_fix", p1: 0.9, p2: 0.05 }));
    try {
      expect(await runDrift(["--drift", file])).toBe(0);
      expect(await runDrift(["--drift", file, "--strict"])).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("runDrift —— 缺失响应边界", () => {
  test("missing choice/probabilities => insufficient，不得假 stable；strict 返回 1", async () => {
    const { file, cleanup } = setup([
      { id: "all-missing", question: "action", criteria: ["auto_fix", "reject"], paraphrases: ["A", "B"] },
      { id: "partial", question: "action", criteria: ["auto_fix", "reject"], paraphrases: ["C", "D"] },
    ]);
    process.env.LAYA_DECISION_URL = "http://laya.test:18081";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        total: 4,
        ok: 4,
        failed: 0,
        results: [
          { id: "all-missing#0", ok: true },
          { id: "all-missing#1", ok: true },
          {
            id: "partial#0",
            ok: true,
            answers: { action: { type: "choice", choice: "auto_fix", probabilities: { auto_fix: 0.9, reject: 0.1 } } },
          },
          { id: "partial#1", ok: true },
        ],
      }), { status: 200 })) as unknown as typeof fetch;
    try {
      const out = join(file.replace(/\.json$/, "") + ".missing.drift.json");
      expect(await runDrift(["--drift", file, "--out", out])).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as {
        insufficient: number;
        propositions: Array<{ id: string; verdict: string }>;
      };
      expect(report.insufficient).toBe(2);
      expect(report.propositions.map((p) => p.verdict)).toEqual(["insufficient", "insufficient"]);
      expect(await runDrift(["--drift", file, "--out", out, "--strict"])).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("runDrift —— 单键分布边界", () => {

  test("single-entry distributions are insufficient, not fabricated stable", async () => {
    const { file, cleanup } = setup([
      { id: "degenerate", question: "action", criteria: ["auto_fix", "reject"], paraphrases: ["A", "B"] },
    ]);
    process.env.LAYA_DECISION_URL = "http://laya.test:18081";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        total: 2,
        ok: 2,
        failed: 0,
        results: [
          { id: "degenerate#0", ok: true, answers: { action: { type: "choice", choice: "auto_fix", probabilities: { auto_fix: 1 } } } },
          { id: "degenerate#1", ok: true, answers: { action: { type: "choice", choice: "auto_fix", probabilities: { auto_fix: 1 } } } },
        ],
      }), { status: 200 })) as unknown as typeof fetch;
    try {
      const out = join(file.replace(/\.json$/, "") + ".degenerate.drift.json");
      expect(await runDrift(["--drift", file, "--out", out])).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as {
        insufficient: number;
        propositions: Array<{ verdict: string; missing: boolean[]; margins: Array<number | null> }>;
      };
      expect(report.insufficient).toBe(1);
      expect(report.propositions[0].verdict).toBe("insufficient");
      expect(report.propositions[0].missing).toEqual([true, true]);
      expect(report.propositions[0].margins).toEqual([null, null]);
      expect(await runDrift(["--drift", file, "--out", out, "--strict"])).toBe(1);
    } finally {
      cleanup();
    }
  });
});
