/**
 * Consciousness test suite.
 *
 * Test-seam contracts:
 *   - Each shim exposes a `set*ForTest()` guarded by NODE_ENV=production no-op
 *     and typed against a `Pick<>` subset of the real class. This file uses
 *     the subset types directly so no `as unknown as` casts are needed.
 *   - `mock.module("../src/memory/vault-manager.js", …)` is wrapped in
 *     `withMockedVault()` so a failure between mock + restore cannot leak.
 *   - `process.env.OBSIDIAN_VAULT_PATH` / `SQLITE_MEMORY_DB` are snapshotted
 *     in beforeEach and restored in afterEach (no process.env pollution).
 *   - The state store, blackboard, and activity tracker are reset between
 *     describes via `resetAll()`.
 *   - The concurrent-triggers test uses a Promise.race timeout so a leaked
 *     promise cannot hang the suite.
 */
import {
  describe,
  beforeEach,
  afterEach,
  test,
  expect,
  spyOn,
  mock,
} from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { router, type SmartAssignmentResponse } from "../src/router/model-router.js";
import { getGlobalBlackboard } from "../src/memory/blackboard.js";
import {
  setPromptEngineerForTest,
  type PromptEngineerSubset,
} from "../src/agents/consciousness/prompt-engineer-shim.js";
import {
  setSkillRegistryForTest,
  type SkillRegistrySubset,
} from "../src/agents/consciousness/skill-registry-shim.js";
import {
  setMemoryDistillerForTest,
  type MemoryDistillerSubset,
} from "../src/agents/consciousness/memory-distiller-shim.js";
import {
  setMemoryArchiverForTest,
  type MemoryArchiverSubset,
} from "../src/agents/consciousness/memory-archiver-shim.js";
import {
  setSqliteMemoryForTest,
  type SQLiteMemorySubset,
} from "../src/agents/consciousness/sqlite-memory-shim.js";
import { getStateStore } from "../src/agents/consciousness/state-store.js";
import {
  getActivityTracker,
  resetActivityTrackerForTest,
} from "../src/agents/consciousness/activity-tracker.js";
import {
  evaluate,
  buildManualTrigger,
  buildScheduleTrigger,
  isWithinQuietHours,
} from "../src/agents/consciousness/trigger.js";
import {
  SkillPromoter,
  DEFAULT_PROMOTER_CONFIG,
} from "../src/agents/consciousness/skill-promoter.js";
import {
  MemoryCurator,
  DEFAULT_CURATOR_CONFIG,
} from "../src/agents/consciousness/memory-curator.js";
import type { SkillDefinition } from "../src/skills/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VAULT_MODULE_PATH = "../src/memory/vault-manager.js";

function fakeVault(): {
  writeNote: (notePath: string, content: string) => Promise<string>;
  appendNote: (notePath: string, content: string) => Promise<void>;
} {
  return {
    writeNote: async (notePath: string) => notePath,
    appendNote: async () => {},
  };
}

function fakeRouterResponse(content: string): SmartAssignmentResponse {
  return {
    role: "general-chat",
    model: "fake-model",
    provider: "local",
    endpoint: "",
    content,
    usage: {
      prompt_tokens: Math.ceil(content.length / 4),
      completion_tokens: 0,
      total_tokens: Math.ceil(content.length / 4),
    },
    latency_ms: 1,
    fallback_used: false,
  };
}

/**
 * Install minimal fakes for the 5 lazy shims. All fakes are typed against
 * the `Pick<>` subset exports so no `as unknown as` casts are needed.
 */
function installShims(): void {
  const promptEngineer: PromptEngineerSubset = {
    generateSkillWithHermes: async () => null,
  };
  setPromptEngineerForTest(promptEngineer as any);

  const skillRegistry: SkillRegistrySubset = {
    register: () => {},
    list: () => [],
    match: () => null,
    execute: async () => ({
      content: "",
      skillId: "fake",
      model: "fake-model",
      provider: "local",
      latencyMs: 0,
    }),
    reload: () => {},
  };
  setSkillRegistryForTest(skillRegistry as any);

  const distiller: MemoryDistillerSubset = {
    distillConversation: async () => [],
    distillWebClip: async () => [],
    distillManual: async () => "",
  };
  setMemoryDistillerForTest(distiller as any);

  const archiver: MemoryArchiverSubset = {
    archive: async () => ({ archived: [], skipped: [], errors: [] }),
    stats: () => ({ archivedCount: 0, byCategory: {} }),
  };
  setMemoryArchiverForTest(archiver as any);

  const sqlite: SQLiteMemorySubset = {
    upsertNote: () => 0,
    search: () => [],
    close: () => {},
    listByCategory: () => [],
  };
  setSqliteMemoryForTest(sqlite as any);
}

/**
 * Reset all 5 shim instances to null so a previous describe cannot leak
 * its fake into the next.
 */
function resetShims(): void {
  setPromptEngineerForTest(null);
  setSkillRegistryForTest(null);
  setMemoryDistillerForTest(null);
  setMemoryArchiverForTest(null);
  setSqliteMemoryForTest(null);
}

/**
 * Reset all cross-test state: shim singletons, activity tracker counters,
 * blackboard entries, state-store contents.
 */
function resetAll(): void {
  resetShims();
  resetActivityTrackerForTest();
  getGlobalBlackboard().clear();
  getStateStore().clear();
}

/**
 * Run `fn` with `vault-manager.js` replaced by a stub. mock.restore() is
 * always invoked, even when `fn` throws. This is the only place the test
 * file touches `mock.module`.
 */
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

/** Snapshot process.env keys we touch and restore them in a finally block. */
function snapshotEnv(keys: string[]): { restore: () => void } {
  const before: Record<string, string | undefined> = {};
  for (const key of keys) before[key] = process.env[key];
  return {
    restore: () => {
      for (const key of keys) {
        const original = before[key];
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Triggers (pure functions — no shims or mocks required)
// ---------------------------------------------------------------------------

describe("consciousness triggers", () => {
  beforeEach(() => {
    // Triggers read state-store + activity-tracker, so reset them.
    resetActivityTrackerForTest();
    getStateStore().clear();
  });

  afterEach(() => {
    // Cleanup any state the test may have patched (Fix #4).
    getStateStore().clear();
    resetActivityTrackerForTest();
  });

  test("evaluate returns null when disabled", () => {
    const decision = evaluate({
      enabled: false,
      idleThresholdMs: 1000,
      tokenBudget: 100,
      scheduleCron: "0 * * * *",
    });
    expect(decision).toBeNull();
  });

  test("evaluate fires token-budget before idle", () => {
    getStateStore().patch({ tokensSpentThisSession: 9999 });
    const decision = evaluate({
      enabled: true,
      idleThresholdMs: 0,
      tokenBudget: 100,
      scheduleCron: "0 * * * *",
    });
    expect(decision).not.toBeNull();
    expect(decision?.fired.kind).toBe("token-budget");
  });

  test("evaluate fires idle when user has been inactive", () => {
    const now = Date.now();
    getActivityTracker().bumpUserActivity("hello", { intent: "chat", agentName: "general" });
    const decision = evaluate(
      {
        enabled: true,
        idleThresholdMs: 0,
        tokenBudget: 1_000_000,
        scheduleCron: "0 * * * *",
      },
      now + 1
    );
    expect(decision).not.toBeNull();
    expect(decision?.fired.kind).toBe("idle");
  });

  test("buildManualTrigger carries reason", () => {
    const t = buildManualTrigger("test reason");
    expect(t.kind).toBe("manual");
    expect((t as { reason?: string }).reason).toBe("test reason");
  });

  test("buildScheduleTrigger carries cron", () => {
    const t = buildScheduleTrigger("0 9 * * *");
    expect(t.kind).toBe("schedule");
    expect((t as { cron: string }).cron).toBe("0 9 * * *");
  });

  test("isWithinQuietHours handles same-day and wrap-around windows", () => {
    expect(isWithinQuietHours(2, 6, new Date("2026-01-01T04:00:00"))).toBe(true);
    expect(isWithinQuietHours(2, 6, new Date("2026-01-01T07:00:00"))).toBe(false);
    expect(isWithinQuietHours(23, 7, new Date("2026-01-01T02:00:00"))).toBe(true);
    expect(isWithinQuietHours(23, 7, new Date("2026-01-01T12:00:00"))).toBe(false);
    expect(isWithinQuietHours(9, 9, new Date("2026-01-01T09:00:00"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Activity tracker (singleton, isolate by resetActivityTrackerForTest)
// ---------------------------------------------------------------------------

describe("activity tracker", () => {
  beforeEach(() => {
    resetActivityTrackerForTest();
  });

  afterEach(() => {
    resetActivityTrackerForTest();
  });

  test("tracks user activity and produces a snapshot", () => {
    const tracker = getActivityTracker();
    tracker.bumpUserActivity("hello", { intent: "chat", agentName: "general" });
    tracker.bumpUserActivity("hi", { intent: "chat", agentName: "general" });
    tracker.bumpUserActivity("code", { intent: "coding", agentName: "coder" });

    const snap = tracker.snapshot();
    expect(snap).toHaveLength(2);
    const chat = snap.find((s) => s.key === "chat|general");
    expect(chat?.count).toBe(2);
    expect(chat?.sampleInputs).toContain("hello");

    expect(tracker.recent()).toHaveLength(3);
    expect(tracker.stats().uniquePatterns).toBe(2);
  });

  test("resetCounters clears patterns but keeps last activity time", () => {
    const tracker = getActivityTracker();
    tracker.bumpUserActivity("hello", { intent: "chat", agentName: "general" });
    const beforeStats = tracker.stats();
    tracker.resetCounters();
    const afterStats = tracker.stats();
    expect(afterStats.uniquePatterns).toBe(0);
    expect(afterStats.recentInputCount).toBe(0);
    expect(afterStats.lastUserActivityAt).toBe(beforeStats.lastUserActivityAt);
  });
});

// ---------------------------------------------------------------------------
// Consciousness singleton — uses vault mock + shim fakes
// ---------------------------------------------------------------------------

describe("consciousness singleton", () => {
  beforeEach(async () => {
    resetAll();
    installShims();
  });

  afterEach(async () => {
    // Final sweep: kill any leftover singleton and clear shims.
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
    });
    resetShims();
  });

  test("status reflects default options before start", async () => {
    let status: ReturnType<() => import("../src/agents/consciousness/index.js").ConsciousnessStatus> | null = null;
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      status = mod.getConsciousness().status();
    });
    expect(status!.running).toBe(false);
    expect(status!.enabled).toBe(true);
    expect(status!.pollActive).toBe(false);
    expect(status!.stateExists).toBe(false);
  });

  test("start bootstraps state and starts poll loop when enabled", async () => {
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      const c = mod.getConsciousness();
      await c.start({ enabled: true, pollIntervalMs: 60_000 });
      const status = c.status();
      expect(status.enabled).toBe(true);
      expect(status.pollActive).toBe(true);
      expect(status.stateExists).toBe(true);
      await c.stop();
    });
  });

  test("start is no-op when disabled", async () => {
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      const c = mod.getConsciousness();
      await c.start({ enabled: false });
      const status = c.status();
      expect(status.enabled).toBe(false);
      expect(status.pollActive).toBe(false);
      await c.stop();
    });
  });

  test("observe bumps activity tracker", async () => {
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      const c = mod.getConsciousness();
      c.observe("hello", { intent: "chat", agentName: "general" });
      expect(getActivityTracker().stats().uniquePatterns).toBe(1);
    });
  });

  test("observeVaultWrite bumps vault-write timestamp", async () => {
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      const c = mod.getConsciousness();
      c.observeVaultWrite();
      expect(getActivityTracker().stats().lastVaultWriteAt).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Reflection loop — uses vault mock + shim fakes + router spy
// ---------------------------------------------------------------------------

describe("reflection loop", () => {
  beforeEach(async () => {
    resetAll();
    installShims();
  });

  afterEach(async () => {
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
    });
    resetShims();
  });

  test("triggerNow returns a completed outcome with mocked LLM", async () => {
    const content = "心情：neutral\n下一目标：keep observing\n总结：test reflection";

    let summaryContainsTest = false;
    let tokensUsedGreaterThanZero = false;
    let triggerKindManual = false;
    let firstInsightContains = false;
    let callCount = 0;

    // spyOn must happen INSIDE withMockedVault so the router singleton bound
    // to the re-imported consciousness module is the same one we replace.
    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      const executeSpy = spyOn(router, "executeWithRole").mockResolvedValue(
        fakeRouterResponse(content)
      );
      try {
        const c = mod.getConsciousness();
        const outcome = await c.triggerNow("unit test");

        summaryContainsTest = outcome.summary.includes("test reflection");
        tokensUsedGreaterThanZero = outcome.tokensUsed > 0;
        triggerKindManual = outcome.trigger.kind === "manual";
        firstInsightContains = (getStateStore().read().recentInsights[0] ?? "").includes(
          "test reflection"
        );
        callCount = executeSpy.mock.calls.length;
      } finally {
        executeSpy.mockRestore();
      }
    });

    expect(callCount).toBe(1);
    expect(summaryContainsTest).toBe(true);
    expect(tokensUsedGreaterThanZero).toBe(true);
    expect(triggerKindManual).toBe(true);
    expect(firstInsightContains).toBe(true);
  });

  test("concurrent triggers are skipped while a cycle is in flight", async () => {
    // Race the second triggerNow against a 5s timeout so a leaked promise
    // cannot hang the suite (Fix #7).
    const CONCURRENT_TIMEOUT_MS = 5_000;

    let secondAbortedReason: string | undefined;
    let firstAbortedReason: string | undefined;

    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      let resolveFirst!: (value: SmartAssignmentResponse) => void;
      const firstPromise = new Promise<SmartAssignmentResponse>((resolve) => {
        resolveFirst = resolve;
      });
      const executeSpy = spyOn(router, "executeWithRole").mockReturnValue(firstPromise);
      try {
        const c = mod.getConsciousness();

        const first = c.triggerNow("first");
        const second = await Promise.race([
          c.triggerNow("second"),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`second triggerNow timed out after ${CONCURRENT_TIMEOUT_MS}ms`)),
              CONCURRENT_TIMEOUT_MS
            )
          ),
        ]);
        secondAbortedReason = second.abortedReason;

        resolveFirst(fakeRouterResponse("summary"));
        const firstOutcome = await first;
        firstAbortedReason = firstOutcome.abortedReason;
      } finally {
        executeSpy.mockRestore();
      }
    });

    expect(secondAbortedReason).toBe("cycle_already_in_flight");
    expect(firstAbortedReason).toBeUndefined();
  });

  test("triggerNow survives LLM failure and still updates state", async () => {
    let abortedReason: string | undefined;
    let summary: string | undefined;
    let lastReflectionAt: number | null = null;

    await withMockedVault(async () => {
      const mod = await import("../src/agents/consciousness/index.js");
      mod._resetConsciousnessForTest();
      const executeSpy = spyOn(router, "executeWithRole").mockRejectedValue(
        new Error("model unavailable")
      );
      try {
        const c = mod.getConsciousness();
        const outcome = await c.triggerNow("failure test");

        abortedReason = outcome.abortedReason;
        summary = outcome.summary;
        lastReflectionAt = getStateStore().read().lastReflectionAt;
      } finally {
        executeSpy.mockRestore();
      }
    });

    expect(abortedReason ?? "").toContain("llm_error");
    expect(summary).toBe("no summary");
    expect((lastReflectionAt ?? 0) > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Skill promoter — needs shim fakes + custom promptEngineer per test
// ---------------------------------------------------------------------------

describe("skill promoter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-promoter-"));
    resetAll();
    installShims();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetShims();
  });

  test("promotes a skill when pattern count exceeds threshold", async () => {
    const tracker = getActivityTracker();
    for (let i = 0; i < 5; i++) {
      tracker.bumpUserActivity("debug typescript", { intent: "coding", agentName: "coder" });
    }

    const fakeSkill: SkillDefinition = {
      id: "draft",
      name: "TypeScript Debugger",
      description: "Auto-generated",
      triggers: ["debug", "typescript"],
      promptTemplate: "Help debug TypeScript: {{input}}",
      requiredTools: [],
      outputFormat: "text",
      version: "1.0",
    };

    // Replace the default no-op PromptEngineer with one that returns a draft.
    const skillGen: PromptEngineerSubset = {
      generateSkillWithHermes: async () => fakeSkill,
    };
    setPromptEngineerForTest(skillGen as any);

    const promoter = new SkillPromoter({
      ...DEFAULT_PROMOTER_CONFIG,
      skillDirRel: path.join(tmpDir, "skills"),
    });
    const ids = await promoter.runOnce();

    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^auto-coding-coder-/);
  });
});

// ---------------------------------------------------------------------------
// Memory curator — sets process.env, mock vault, fake shims
// ---------------------------------------------------------------------------

describe("memory curator", () => {
  let tmpDir: string;
  let envSnapshot: { restore: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-curator-"));
    envSnapshot = snapshotEnv(["OBSIDIAN_VAULT_PATH", "SQLITE_MEMORY_DB"]);
    process.env.OBSIDIAN_VAULT_PATH = tmpDir;
    process.env.SQLITE_MEMORY_DB = path.join(tmpDir, "memory.db");
    resetAll();
    installShims();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    envSnapshot.restore();
    resetShims();
  });

  test("runOnce returns empty outcome when no stale memories exist", async () => {
    let archived: number | undefined;
    let distilledLength: number | undefined;
    let duplicateMerges: number | undefined;

    await withMockedVault(async () => {
      const curator = new MemoryCurator({
        ...DEFAULT_CURATOR_CONFIG,
        curatorNotePrefix: "00-Meta/consciousness/curator",
      });
      const outcome = await curator.runOnce();
      archived = outcome.archived;
      distilledLength = outcome.distilled.length;
      duplicateMerges = outcome.duplicateMerges;
    });

    expect(archived).toBe(0);
    expect(distilledLength).toBe(0);
    expect(duplicateMerges).toBe(0);
  });
});