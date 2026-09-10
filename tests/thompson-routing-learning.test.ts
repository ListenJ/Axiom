/**
 * S4 thompson 学习回路测试 — arms 填充 / 反馈接线 / 平级 tie-break / 降级
 *
 * 对应 docs/superpowers/specs/2026-08-29-p1-lift-design.md §S4：
 *   ① arms 填充：buildThompsonArms（组合根函数）把模型注册表映射为 RouterArm（均匀先验 Beta(1,1)）
 *   ② 反馈接线：execute 成功/失败记录点同步 reportFeedback(armId, success)
 *   ③ tie-break 学习：固定反馈序列后，同优先级 A/B 候选选择稳定偏向赢家
 *   ④ thompson 不可用 / 空 arms → 现状静态排序（逐字节兼容）
 */
import { describe, test, expect, spyOn } from "bun:test";
import { MultiPlatformRouter, buildThompsonArms } from "../src/router/model-router.js";
import { findModelsForRole, listAllModels, type ModelCapability } from "../src/router/model-capability-registry.js";
import { createThompsonRouter, type RouterArm } from "../src/router/thompson-router.js";
import { PROVIDER_CONFIG } from "../src/router/models.js";

const ROLE = "architecture" as const;

function chatOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok-s4" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 记录型 fake thompson：getArmIds 为空 → 不参与 tie-break，仅记录反馈调用 */
class RecordingThompson {
  readonly calls: Array<{ armId: string; success: boolean }> = [];
  getArmIds(): string[] { return []; }
  async route(): Promise<{ samples: Array<{ armId: string; value: number }> }> { return { samples: [] }; }
  reportFeedback(armId: string, success: boolean): void { this.calls.push({ armId, success }); }
}

/**
 * role=architecture 非轻任务路由（不在 LIGHT_ROUTES），前两个候选
 * gpt-5.4-pro / claude-opus-4.8 均为 priority 1 —— 构成稳定平级组。
 */
function tiePair(): [ModelCapability, ModelCapability] {
  const candidates = findModelsForRole(ROLE);
  expect(candidates.length).toBeGreaterThanOrEqual(2);
  const a = candidates[0]!;
  const b = candidates[1]!;
  expect(a.priority).toBe(1);
  expect(b.priority).toBe(1);
  return [a, b];
}

function armOf(m: ModelCapability): RouterArm {
  return { id: m.id, model: m.model, provider: m.provider, alpha: 1, beta: 1 };
}

const savedEnvKeys: Array<[string, string | undefined]> = [];

/** 为候选 provider 注入测试 API key（防 Missing API key 永久失败路径） */
function ensureKeys(providers: Array<string>): void {
  for (const provider of providers) {
    const cfg = PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG];
    if (!cfg) throw new Error(`no provider config: ${provider}`);
    savedEnvKeys.push([cfg.apiKeyEnv, process.env[cfg.apiKeyEnv]]);
    process.env[cfg.apiKeyEnv] = "test-key-s4";
  }
}

function restoreKeys(): void {
  for (const [name, value] of savedEnvKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvKeys.length = 0;
}

function mockSuccessFetch() {
  return spyOn(globalThis, "fetch").mockImplementation((async () => chatOk()) as unknown as typeof fetch);
}

function excludeOthers(keep: ModelCapability[]): string[] {
  return findModelsForRole(ROLE)
    .filter((m) => !keep.some((k) => k.id === m.id))
    .map((m) => m.id);
}

// ═══════════════════════════════════════════════════════════════
// ① arms 填充（组合根函数单测：providers 注册表 → RouterArm）
// ═══════════════════════════════════════════════════════════════
describe("S4-① arms 填充", () => {
  test("buildThompsonArms：注册表全量模型 → RouterArm（id/model/provider/均匀先验）", () => {
    const arms = buildThompsonArms();
    const registry = listAllModels();
    expect(registry.length).toBeGreaterThan(0);
    const uniqueIds = new Set(registry.map((m) => m.id));
    expect(arms.length).toBe(uniqueIds.size);
    const byId = new Map(arms.map((arm) => [arm.id, arm]));
    for (const m of registry) {
      const arm = byId.get(m.id);
      expect(arm).toBeDefined();
      expect(arm!.model).toBe(m.model);
      expect(arm!.provider).toBe(m.provider);
      expect(arm!.alpha).toBe(1);
      expect(arm!.beta).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ② 反馈接线（execute 成功/失败记录点 → reportFeedback）
// ═══════════════════════════════════════════════════════════════
describe("S4-② 反馈接线", () => {
  test("execute 成功 → reportFeedback(armId, true) 恰一次", async () => {
    const [a] = tiePair();
    ensureKeys([a.provider]);
    const fetchSpy = mockSuccessFetch();
    try {
      const fake = new RecordingThompson();
      const r = new MultiPlatformRouter();
      r.setThompsonRouter(fake);
      const out = await r.execute({
        role: ROLE,
        messages: [{ role: "user", content: "feedback success s4" }],
        temperature: 0.7,
      });
      expect(out.fallbackUsed).toBe(false);
      expect(out.model).toBe(a.model);
      expect(fake.calls).toEqual([{ armId: a.id, success: true }]);
    } finally {
      fetchSpy.mockRestore();
      restoreKeys();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ③ tie-break 学习（固定反馈序列 → 同优先级选择偏向赢家）
// ═══════════════════════════════════════════════════════════════
describe("S4-③ tie-break 学习", () => {
  test("A/B 同优先级，固定反馈偏袒静态第二位的 B 后，选择稳定偏向 B", async () => {
    const [a, b] = tiePair();
    ensureKeys([a.provider, b.provider]);
    const fetchSpy = mockSuccessFetch();
    try {
      // 真实 ThompsonRouter（inMemory，工厂默认 decayFactor=0.95）：
      // B 连续成功、A 连续失败 —— 强后验分离
      const thompson = createThompsonRouter({
        arms: [armOf(a), armOf(b)],
        minSamples: 5,
        inMemory: true,
      });
      for (let i = 0; i < 30; i++) {
        thompson.reportFeedback(b.id, true);
        thompson.reportFeedback(a.id, false);
      }
      const r = new MultiPlatformRouter();
      r.setThompsonRouter(thompson);
      const excludeModels = excludeOthers([a, b]);
      const runs = 20;
      let bWins = 0;
      for (let i = 0; i < runs; i++) {
        const out = await r.execute({
          role: ROLE,
          messages: [{ role: "user", content: `tie-break ${i}` }],
          temperature: 0.7,
          excludeModels,
        });
        expect(out.fallbackUsed).toBe(false);
        if (out.model === b.model) bWins++;
      }
      // 无学习信号时静态序恒选 a；学习后 b 应占绝对多数（Beta 后验强分离）
      expect(bWins).toBeGreaterThanOrEqual(15);
      thompson.close();
    } finally {
      fetchSpy.mockRestore();
      restoreKeys();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ④ thompson 不可用 / 空 arms → 现状静态排序
// ═══════════════════════════════════════════════════════════════
describe("S4-④ 降级：现状排序", () => {
  const runs = 20;

  test("未注入 thompson → 平级组恒取静态序首个", async () => {
    const [a, b] = tiePair();
    ensureKeys([a.provider, b.provider]);
    const fetchSpy = mockSuccessFetch();
    try {
      const r = new MultiPlatformRouter();
      const excludeModels = excludeOthers([a, b]);
      for (let i = 0; i < runs; i++) {
        const out = await r.execute({
          role: ROLE,
          messages: [{ role: "user", content: `static-order ${i}` }],
          temperature: 0.7,
          excludeModels,
        });
        expect(out.fallbackUsed).toBe(false);
        expect(out.model).toBe(a.model);
      }
    } finally {
      fetchSpy.mockRestore();
      restoreKeys();
    }
  });

  test("注入空 arms fake → 现状排序，反馈调用不崩溃", async () => {
    const [a, b] = tiePair();
    ensureKeys([a.provider, b.provider]);
    const fetchSpy = mockSuccessFetch();
    try {
      const fake = new RecordingThompson();
      const r = new MultiPlatformRouter();
      r.setThompsonRouter(fake);
      const excludeModels = excludeOthers([a, b]);
      for (let i = 0; i < runs; i++) {
        const out = await r.execute({
          role: ROLE,
          messages: [{ role: "user", content: `empty-arms ${i}` }],
          temperature: 0.7,
          excludeModels,
        });
        expect(out.fallbackUsed).toBe(false);
        expect(out.model).toBe(a.model);
      }
      expect(fake.calls.length).toBe(runs);
      expect(fake.calls.every((c) => c.armId === a.id && c.success)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      restoreKeys();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ② 补充：失败反馈（放最后 —— 永久失败会拉黑本文件用到的候选 5 分钟）
// ═══════════════════════════════════════════════════════════════
describe("S4-② 反馈接线（失败路径）", () => {
  test("execute 失败 → reportFeedback(armId, false)", async () => {
    const [a] = tiePair();
    // 故意不注入 key；fetch mock 404 兜底（防环境已有真实 key 发起网络请求）。
    // "Missing API key" / "HTTP 404" 均为永久性失败：无重试退避，快速走完全部候选。
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    );
    try {
      const fake = new RecordingThompson();
      const r = new MultiPlatformRouter();
      r.setThompsonRouter(fake);
      const out = await r.execute({
        role: ROLE,
        messages: [{ role: "user", content: "feedback failure s4" }],
        temperature: 0.7,
      });
      expect(out.fallbackUsed).toBe(true);
      const failForA = fake.calls.find((c) => c.armId === a.id);
      expect(failForA).toBeDefined();
      expect(failForA!.success).toBe(false);
      expect(fake.calls.every((c) => !c.success)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 组合根接线存在性（main.ts 静态检查，与 architecture-integrity 同风格）
// ═══════════════════════════════════════════════════════════════
describe("S4 组合根接线", () => {
  test("main.ts 以 buildThompsonArms() 填充 arms 并注入 modelRouter", async () => {
    const src = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
    expect(src).toContain("arms: buildThompsonArms()");
    expect(src).toContain("setThompsonRouter(mathContext.thompsonRouter)");
  });
});
