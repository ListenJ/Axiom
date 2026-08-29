/**
 * M10 云端降级上下文补全测试（P2-S5，docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S5）
 *
 * 审计 M10：cloudConsciousnessStep 降级只发 input.observation，本地工作记忆不随行，
 * 降级后行为不一致。
 *
 * 本文件经公共接口验证四组行为：
 * ① 工作记忆有内容 → mock caller 捕获的 user prompt 含 "[Local working memory context]"
 *    标记头与记忆片段（时间倒序，最新条目保留）
 * ② 记忆为空（cloudContextMaxEntries=0）或记忆流不可用（提取抛错）→ user prompt 与
 *    observation 逐字节一致（吞错降级，不因记忆故障中断降级链）
 * ③ 摘要 ≤2KB（UTF-8 字节）截断生效，且每条记忆截断 200 字符
 * 红线：注入记忆的同时 HallucinationGate / recordVerdict 接线保持（判定透传不丢）；
 *       返回结构不变（fallbackLevel=cloud，decision 正常解析）。
 */

import { describe, test, expect } from "bun:test";

type EngineModule = typeof import("../src/dre/engine.js");
type DreEngineCtor = ConstructorParameters<EngineModule["DREngine"]>[0];
type Engine = InstanceType<EngineModule["DREngine"]>;

const OBS = "classify quicksort complexity";

/** 与 tests/hallucination-wiring.test.ts ⑤ 同型组合根：不可达本地端点 → L1 失败走 L2 cloud */
const makeEngine = async (overrides: Partial<DreEngineCtor>): Promise<Engine> => {
  const { DREngine } = await import("../src/dre/engine.js");
  return new DREngine({
    dbPath: ":memory:",
    mainLLM: { baseUrl: "http://127.0.0.1:9", model: "test", timeout: 50 },
    cloudFallback: { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "cloud" },
    ...overrides,
  });
};

/** 捕获 mock caller 收到的 user prompt */
const capturingCaller = (onCall: (user: string) => void) => ({
  call: async (input: { user: string }) => {
    onCall(input.user);
    return {
      content: JSON.stringify({ action: "observe", content: "routine observation", confidence: 0.9 }),
    };
  },
});

const pushMemory = (engine: Engine, id: string, content: string): void => {
  engine.consciousness.workingMemory.push({
    id,
    content,
    timestamp: Date.now(),
    metadata: {},
  });
};

describe("M10：云端降级注入本地工作记忆上下文", () => {
  test("① 工作记忆有内容 → user prompt 含注入头与记忆片段（时间倒序）", async () => {
    let captured = "";
    const engine = await makeEngine({
      cloudCaller: capturingCaller((user) => { captured = user; }),
    });
    await engine.waitForReady();
    try {
      pushMemory(engine, "wm-seed-1", "user asked about quicksort average complexity");
      pushMemory(engine, "wm-seed-2", "reflection queued: check evidence for complexity claims");
      const r = await engine.consciousnessStep({ observation: OBS });
      expect(r.fallbackLevel).toBe("cloud");
      // 注入头 + 记忆片段都随行
      expect(captured).toContain(OBS);
      expect(captured).toContain("[Local working memory context]");
      expect(captured).toContain("user asked about quicksort average complexity");
      expect(captured).toContain("reflection queued: check evidence for complexity claims");
      // 注入段位于 observation 之后（observation + "\n\n" + 头 + "\n" + 摘要）
      expect(captured.startsWith(OBS + "\n\n[Local working memory context]\n")).toBe(true);
    } finally {
      await engine.close();
    }
  });

  test("②a 记忆条数上限配置为 0（注入禁用）→ user 与 observation 逐字节一致", async () => {
    let captured = "";
    const engine = await makeEngine({
      cloudContextMaxEntries: 0,
      cloudCaller: capturingCaller((user) => { captured = user; }),
    });
    await engine.waitForReady();
    try {
      pushMemory(engine, "wm-seed-1", "seed memory that must not leak into prompt");
      const r = await engine.consciousnessStep({ observation: OBS });
      expect(r.fallbackLevel).toBe("cloud");
      expect(captured).toBe(OBS);
    } finally {
      await engine.close();
    }
  });

  test("②b 记忆流不可用（提取抛错）→ 吞错降级，user 与 observation 逐字节一致", async () => {
    let captured = "";
    const engine = await makeEngine({
      cloudCaller: capturingCaller((user) => { captured = user; }),
    });
    await engine.waitForReady();
    try {
      Object.defineProperty(engine.consciousness, "workingMemory", {
        get() { throw new Error("stream unavailable"); },
        configurable: true,
      });
      const r = await engine.consciousnessStep({ observation: OBS });
      expect(r.fallbackLevel).toBe("cloud");
      expect(captured).toBe(OBS);
    } finally {
      await engine.close();
    }
  });

  test("③ 摘要 ≤2KB（UTF-8 字节）截断生效，每条记忆截断 200 字符", async () => {
    let captured = "";
    const engine = await makeEngine({
      cloudCaller: capturingCaller((user) => { captured = user; }),
    });
    await engine.waitForReady();
    try {
      // 8 条 ~320 字符 CJK 条目（超预算），仅最新若干条可进入 2KB 预算
      for (let i = 0; i < 8; i++) {
        pushMemory(engine, `wm-seed-${i}`, `记忆条目${i}：` + "复杂度分析上下文".repeat(40));
      }
      const r = await engine.consciousnessStep({ observation: OBS });
      expect(r.fallbackLevel).toBe("cloud");
      const header = "[Local working memory context]\n";
      const idx = captured.indexOf(header);
      expect(idx).toBeGreaterThan(0);
      const summary = captured.slice(idx + header.length);
      // 总长 ≤2KB（UTF-8 字节）
      expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(2048);
      // 时间倒序：最新条目（7）保留，最旧条目（0-2）被预算淘汰
      expect(summary).toContain("记忆条目7");
      expect(summary).not.toContain("记忆条目2");
      expect(summary).not.toContain("记忆条目0");
    } finally {
      await engine.close();
    }
  });

  test("红线：注入记忆的同时 gate/recordVerdict 接线保持（判定透传不丢）", async () => {
    let captured = "";
    const recorded: Array<{ verdict: string; isAccepted: boolean }> = [];
    const engine = await makeEngine({
      cloudCaller: capturingCaller((user) => { captured = user; }),
      hallucinationGate: () => ({ verdict: "accepted", pValue: 1, isAccepted: true }),
      recordVerdict: (rec: { verdict: string; isAccepted: boolean }) => { recorded.push(rec); },
    });
    await engine.waitForReady();
    try {
      pushMemory(engine, "wm-seed-1", "user asked about quicksort average complexity");
      const r = await engine.consciousnessStep({
        observation: OBS,
        metadata: { evidence: ["quicksort is a sorting algorithm"] },
      });
      expect(r.fallbackLevel).toBe("cloud");
      // 记忆已注入
      expect(captured).toContain("[Local working memory context]");
      // 红线不破：gate 判定照常透传落库
      expect(recorded.length).toBe(1);
      expect(recorded[0]!.verdict).toBe("accepted");
      expect(recorded[0]!.isAccepted).toBe(true);
    } finally {
      await engine.close();
    }
  });
});

describe("M10：摘要构建纯函数（buildCloudMemoryContext / composeCloudUserPrompt）", () => {
  test("空条目 + 无反思结论 → 空串（调用方据此直发 observation）", async () => {
    const { buildCloudMemoryContext } = await import("../src/dre/engine.js");
    expect(buildCloudMemoryContext({ entries: [] })).toBe("");
    expect(buildCloudMemoryContext({ entries: [{ content: "   " }] })).toBe("");
  });

  test("每条截断 200 字符；时间倒序（最新在前）；反思结论随行", async () => {
    const { buildCloudMemoryContext } = await import("../src/dre/engine.js");
    const long = "x".repeat(300);
    const summary = buildCloudMemoryContext({
      entries: [
        { content: "older entry about retry policy" },
        { content: long },
      ],
      lastReflectionSummary: "连续失败 3 次; 需要加强错误处理",
    });
    const lines = summary.split("\n");
    // 时间倒序：最新（long）在前，旧条目在后，反思结论最后
    expect(lines[0]).toContain("x".repeat(200));
    expect(lines[0]!.length).toBe(200);
    expect(lines[1]).toContain("older entry about retry policy");
    expect(lines[lines.length - 1]).toContain("连续失败 3 次");
    expect(lines[lines.length - 1]).toContain("需要加强错误处理");
  });

  test("composeCloudUserPrompt：无摘要逐字节现状；有摘要追加标记头", async () => {
    const { composeCloudUserPrompt } = await import("../src/dre/engine.js");
    expect(composeCloudUserPrompt(OBS, null)).toBe(OBS);
    expect(composeCloudUserPrompt(OBS, "")).toBe(OBS);
    expect(composeCloudUserPrompt(OBS, "- latest entry")).toBe(
      OBS + "\n\n[Local working memory context]\n- latest entry",
    );
  });
});
