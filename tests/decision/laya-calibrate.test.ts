/**
 * 阈值标定 harness 行为守卫（fetch mock，不打真服务）
 * 锁住：缺标注拒绝（防"裸跑"）、域标签校验、命中率/margin/门槛建议计算。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCalibration } from "../../src/decision/laya-calibrate.js";

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.LAYA_DECISION_URL;
});

function setup(cases: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "laya-cal-"));
  const file = join(dir, "cases.json");
  writeFileSync(file, JSON.stringify(cases));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mockLaya(perCase: (body: { items: Array<{ id: string; questions: Record<string, { criteria: string[] }> }> }) => unknown) {
  process.env.LAYA_DECISION_URL = "http://laya.test:18081";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Parameters<typeof perCase>[0];
    return new Response(JSON.stringify(perCase(body)), { status: 200 });
  }) as unknown as typeof fetch;
}

function batchResp(items: Array<{ id: string; question: string; choice: string; p1: number; p2: number; c2: string }>) {
  return {
    total: items.length,
    ok: items.length,
    failed: 0,
    results: items.map((it) => ({
      id: it.id,
      ok: true,
      answers: {
        [it.question]: {
          type: "choice",
          choice: it.choice,
          probabilities: { [it.choice]: it.p1, [it.c2]: it.p2 },
        },
      },
    })),
  };
}

describe("laya-calibrate —— 标定 harness", () => {
  test("缺 expected 拒绝执行（标定不做无标注裸跑）", async () => {
    const { file, cleanup } = setup([
      { id: "a", domain: "triage", state: "s", question: "q", criteria: ["x", "y"], expected: "" },
    ]);
    try {
      const code = await runCalibration(["--cases", file]);
      expect(code).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("域标签越界拒绝（不得跨域外推）", async () => {
    const { file, cleanup } = setup([
      { id: "a", domain: "engineering", state: "s", question: "q", criteria: ["x", "y"], expected: "x" },
    ]);
    try {
      const code = await runCalibration(["--cases", file]);
      expect(code).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("未配置 LAYA_DECISION_URL 拒绝（标定打真实服务）", async () => {
    const { file, cleanup } = setup([
      { id: "a", domain: "triage", state: "s", question: "q", criteria: ["x", "y"], expected: "x" },
    ]);
    try {
      const code = await runCalibration(["--cases", file]);
      expect(code).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("命中/margin/门槛建议计算正确；报告落盘", async () => {
    const { file, cleanup } = setup([
      { id: "c1", domain: "triage", state: "s1", question: "q", criteria: ["auto", "reject"], expected: "auto" },
      { id: "c2", domain: "triage", state: "s2", question: "q", criteria: ["auto", "reject"], expected: "auto" },
      { id: "c3", domain: "triage", state: "s3", question: "q", criteria: ["auto", "reject"], expected: "reject" },
    ]);
    mockLaya((body) =>
      batchResp(
        body.items.map((it, i) =>
          i === 2
            ? { id: it.id, question: "q", choice: "auto", p1: 0.6, p2: 0.4, c2: "reject" } // 错判（miss）
            : { id: it.id, question: "q", choice: "auto", p1: 0.9, p2: 0.1, c2: "reject" }, // 对，margin 0.8
        ),
      ),
    );
    try {
      const out = join(file.replace(/\.json$/, "") + ".report.json");
      const code = await runCalibration(["--cases", file, "--out", out]);
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as {
        domains: { triage: { cases: number; hitRate: number; marginMin: number; misses: unknown[] } };
        thresholdSuggestions: { triage: number | null };
      };
      expect(report.domains.triage.cases).toBe(3);
      expect(report.domains.triage.hitRate).toBeCloseTo(2 / 3);
      expect(report.domains.triage.marginMin).toBeCloseTo(0.8);
      expect(report.domains.triage.misses.length).toBe(1);
      // 命中率 <0.9 ⇒ 建议门槛 null（该域不可自动标定）
      expect(report.thresholdSuggestions.triage).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("choice 缺失而分布存在的用例计入 noDistribution（不扭曲命中率）", async () => {
    // 轮 7 审计 H2 回归：hitRate 分子只数「choice===expected 且有分布」，分母 = 总数 − noDistribution；
    // 若某用例有 probabilities 但 choice 缺失，它既非命中也非误判，必须与「完全缺分布」同口径剔除，
    // 否则分母偏大 → 命中率被拉低 → 门槛建议被压成 null（误报「不可标定」）。
    const { file, cleanup } = setup([
      { id: "c1", domain: "triage", state: "s1", question: "q", criteria: ["auto", "reject"], expected: "auto" },
      { id: "c2", domain: "triage", state: "s2", question: "q", criteria: ["auto", "reject"], expected: "auto" },
    ]);
    mockLaya((body) => ({
      total: body.items.length,
      ok: body.items.length,
      failed: 0,
      results: body.items.map((it) =>
        it.id === "c2"
          ? { id: it.id, ok: true, answers: { q: { type: "choice", probabilities: { auto: 0.7, reject: 0.3 } } } } // choice 缺失
          : { id: it.id, ok: true, answers: { q: { type: "choice", choice: "auto", probabilities: { auto: 0.9, reject: 0.1 } } } },
      ),
    }));
    try {
      const out = join(file.replace(/\.json$/, "") + ".report.json");
      const code = await runCalibration(["--cases", file, "--out", out]);
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as {
        domains: { triage: { hitRate: number; noDistribution: number; misses: unknown[] } };
        thresholdSuggestions: { triage: number | null };
      };
      expect(report.domains.triage.noDistribution).toBe(1);
      expect(report.domains.triage.hitRate).toBe(1); // 1/1，而非 1/2
      expect(report.domains.triage.misses.length).toBe(0);
      expect(report.thresholdSuggestions.triage).not.toBeNull(); // 不被无谓压成人工域
    } finally {
      cleanup();
    }
  });
});
