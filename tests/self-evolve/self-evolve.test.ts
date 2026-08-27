/**
 * Self-evolve engine tests — 测试时自我进化（OpenRSI/RISE 思想的简约落地）。
 *
 * Contract:
 *   - selfThink: 输入 → 结构化思考（目标/假设/计划/风险/证据/置信度）；
 *                置信度恒为 estimateConfidence(evidence) 的确定性精算值；
 *                LLM 非 JSON / 失败时降级为输入兜底，不抛错。
 *   - retrieve:  注入检索器 + 知识库历史教训（store.list）按查询词命中排序。
 *   - selfImprove: 成功 → Improve 算子（修订计划 + 教训写回 store）；
 *                  失败 → Debug 算子（修订计划，不写教训）；历史教训注入提示（Crossover）。
 *   - selfInduce: 对历史轨迹做术语统计归纳，仅输出支持度>=2 且成功率>=0.6 的模式。
 */
import { describe, test, expect } from "bun:test";
import { SelfEvolveEngine } from "../../src/self-evolve/engine.js";
import type {
  EvidenceSource,
  SelfEvolveDeps,
  TaskTrace,
} from "../../src/self-evolve/types.js";

function jsonReply(obj: Record<string, unknown> = {}, role: "success" | "debug" = "success"): string {
  const withLesson =
    role === "success" ? { lesson: "Retry with exponential backoff after MCP timeout" } : {};
  return `Here is the result:\n\`\`\`json\n${JSON.stringify({ revisedPlan: ["step-1", "step-2"], ...withLesson, ...obj })}\n\`\`\``;
}

function makeDeps(overrides: Partial<SelfEvolveDeps> = {}): {
  deps: SelfEvolveDeps;
  thinkCalls: Array<{ role: string; content: string }[]>;
  written: string[];
} {
  const thinkCalls: Array<{ role: string; content: string }[]> = [];
  const written: string[] = [];
  const deps: SelfEvolveDeps = {
    think: async (messages) => {
      thinkCalls.push(messages);
      return jsonReply({});
    },
    store: {
      write: async (lesson) => {
        written.push(lesson);
      },
      list: async () => ["Lesson: verify MCP config before retry"],
    },
    ...overrides,
  };
  return { deps, thinkCalls, written };
}

const evidence: EvidenceSource[] = [
  { title: "MCP docs", url: "https://example.com/mcp", snippet: "timeout config", score: 0.9, provenance: "web" },
  { title: "Local lesson", url: "memory://self-evolve/1", snippet: "verify config", score: 0.8, provenance: "self-evolve-memory" },
];

describe("selfThink", () => {
  test("returns structured thought with parsed JSON, evidence and deterministic confidence", async () => {
    const { deps } = makeDeps({
      think: async () =>
        '`json' + JSON.stringify({ goal: 'Fix MCP timeout', assumptions: ['config is root cause'], plan: ['step-1', 'step-2'], risks: ['network flaky'] }) + '`',
      retrieve: async () => evidence,
      store: undefined,
    });
    const engine = new SelfEvolveEngine(deps);

    const thought = await engine.selfThink({ input: "Fix MCP timeout", project: "axiom" });

    expect(thought.goal).toBe("Fix MCP timeout");
    expect(thought.plan).toEqual(["step-1", "step-2"]);
    expect(thought.assumptions).toEqual(["config is root cause"]);
    expect(thought.risks).toEqual(["network flaky"]);
    expect(thought.evidence).toHaveLength(2);
    expect(thought.confidence).toBe(engine.estimateConfidence(evidence));
  });

  test("falls back to input-derived thought when LLM returns non-JSON", async () => {
    const { deps } = makeDeps({
      think: async () => "I will think about this carefully.",
      retrieve: async () => evidence,
      store: undefined,
    });
    const engine = new SelfEvolveEngine(deps);

    const thought = await engine.selfThink({ input: "tune prompt" });

    expect(thought.goal).toBe("tune prompt");
    expect(thought.plan).toEqual(["tune prompt"]);
    expect(thought.confidence).toBe(engine.estimateConfidence(evidence));
  });

  test("degrades gracefully when LLM call fails", async () => {
    const { deps } = makeDeps({ think: async () => { throw new Error("model unavailable"); } });
    const engine = new SelfEvolveEngine(deps);

    const thought = await engine.selfThink({ input: "flaky test" });

    expect(thought.goal).toBe("flaky test");
    expect(thought.plan).toEqual(["flaky test"]);
    expect(thought.confidence).toBe(0.4);
  });
});

describe("evidence retrieval", () => {
  test("combines injected retriever with self-evolve lessons ranked by query overlap", async () => {
    const { deps } = makeDeps({
      retrieve: async () => [{ title: "External", url: "https://x", snippet: "s", score: 0.7, provenance: "web" }],
    });
    const engine = new SelfEvolveEngine(deps);

    const thought = await engine.selfThink({ input: "MCP config" });

    const urls = thought.evidence.map((e) => e.url);
    expect(urls.some((u) => u.startsWith("memory://self-evolve/lesson/"))).toBe(true);
    expect(thought.evidence[0].score).toBeGreaterThanOrEqual(0.7);
  });

  test("keeps evidence sorted by score descending", async () => {
    const { deps } = makeDeps({
      retrieve: async () => [
        { title: "low", url: "https://low", snippet: "x", score: 0.3, provenance: "web" },
        { title: "high", url: "https://high", snippet: "y", score: 0.95, provenance: "web" },
      ],
    });
    const engine = new SelfEvolveEngine(deps);

    const thought = await engine.selfThink({ input: "anything" });

    expect(thought.evidence[0].score).toBe(0.95);
    expect(thought.evidence[thought.evidence.length - 1].score).toBe(0.3);
  });
});

describe("estimateConfidence", () => {
  test("returns 0.4 when no evidence", () => {
    const engine = new SelfEvolveEngine({ think: async () => "" });
    expect(engine.estimateConfidence([])).toBe(0.4);
  });

  test("monotonically increases with stronger evidence and caps at 0.95", () => {
    const engine = new SelfEvolveEngine({ think: async () => "" });
    const weak = [{ title: "a", url: "u", snippet: "s", score: 0.5, provenance: "web" }];
    const strong = [{ title: "a", url: "u", snippet: "s", score: 0.9, provenance: "web" }];
    expect(engine.estimateConfidence(strong)).toBeGreaterThan(engine.estimateConfidence(weak));
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `t${i}`, url: `u${i}`, snippet: "s", score: 0.95, provenance: "web",
    }));
    expect(engine.estimateConfidence(many)).toBe(0.95);
  });
});

describe("selfImprove", () => {
  test("success applies Improve operator and writes lesson to store", async () => {
    const { deps, written, thinkCalls } = makeDeps();
    const engine = new SelfEvolveEngine(deps);

    const result = await engine.selfImprove({
      task: "Fix MCP timeout",
      feedback: { action: "retry", outcome: "passed", success: true },
    });

    expect(result.success).toBe(true);
    expect(result.revisedPlan).toEqual(["step-1", "step-2"]);
    expect(result.lesson).toContain("exponential backoff");
    expect(written).toEqual([result.lesson]);
    // Crossover: prior lessons are injected into the improve prompt.
    expect(thinkCalls[0].some((m) => m.content.includes("verify MCP config before retry"))).toBe(true);
  });

  test("failure applies Debug operator, revises plan and does not write lesson", async () => {
    const { deps, written } = makeDeps();
    const engine = new SelfEvolveEngine(deps);

    const result = await engine.selfImprove({
      task: "Fix MCP timeout",
      feedback: { action: "retry", outcome: "still failing", success: false, error: "ECONNREFUSED" },
    });

    expect(result.success).toBe(false);
    expect(result.revisedPlan).toEqual(["step-1", "step-2"]);
    expect(result.lesson).toBe("");
    expect(written).toHaveLength(0);
  });
});

describe("selfInduce", () => {
  test("induces only patterns with support >= 2 and successRate >= 0.6", () => {
    const engine = new SelfEvolveEngine({ think: async () => "" });
    const traces: TaskTrace[] = [
      { id: "t1", task: "debug mcp timeout", success: true },
      { id: "t2", task: "debug mcp timeout", success: true },
      { id: "t3", task: "debug mcp timeout", success: false },
      { id: "t4", task: "tune redis cache", success: true },
    ];

    const inductions = engine.selfInduce(traces);

    const mcp = inductions.find((i) => i.pattern === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.support).toBe(3);
    expect(mcp!.successRate).toBeCloseTo(2 / 3);
    expect(inductions.some((i) => i.pattern === "redis")).toBe(false);
    expect(inductions.every((i) => i.successRate >= 0.6)).toBe(true);
  });
});





