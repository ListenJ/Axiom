/**
 * applySelfThought 集成测试 — 自我思考注入聊天上下文。
 *
 * Contract:
 *   - 给定 engine（仅需 selfThink），把 [Self-Thought] system 消息追加到消息末尾；
 *   - engine 失败 / 未提供 / 输入为空 → 原消息原样返回，不阻断主流程。
 */
import { describe, test, expect } from "bun:test";
import { applySelfThought } from "../../src/self-evolve/engine.js";
import type { Message, SelfThought } from "../../src/self-evolve/types.js";

const thought: SelfThought = {
  goal: "Fix MCP timeout",
  assumptions: ["config is root cause"],
  plan: ["verify config", "retry with backoff"],
  risks: ["network flaky"],
  confidence: 0.75,
  evidence: [{ title: "MCP docs", url: "https://x", snippet: "s", score: 0.9, provenance: "web" }],
};

const baseMessages: Message[] = [
  { role: "system", content: "Enhanced general" },
  { role: "user", content: "Fix MCP timeout" },
];

describe("applySelfThought", () => {
  test("appends [Self-Thought] system message with goal and plan", async () => {
    const engine = { selfThink: async () => thought };
    const out = await applySelfThought(baseMessages, "Fix MCP timeout", engine);

    expect(out.length).toBe(baseMessages.length + 1);
    const added = out[out.length - 1];
    expect(added.role).toBe("system");
    expect(added.content).toContain("[Self-Thought]");
    expect(added.content).toContain("Fix MCP timeout");
    expect(added.content).toContain("verify config");
    expect(added.content).toContain("Confidence: 75%");
  });

  test("returns original messages when engine throws", async () => {
    const engine = {
      selfThink: async () => {
        throw new Error("model unavailable");
      },
    };
    const out = await applySelfThought(baseMessages, "Fix MCP timeout", engine);

    expect(out).toEqual(baseMessages);
    expect(out).toBe(baseMessages);
  });

  test("returns original messages when no engine provided", async () => {
    const out = await applySelfThought(baseMessages, "Fix MCP timeout");

    expect(out).toEqual(baseMessages);
  });

  test("returns original messages when input is empty", async () => {
    const engine = { selfThink: async () => thought };
    const out = await applySelfThought(baseMessages, "   ", engine);

    expect(out).toEqual(baseMessages);
  });
});
