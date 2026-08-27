/**
 * 自我进化归纳集成测试：
 *   A) Engine 层 — selfImprove 自动记录轨迹；selfInduce() 无参归纳历史轨迹；缓冲上限。
 *   B) ReflectionLoop 层 — 定时反射时调用 selfInduce，有模式时写入归纳笔记（vault）。
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { SelfEvolveEngine } from "../../src/self-evolve/engine.js";
import type { Induction, SelfEvolveDeps, TaskTrace } from "../../src/self-evolve/types.js";
import { router, type SmartAssignmentResponse } from "../../src/router/model-router.js";
import {
  setPromptEngineerForTest,
  setSkillRegistryForTest,
  setMemoryDistillerForTest,
  setMemoryArchiverForTest,
  setSqliteMemoryForTest,
} from "../../src/agents/consciousness/shims.js";
import { ReflectionLoop } from "../../src/agents/consciousness/reflection-loop.js";
import { getGlobalBlackboard } from "../../src/memory/blackboard.js";
import { getStateStore } from "../../src/agents/consciousness/state-store.js";
import { resetActivityTrackerForTest } from "../../src/agents/consciousness/activity-tracker.js";
import * as realVaultModule from "../../src/memory/vault-manager.js";

const VAULT_MODULE_PATH = "../../src/memory/vault-manager.js";

const JSON_REPLY =
  '```json\n{"revisedPlan":["verify","retry"],"lesson":"Retry with backoff"}\n```';

function makeDeps(overrides: Partial<SelfEvolveDeps> = {}): SelfEvolveDeps {
  return {
    think: async () => JSON_REPLY,
    store: {
      write: async () => {},
      list: async () => [],
    },
    ...overrides,
  };
}

function fakeRouterResponse(content: string): SmartAssignmentResponse {
  return {
    role: "general-chat",
    model: "fake-model",
    provider: "local",
    endpoint: "",
    content,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    latency_ms: 1,
    fallback_used: false,
  };
}

describe("Engine trace recording + no-arg induction", () => {
  test("selfImprove success records a trace with revised plan", async () => {
    const engine = new SelfEvolveEngine(makeDeps());
    await engine.selfImprove({
      task: "Fix MCP timeout",
      feedback: { action: "retry", outcome: "passed", success: true },
    });

    const traces = engine.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].task).toBe("Fix MCP timeout");
    expect(traces[0].success).toBe(true);
    expect(traces[0].plan).toEqual(["verify", "retry"]);
  });

  test("selfInduce() with no args induces from recorded traces", async () => {
    const engine = new SelfEvolveEngine(makeDeps());
    await engine.selfImprove({ task: "debug mcp timeout", feedback: { action: "a", outcome: "ok", success: true } });
    await engine.selfImprove({ task: "debug mcp timeout", feedback: { action: "a", outcome: "ok", success: true } });
    await engine.selfImprove({ task: "debug mcp timeout", feedback: { action: "a", outcome: "fail", success: false, error: "x" } });

    const inductions = engine.selfInduce();
    const mcp = inductions.find((i) => i.pattern === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.support).toBe(3);
    expect(mcp!.successRate).toBeCloseTo(2 / 3);
  });

  test("explicit traces parameter still wins over buffer", async () => {
    const engine = new SelfEvolveEngine(makeDeps());
    await engine.selfImprove({ task: "debug mcp timeout", feedback: { action: "a", outcome: "ok", success: true } });

    const explicit: TaskTrace[] = [
      { id: "x1", task: "tune redis cache", success: true },
      { id: "x2", task: "tune redis cache", success: true },
    ];
    const inductions = engine.selfInduce(explicit);
    expect(inductions.some((i) => i.pattern === "redis")).toBe(true);
    expect(inductions.some((i) => i.pattern === "mcp")).toBe(false);
  });

  test("trace buffer is capped at 500", () => {
    const engine = new SelfEvolveEngine(makeDeps());
    for (let i = 0; i < 505; i++) {
      engine.recordTrace({ id: "t" + i, task: "task", success: i % 2 === 0 });
    }
    expect(engine.listTraces()).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------
// ReflectionLoop integration
// ---------------------------------------------------------------------------

function installShims(): void {
  setPromptEngineerForTest({ generateSkillWithHermes: async () => null } as any);
  setSkillRegistryForTest({
    register: () => {}, list: () => [], match: () => null,
    execute: async () => ({ content: "", skillId: "fake", model: "m", provider: "p", latencyMs: 0 }),
    reload: () => {},
  } as any);
  setMemoryDistillerForTest({
    distillConversation: async () => [], distillWebClip: async () => [], distillManual: async () => "",
  } as any);
  setMemoryArchiverForTest({
    archive: async () => ({ archived: [], skipped: [], errors: [] }),
    archiveNote: async () => true, stats: () => ({ archivedCount: 0, byCategory: {} }),
  } as any);
  setSqliteMemoryForTest({
    upsertNote: () => 0, search: () => [], listByCategory: () => [], deleteNote: () => true, close: () => {},
  } as any);
}

function resetShims(): void {
  setPromptEngineerForTest(null);
  setSkillRegistryForTest(null);
  setMemoryDistillerForTest(null);
  setMemoryArchiverForTest(null);
  setSqliteMemoryForTest(null);
}

function resetAll(): void {
  resetShims();
  resetActivityTrackerForTest();
  getGlobalBlackboard().clear();
  getStateStore().clear();
}

async function withMockedVault<T>(fn: () => Promise<T> | T): Promise<T> {
  mock.module(VAULT_MODULE_PATH, () => ({
    getGlobalVault: () => fakeVault(),
  }));
  try {
    return await fn();
  } finally {
    mock.restore();
  }
}

const writeCalls: string[] = [];
function fakeVault(): { writeNote: (notePath: string) => Promise<string> } {
  return {
    writeNote: async (notePath: string) => {
      writeCalls.push(notePath);
      return notePath;
    },
  };
}

const REAL_VAULT_EXPORTS = {
  VaultManager: realVaultModule.VaultManager,
  getGlobalVault: realVaultModule.getGlobalVault,
  default: realVaultModule.default,
};

afterAll(() => {
  mock.restore();
  mock.module(VAULT_MODULE_PATH, () => REAL_VAULT_EXPORTS);
});

const REFLECT_REPLY =
  '心情: 平静\n下一目标: 继续\n总结: ok\n```json\n{"intent":"observe","goals":[],"beliefs":[]}\n```';

describe("ReflectionLoop self-induce integration", () => {
  beforeEach(() => {
    resetAll();
    installShims();
    writeCalls.length = 0;
  });

  afterEach(() => {
    resetShims();
    writeCalls.length = 0;
  });

  test("writes induction note when patterns are induced", async () => {
    let induceCalled = false;
    let promotedPatterns: string[] | null = null;
    const fakeSelfEvolve: { selfInduce: (traces?: TaskTrace[]) => Induction[] } = {
      selfInduce: () => {
        induceCalled = true;
        return [{ pattern: "mcp", support: 3, successRate: 0.67, recommendation: "Prefer mcp pattern" }];
      },
    };

    await withMockedVault(async () => {
      const executeSpy = spyOn(router, "executeWithRole").mockImplementation(async () =>
        fakeRouterResponse(REFLECT_REPLY),
      );
      try {
        const loop = new ReflectionLoop({
        selfEvolve: fakeSelfEvolve,
        promoteInductions: (ind) => {
          promotedPatterns = ind.map((i) => i.pattern);
          return ["auto-induce-mcp"];
        },
      });
        const outcome = await loop.runOnce({ kind: "manual", reason: "test" });

        expect(induceCalled).toBe(true);
        const inductionPath = writeCalls.find((p) => p.includes("inductions"));
        expect(inductionPath).toBeDefined();
        expect(outcome.curatorNotePaths.some((p) => p.includes("inductions"))).toBe(true);
        expect(promotedPatterns).toEqual(["mcp"]);
      } finally {
        executeSpy.mockRestore();
      }
    });
  });

  test("skips induction note when no patterns induced", async () => {
    await withMockedVault(async () => {
      const executeSpy = spyOn(router, "executeWithRole").mockImplementation(async () =>
        fakeRouterResponse(REFLECT_REPLY),
      );
      try {
        let promoteCalls = 0;
        const loop = new ReflectionLoop({
          selfEvolve: { selfInduce: () => [] },
          promoteInductions: () => {
            promoteCalls++;
            return [];
          },
        });
        const outcome = await loop.runOnce({ kind: "manual", reason: "test" });

        expect(writeCalls.some((p) => p.includes("inductions"))).toBe(false);
        expect(promoteCalls).toBe(0);
        expect(writeCalls.length).toBeGreaterThanOrEqual(1);
        expect(outcome.summary).toBeTruthy();
      } finally {
        executeSpy.mockRestore();
      }
    });
  });
});
