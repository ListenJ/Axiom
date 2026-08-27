/**
 * 思考强度参数映射测试（纯函数，无依赖）
 *
 * 依据 knowledge-base/api-formats/*.md 文档，验证各供应商
 * 思考强度参数的格式差异（OpenAI reasoning_effort / Anthropic thinking /
 * Gemini thinkingConfig / DeepSeek thinking / OpenRouter reasoning /
 * SiliconFlow enable_thinking / Kimi / MiniMax）。
 */
import { describe, expect, it } from "bun:test";
import { normalizeEffort, buildReasoningParams } from "../src/router/reasoning-effort.js";

describe("normalizeEffort", () => {
  it("接受合法档位原样返回", () => {
    expect(normalizeEffort("low")).toBe("low");
    expect(normalizeEffort("medium")).toBe("medium");
    expect(normalizeEffort("high")).toBe("high");
  });

  it("未知值回退到 medium（默认强度）", () => {
    expect(normalizeEffort("ultra")).toBe("medium");
    expect(normalizeEffort("")).toBe("medium");
    expect(normalizeEffort(undefined)).toBe("medium");
  });

  it("大小写不敏感", () => {
    expect(normalizeEffort("HIGH")).toBe("high");
  });
});

describe("buildReasoningParams", () => {
  it("OpenAI 风格：reasoning_effort 直接透传", () => {
    expect(buildReasoningParams("opencode", "high")).toEqual({ reasoning_effort: "high" });
    expect(buildReasoningParams("zhipu", "low")).toEqual({ reasoning_effort: "low" });
  });

  it("DeepSeek：thinking.type + reasoning_effort", () => {
    expect(buildReasoningParams("deepseek", "high")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("Kimi：thinking.type（K2.x 风格）+ reasoning_effort", () => {
    expect(buildReasoningParams("kimi", "medium")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "medium",
    });
  });

  it("MiniMax：thinking.type adaptive（无强度档位）", () => {
    expect(buildReasoningParams("minimax", "high")).toEqual({
      thinking: { type: "adaptive" },
    });
  });

  it("SiliconFlow：enable_thinking + thinking_budget 按档位映射", () => {
    expect(buildReasoningParams("siliconflow", "low")).toEqual({
      enable_thinking: true,
      thinking_budget: 1024,
    });
    expect(buildReasoningParams("siliconflow", "high")).toEqual({
      enable_thinking: true,
      thinking_budget: 8192,
    });
  });

  it("OpenRouter：reasoning.effort 透传", () => {
    expect(buildReasoningParams("openrouter", "low")).toEqual({
      reasoning: { effort: "low" },
    });
  });

  it("Anthropic 兼容端点：thinking 预算制", () => {
    expect(buildReasoningParams("ofoxai-anthropic", "high")).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    expect(buildReasoningParams("ofoxai-anthropic", "low")).toEqual({
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
  });

  it("Gemini 兼容端点：thinkingConfig.thinkingBudget", () => {
    expect(buildReasoningParams("ofoxai-gemini", "medium")).toEqual({
      thinkingConfig: { thinkingBudget: 2048 },
    });
  });

  it("未配置思考参数时不返回空对象（调用方可安全展开）", () => {
    expect(buildReasoningParams("nvidia-nim", "medium")).toEqual({});
  });

  it("不修改输入对象（纯函数）", () => {
    const before = JSON.stringify({ a: 1 });
    buildReasoningParams("openai", "high");
    expect(JSON.stringify({ a: 1 })).toBe(before);
  });
});
