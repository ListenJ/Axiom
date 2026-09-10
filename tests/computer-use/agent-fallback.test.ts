/**
 * ComputerUseAgent 文本引导降级测试 — 无视觉模型时不抛错
 */
import { describe, it, expect, spyOn } from "bun:test";
import { ComputerUseAgent, type ComputerUseInput } from "../../src/agents/computer-use-agent.js";

describe("ComputerUseAgent.analyzeWithFallback", () => {
  it("无视觉模型时回退为文本引导（textGuided=true）", async () => {
    const agent = new ComputerUseAgent();
    const analyzeSpy = spyOn(agent, "analyze").mockRejectedValue(
      new Error("No vision model available. Configure an API key for a multimodal provider (SiliconFlow, OpenRouter, OfoxAI)."),
    );
    try {
      const input: ComputerUseInput = { task: "用户需要登录系统", targetUrl: "https://example.com/login" };
      const result = await agent.analyzeWithFallback(input);
      expect(result.textGuided).toBe(true);
      expect(result.model).toBe("text-guide");
      expect(result.completed).toBe(false);
      expect(result.reasoning).toContain("## 任务");
      expect(result.reasoning).toContain("未检测到可交互元素"); // 无 CDP → 空元素表优雅降级
    } finally {
      analyzeSpy.mockRestore();
    }
  });

  it("非『无视觉模型』错误继续抛出", async () => {
    const agent = new ComputerUseAgent();
    const analyzeSpy = spyOn(agent, "analyze").mockRejectedValue(new Error("CDP connection refused"));
    try {
      await expect(agent.analyzeWithFallback({ task: "x" })).rejects.toThrow("CDP connection refused");
    } finally {
      analyzeSpy.mockRestore();
    }
  });
});
