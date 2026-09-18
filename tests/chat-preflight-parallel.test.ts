/**
 * P0-A 决策链提速 —— chat 前置调用编排（chat-preflight）+ selfThink 并行测试。
 *
 * 全程依赖注入 fake，不用 bun mock.module（跨文件泄漏，见 routes-chat-validation.test.ts 注释）。
 *
 * 真实数据依赖（2026-08-29 通读核实，docs/superpowers/specs/2026-08-29-p0-lift-design.md §A）：
 *   optimizePrompt(原始输入) → rewritten
 *   buildAgentMessages(rewritten) → rawIntent（关键词意图基于【改写后】文本）
 *   enhanceIntentWithLLM(原始输入, rawIntent) — 语义分类用原始输入，但回退基线
 *     rawIntent 源自改写文本 ⇒ optimize → intent 必须保持串行（不并行）。
 *   selfThink 只依赖原始输入（routes 层直接取原始 user 消息）⇒ 与 prepare
 *     完全独立，可提前并发发起（startSelfThought + attachSelfThought）。
 *
 * Contract:
 *   - 串行路径：边缘不可用/无合并资格 → optimize → buildMessages →（低置信度）enhance，
 *     结果与旧实现一致（intent 基于改写文本、增强回退保留 agentName 等字段）；
 *   - 合并快路径：mergedEdge 返回 {rewritten,intent,confidence} 且通过确定性闸门
 *     → optimize/enhance 不被调用；agentMessages 基于合并改写文本；
 *     confidence = max(合并值, 0.6 下限, 关键词基线)，其余字段保留关键词基线；
 *   - 合并解析失败 / 闸门拒绝 → 回退串行路径（行为语义不变）；
 *   - mergedEdgePreflight：JSON 解析（含 code fence）、意图非法、调用失败 → null；
 *   - selfThink 并行：startSelfThought 在 prepare 进行中即已发起（事件序证明），
 *     attachSelfThought 注入消息形状与 applySelfThought 一致。
 */
import { describe, test, expect } from "bun:test";
import {
  runPreflight,
  mergedEdgePreflight,
  type PreflightDeps,
  type MergedPreflight,
} from "../src/services/chat-preflight.js";
import { startSelfThought, attachSelfThought } from "../src/self-evolve/engine.js";
import type { IntentResult } from "../src/agents/intent-router.js";
import type { SelfThought } from "../src/self-evolve/types.js";
import type { PromptOptimization } from "../src/agents/prompt-optimizer.js";

function makeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intent: "chat",
    agentName: "ChatAgent",
    confidence: 0.3,
    matchedKeywords: ["hi"],
    recommendedRole: "general-chat",
    ...overrides,
  };
}

const THOUGHT: SelfThought = {
  goal: "Fix login timeout",
  assumptions: [],
  plan: ["verify config", "retry"],
  risks: [],
  confidence: 0.75,
  evidence: [],
};

describe("runPreflight — 串行回退路径（行为语义不变）", () => {
  test("边缘不可用：optimize → build(改写文本) → enhance 顺序执行，结果与旧实现一致", async () => {
    const events: string[] = [];
    const baseIntent = makeIntent();
    const enhancedIntent = makeIntent({ intent: "code", confidence: 0.8, agentName: "ChatAgent" });
    const deps: PreflightDeps = {
      edge: null,
      canAttemptMerged: () => true,
      mergedEdge: async () => {
        events.push("merged:null");
        return null;
      },
      gates: () => true,
      optimize: async (input) => {
        events.push("optimize");
        return { text: `rewritten:${input}`, changed: true } satisfies PromptOptimization;
      },
      buildMessages: (input, history) => {
        events.push(`build:${input}`);
        return {
          intent: baseIntent,
          messages: [
            { role: "system", content: "sys" },
            ...history.map((h) => ({ role: h.role as "user" | "assistant" | "system", content: h.content })),
            { role: "user", content: input },
          ],
        };
      },
      enhance: async (_input, base) => {
        events.push(`enhance:${base.intent}`);
        return enhancedIntent;
      },
      shouldEnhance: (base) => base.confidence < 0.5,
    };

    const result = await runPreflight("hello world", [{ role: "user", content: "earlier" }], deps);

    // 顺序即依赖：意图基于改写后文本（这就是 optimize→intent 不能并行的事实依据）
    expect(events).toEqual(["merged:null", "optimize", "build:rewritten:hello world", "enhance:chat"]);
    expect(result.optimization).toEqual({ text: "rewritten:hello world", changed: true });
    expect(result.intent).toEqual(enhancedIntent);
    // agentMessages 与旧 buildAgentMessages 形状一致：system + history + 当前改写输入
    expect(result.agentMessages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "earlier" },
      { role: "user", content: "rewritten:hello world" },
    ]);
  });

  test("高置信度关键词意图：不触发增强（fast path 0ms 语义保留）", async () => {
    let enhanceCalled = 0;
    const baseIntent = makeIntent({ confidence: 0.9 });
    const deps: PreflightDeps = {
      edge: null,
      canAttemptMerged: () => false,
      mergedEdge: async () => null,
      gates: () => true,
      optimize: async (input) => ({ text: input, changed: false }),
      buildMessages: () => ({ intent: baseIntent, messages: [] }),
      enhance: async () => {
        enhanceCalled++;
        return baseIntent;
      },
      shouldEnhance: (base) => base.confidence < 0.5,
    };
    const result = await runPreflight("sort this code", [], deps);
    expect(enhanceCalled).toBe(0);
    expect(result.intent).toEqual(baseIntent);
  });

  test("无合并资格与合并失败两条路进入同一串行路径（结果一致）", async () => {
    const baseIntent = makeIntent();
    const mk = (canAttempt: boolean, merged: MergedPreflight | null): PreflightDeps => ({
      edge: null,
      canAttemptMerged: () => canAttempt,
      mergedEdge: async () => merged,
      gates: () => true,
      optimize: async (input) => ({ text: `r:${input}`, changed: true }),
      buildMessages: (input) => ({ intent: baseIntent, messages: [{ role: "user", content: input }] }),
      enhance: async (_i, base) => makeIntent({ intent: base.intent, confidence: 0.9 }),
      shouldEnhance: (base) => base.confidence < 0.5,
    });
    const a = await runPreflight("input text", [], mk(false, null));
    const b = await runPreflight("input text", [], mk(true, null));
    expect(a).toEqual(b);
  });
});

describe("runPreflight — 边缘合并快路径", () => {
  const merged: MergedPreflight = { rewritten: "clear prompt", intent: "code", confidence: 0.7 };

  function mergedDeps(events: string[], overrides: Partial<PreflightDeps> = {}): PreflightDeps {
    return {
      edge: null,
      canAttemptMerged: () => true,
      mergedEdge: async () => {
        events.push("merged");
        return merged;
      },
      gates: () => true,
      optimize: async () => {
        events.push("optimize");
        throw new Error("optimize must not run on merged path");
      },
      buildMessages: (input, history) => {
        events.push(`build:${input}`);
        return {
          intent: makeIntent(),
          messages: [
            ...history.map((h) => ({ role: h.role as "user" | "assistant" | "system", content: h.content })),
            { role: "user", content: input },
          ],
        };
      },
      enhance: async () => {
        events.push("enhance");
        throw new Error("enhance must not run on merged path");
      },
      shouldEnhance: () => true,
      ...overrides,
    };
  }

  test("合并成功：optimize/enhance 均不调用，agentMessages 基于合并改写文本", async () => {
    const events: string[] = [];
    const result = await runPreflight("raw input", [{ role: "user", content: "hist0" }], mergedDeps(events));
    expect(events).toEqual(["merged", "build:clear prompt"]);
    expect(result.optimization).toEqual({ text: "clear prompt", changed: true });
    expect(result.agentMessages).toEqual([
      { role: "user", content: "hist0" },
      { role: "user", content: "clear prompt" },
    ]);
  });

  test("意图组合保留关键词基线字段，confidence = max(合并值, 0.6 下限, 基线)", async () => {
    const events: string[] = [];
    const result = await runPreflight("raw input", [], mergedDeps(events));
    expect(result.intent.intent).toBe("code");
    expect(result.intent.agentName).toBe("ChatAgent");
    expect(result.intent.matchedKeywords).toEqual(["hi"]);
    expect(result.intent.recommendedRole).toBe("general-chat");
    expect(result.intent.confidence).toBe(0.7); // max(0.7, 0.6, 0.3)
  });

  test("1B 模型 confidence 无校准：低于 0.6 时抬到下限", async () => {
    const events: string[] = [];
    const deps = mergedDeps(events, { mergedEdge: async () => ({ rewritten: "r", intent: "code", confidence: 0.2 }) });
    const result = await runPreflight("raw input", [], deps);
    expect(result.intent.confidence).toBe(0.6); // max(0.2, 0.6, 0.3)
  });

  test("确定性闸门拒绝合并改写（照抄/语言漂移）→ 回退串行路径", async () => {
    const events: string[] = [];
    const deps = mergedDeps(events, {
      gates: () => false,
      optimize: async (input) => {
        events.push("optimize");
        return { text: `glm:${input}`, changed: true };
      },
      shouldEnhance: () => false,
    });
    const result = await runPreflight("raw input", [], deps);
    expect(events).toEqual(["merged", "optimize", "build:glm:raw input"]); // 串行路径接管，无 enhance
    expect(result.optimization).toEqual({ text: "glm:raw input", changed: true });
  });

  test("mergedEdge 抛错（依赖缺失/网络异常）→ 静默回退串行路径", async () => {
    const events: string[] = [];
    const deps = mergedDeps(events, {
      mergedEdge: async () => {
        throw new Error("edge down");
      },
      optimize: async (input) => {
        events.push("optimize");
        return { text: input, changed: false };
      },
      shouldEnhance: () => false,
    });
    const result = await runPreflight("raw input", [], deps);
    expect(events).toContain("optimize");
    expect(result.optimization.changed).toBe(false);
  });
});

describe("mergedEdgePreflight — 边缘结构化调用解析", () => {
  /** 最小 LLMResponse fake（仅 content 有效，其余字段满足类型） */
  function fakeClient(content: string | (() => never)) {
    return {
      generate: async () => {
        if (typeof content === "function") (content as () => never)();
        return {
          content: typeof content === "string" ? content : "",
          model: "fake-edge",
          usage: { promptTokens: 1, completionTokens: 1 },
          finishReason: "stop",
        };
      },
    };
  }

  test("纯 JSON 与 code fence 包裹 JSON 均可解析", async () => {
    expect(await mergedEdgePreflight("do the task now please", fakeClient('{"rewritten":"clean task","intent":"code","confidence":0.8}'))).toEqual({
      rewritten: "clean task",
      intent: "code",
      confidence: 0.8,
    });
    expect(await mergedEdgePreflight("帮我写一篇文章", fakeClient('```json\n{"rewritten":"另一任务","intent":"write","confidence":0.55}\n```'))).toEqual({
      rewritten: "另一任务",
      intent: "write",
      confidence: 0.55,
    });
  });

  test("意图非法 / 非对象 JSON / 缺字段 / 调用抛错 → null（回退信号）", async () => {
    expect(await mergedEdgePreflight("some input here", fakeClient('{"rewritten":"r","intent":"banana","confidence":0.9}'))).toBeNull();
    expect(await mergedEdgePreflight("some input here", fakeClient("sorry I cannot"))).toBeNull();
    expect(await mergedEdgePreflight("some input here", fakeClient('{"intent":"code","confidence":0.9}'))).toBeNull();
    expect(
      await mergedEdgePreflight("some input here", fakeClient(() => { throw new Error("ECONNREFUSED"); })),
    ).toBeNull();
  });

  test("开关关闭（enabled=false）时不开边缘调用（直接 null，组合根语义）", async () => {
    let calls = 0;
    const client = { generate: async () => { calls++; return { content: "{}", model: "f", usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop" }; } };
    // P0-A 注入化后开关经组合根 EdgeDep.enabled() 传入（routes 层读 EDGE_PROMPT_OPTIMIZER）
    expect(await mergedEdgePreflight("some input here", { enabled: () => false, client })).toBeNull();
    expect(await mergedEdgePreflight("some input here", null)).toBeNull();
    expect(calls).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("selfThink 并行（startSelfThought / attachSelfThought）", () => {
  test("selfThink 在 prepare 进行中即并发发起（事件序证明），attach 注入形状与 applySelfThought 一致", async () => {
    const events: string[] = [];
    const engine = {
      selfThink: async (req: { input: string }) => {
        events.push("think:start");
        await new Promise((r) => setTimeout(r, 20));
        events.push("think:end");
        return { ...THOUGHT, goal: req.input.slice(0, 50) };
      },
    };
    // routes 层时序：先发起 selfThink，再 await prepareChatContext
    const thoughtPromise = startSelfThought("fix the login timeout bug", engine);
    events.push("prepare:start");
    await new Promise((r) => setTimeout(r, 5)); // prepare 仍在进行
    expect(events).toContain("think:start"); // 并发发起：prepare 未结束时 selfThink 已启动
    expect(events).not.toContain("think:end");

    const prepared = [
      { role: "system" as const, content: "Enhanced code" },
      { role: "user" as const, content: "fix the login timeout bug" },
    ];
    const out = await attachSelfThought(prepared, thoughtPromise);
    expect(events).toContain("think:end");
    expect(out.length).toBe(prepared.length + 1);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain("[Self-Thought]");
    expect(out[0].content).toContain("fix the login timeout bug");
    expect(out[0].content).toContain("verify config");
    expect(out[0].content).toContain("Confidence: 75%");
    expect(prepared.length).toBe(2); // 原数组不被原地修改
  });

  test("空输入 / 无引擎 / 引擎抛错 → null，attach 原样返回同一数组", async () => {
    const prepared = [{ role: "system" as const, content: "s" }];
    const throwing = { selfThink: async () => { throw new Error("boom"); } };
    expect(await attachSelfThought(prepared, startSelfThought("   ", throwing))).toBe(prepared);
    expect(await attachSelfThought(prepared, startSelfThought("x", undefined))).toBe(prepared);
    expect(await attachSelfThought(prepared, startSelfThought("x", throwing))).toBe(prepared);
    expect(await attachSelfThought(prepared, Promise.resolve(null))).toBe(prepared);
  });
});
