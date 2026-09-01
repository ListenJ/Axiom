import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { maybeAutoEvolve, type AutoEvolveDeps } from "../../src/agent-evals/auto-evolve.js";

/**
 * auto-evolve 触发器 — 全部注入 fake，不碰真实 registry/磁盘/JSONL。
 * 真实路径仅两块：state 文件读写（经 statePath 指向 .tmp）、env 读取（经 enabled/cooldown/minNew 闭包隔离）。
 */

interface LocalState { lastRunAt: number; lastNewTraces: number }
const fixedResult = { traceCount: 50, inductionCount: 2, created: ["auto-induce-x"], sampled: 50 };

function makeDeps(overrides: Partial<AutoEvolveDeps> = {}): AutoEvolveDeps {
  return {
    now: () => 1_000_000,
    enabled: () => true,
    minNewTraces: () => 1,
    cooldownMs: () => 0,
    statePath: () => path.join(process.cwd(), ".tmp", "test-auto-evolve-state.json"),
    getNewTraces: async () => 50,
    evolve: async () => fixedResult,
    ...overrides,
  };
}

/** 让一个依赖在调用前替换为 spy（bun:test spyOn 返回可断言的 mock）。 */
function spyDeps<K extends keyof AutoEvolveDeps>(deps: AutoEvolveDeps, key: K): { mock: any } {
  const original = deps[key];
  let calls = 0;
  let lastArgs: unknown[] = [];
  deps[key] = ((...args: unknown[]) => {
    calls++;
    lastArgs = args;
    return (original as any)(...args);
  }) as AutoEvolveDeps[K];
  return {
    get mock() { return { calls: () => calls, lastArgs: () => lastArgs }; },
  };
}

describe("auto-evolve 自动触发器", () => {
  const statePath = path.join(process.cwd(), ".tmp", "test-auto-evolve-state.json");

  beforeEach(() => {
    try { fs.unlinkSync(statePath); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync(statePath); } catch {}
  });

  function readState(): LocalState | null {
    try { return JSON.parse(fs.readFileSync(statePath, "utf-8")); } catch { return null; }
  }

  function presetState(s: LocalState): void {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(s), "utf-8");
  }

  test("disabled：enabled()=false → reason disabled，不读 state 不 evolve", async () => {
    const deps = makeDeps({
      enabled: () => false,
      getNewTraces: async () => 50,
    });
    const evolveTracker = spyDeps(deps, "evolve");
    const gntTracker = spyDeps(deps, "getNewTraces");
    const result = await maybeAutoEvolve(deps);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(evolveTracker.mock.calls()).toBe(0);
    expect(gntTracker.mock.calls()).toBe(0);
    expect(readState()).toBeNull();
  });

  test("ok：pending 达标 → ran true / result 透传 / state 写入 lastNewTraces；二次同值 → insufficient-new", async () => {
    const deps = makeDeps({});
    const evolveTracker = spyDeps(deps, "evolve");
    const result = await maybeAutoEvolve(deps);
    expect(result.ran).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.result).toEqual(fixedResult);
    expect(evolveTracker.mock.calls()).toBe(1);
    const state = readState();
    expect(state?.lastNewTraces).toBe(50);
    expect(state?.lastRunAt).toBe(deps.now!());

    // 第二次：pending = 50 - 50 = 0 < minNewTraces(1) → 不 evolve
    const second = await maybeAutoEvolve(deps);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("insufficient-new");
    expect(evolveTracker.mock.calls()).toBe(1);
  });

  test("cooldown：距上次 < cooldown → cooldown 短路，getNewTraces 不被调用", async () => {
    presetState({ lastRunAt: 1000, lastNewTraces: 0 });
    const deps = makeDeps({
      now: () => 1000 + 1000,          // 距上次 1s
      cooldownMs: () => 60_000,          // 冷却 60s
      minNewTraces: () => 0,             // 即使 0 条新轨迹也到 evolve，验证冷却先短路
    });
    const gntTracker = spyDeps(deps, "getNewTraces");
    const result = await maybeAutoEvolve(deps);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("cooldown");
    expect(gntTracker.mock.calls()).toBe(0);
  });

  test("cooldown 过后 → ok 走下去", async () => {
    presetState({ lastRunAt: 1000, lastNewTraces: 0 });
    const deps = makeDeps({
      now: () => 1000 + 120_000,         // 距上次 120s > 60s
      cooldownMs: () => 60_000,
    });
    const result = await maybeAutoEvolve(deps);
    expect(result.reason).toBe("ok");
    expect(result.ran).toBe(true);
  });

  test("busy：evolve 未决期间二次入参 → busy，evolve 仍一次；resolve 后 pending 0 → insufficient-new", async () => {
    let resolveEvolve!: (v: typeof fixedResult) => void;
    const deps = makeDeps({
      evolve: () => new Promise<typeof fixedResult>((res) => { resolveEvolve = res; }),
    });
    const evolveTracker = spyDeps(deps, "evolve");
    const evolveSpy = deps.evolve as unknown as (...a: unknown[]) => Promise<typeof fixedResult>;

    const firstPromise = maybeAutoEvolve(deps);
    const secondPromise = maybeAutoEvolve(deps);
    const second = await secondPromise;
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("busy");
    expect(evolveTracker.mock.calls()).toBe(1);

    resolveEvolve!(fixedResult);
    const first = await firstPromise;
    expect(first.reason).toBe("ok");

    // resolve 后状态已推进（lastNewTraces=50），第三次调用 pending 0 → insufficient-new
    const third = await maybeAutoEvolve(deps);
    expect(third.reason).toBe("insufficient-new");
    expect(evolveTracker.mock.calls()).toBe(1);
    void evolveSpy;
  });

  test("损坏 state：解析失败降级全 0，走 ok 不抛", async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{not json", "utf-8");
    const result = await maybeAutoEvolve(makeDeps({}));
    expect(result.reason).toBe("ok");
    expect(result.ran).toBe(true);
  });

  test("水位回退：轨迹文件被清空/归档后从新基重新计数，不长期卡 insufficient-new", async () => {
    // 上次 evolve 后水位 50；随后文件被清空（0 条）——lastNewTraces 是旧高水位
    presetState({ lastRunAt: 0, lastNewTraces: 50 });
    let count = 0; // 当前轨迹总数：清空后为 0，随后真实轨迹累积
    const deps = makeDeps({
      getNewTraces: async () => count,
      minNewTraces: () => 30,
    });
    const evolveTracker = spyDeps(deps, "evolve");

    // 清空后第一次调用：0 条 → 不 evolve，且水位应回退到 0（持久化，防旧高水位残留）
    count = 0;
    let r = await maybeAutoEvolve(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("insufficient-new");
    expect(evolveTracker.mock.calls()).toBe(0);
    expect(readState()?.lastNewTraces).toBe(0); // 水位已回退

    // 累积 30 条真实轨迹 → 应 evolve（若不回退水位，pending = 30-50 = -20 < 30 会卡死）
    count = 30;
    r = await maybeAutoEvolve(deps);
    expect(r.ran).toBe(true);
    expect(r.reason).toBe("ok");
    expect(evolveTracker.mock.calls()).toBe(1);
  });

  test("evolve 抛错 → reason error，且 state.lastNewTraces 已推进（防热重试）", async () => {
    const deps = makeDeps({
      evolve: async () => { throw new Error("boom"); },
    });
    const evolveTracker = spyDeps(deps, "evolve");
    const result = await maybeAutoEvolve(deps);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("error");
    expect(evolveTracker.mock.calls()).toBe(1);
    const state = readState();
    expect(state?.lastNewTraces).toBe(50);
    expect(state?.lastRunAt).toBe(deps.now!());
  });
});