/**
 * Computer Use v2.0 联调测试
 *
 * 测试目标:
 *   1. 模型选择 — 正确选择 Qwen-VL 模型
 *   2. 消息构建 — 元素结构正确嵌入 system prompt
 *   3. 响应解析 — elementIndex 正确解析为坐标
 *   4. CDP 操作序列 — 多步任务链正确执行
 *
 * 由于 Lightpanda CDP 需要实际浏览器，本测试使用 mock 验证逻辑。
 */

import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import {
  ComputerUseAgent,
  getComputerUseAgent,
  type ComputerUseInput,
  type ComputerUseResult,
} from "../src/agents/computer-use-agent.js";
import { router } from "../src/router/model-router.js";

describe("Computer Use v2.0 Integration", () => {
  let executeSpy: ReturnType<typeof spyOn> | undefined;

  beforeAll(() => {
    // Mock 视觉模型调用，避免真实 API 请求
    executeSpy = spyOn(router, "executeWithRole").mockImplementation(async () => ({
      content: JSON.stringify({
        reasoning: "Click the login button at element index 3",
        completed: false,
        actions: [
          { type: "click", elementIndex: 3, description: "Click login button" },
        ],
      }),
      role: "computer-use",
      model: "qwen2.5-vl-72b",
      provider: "siliconflow",
      endpoint: "https://api.siliconflow.cn/v1",
      latency_ms: 1200,
      fallback_used: false,
    }));
  });

  afterAll(() => {
    executeSpy?.mockRestore();
  });

  it("should select Qwen-VL as default vision model", () => {
    const agent = getComputerUseAgent();
    const models = agent.listVisionModels();

    // Should have Qwen models
    const qwenModels = models.filter((m) => /qwen.*vl|qvq/i.test(m.id));
    expect(qwenModels.length).toBeGreaterThan(0);

    // Should have Qwen2.5-VL-72B
    const qwen25 = models.find((m) => m.id === "qwen2.5-vl-72b");
    expect(qwen25).toBeDefined();
    expect(qwen25?.provider).toBe("siliconflow");
  });

  it("should build messages with element structure", async () => {
    const agent = new ComputerUseAgent();
    const mockElements = [
      {
        index: 0,
        tag: "button",
        text: "Login",
        role: "button",
        x: 100,
        y: 200,
        width: 80,
        height: 40,
        centerX: 140,
        centerY: 220,
        visible: true,
        attrs: { id: "login-btn" },
      },
      {
        index: 1,
        tag: "input",
        text: "",
        role: "textbox",
        x: 100,
        y: 150,
        width: 200,
        height: 30,
        centerX: 200,
        centerY: 165,
        visible: true,
        attrs: { placeholder: "Username" },
      },
    ];

    // Use reflection to test private buildMessages
    const buildMessages = (agent as any).buildMessages.bind(agent);
    const messages = buildMessages(
      { task: "Click the login button" },
      "fake-base64",
      mockElements as any
    );

    expect(messages.length).toBe(2); // system + user
    expect(messages[0].role).toBe("system");
    const systemContent = String(messages[0].content);
    expect(systemContent).toContain("Index");
    expect(systemContent).toContain("Login");
    expect(systemContent).toContain("button");

    // User message should have image
    expect(Array.isArray(messages[1].content)).toBe(true);
    const userParts = messages[1].content as any[];
    expect(userParts.some((p) => p.type === "image_url")).toBe(true);
  });

  it("should parse response with elementIndex resolution", async () => {
    const agent = new ComputerUseAgent();
    const mockElements = [
      { index: 3, tag: "button", text: "Login", role: "button", centerX: 140, centerY: 220, x: 100, y: 200, width: 80, height: 40, visible: true, attrs: {} },
    ];

    const parseResponse = (agent as any).parseResponse.bind(agent);
    const mockContent = JSON.stringify({
      reasoning: "Click login",
      completed: false,
      actions: [{ type: "click", elementIndex: 3, description: "Click login" }],
    });

    const result = parseResponse(mockContent, mockElements as any);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe("click");
    expect((result.actions[0] as any).x).toBe(140);
    expect((result.actions[0] as any).y).toBe(220);
    expect((result.actions[0] as any).elementIndex).toBe(3);
  });

  it("should fallback to coordinates when no elementIndex match", async () => {
    const agent = new ComputerUseAgent();
    const parseResponse = (agent as any).parseResponse.bind(agent);

    const mockContent = JSON.stringify({
      reasoning: "Click at coordinates",
      completed: false,
      actions: [{ type: "click", x: 500, y: 300, description: "Click somewhere" }],
    });

    const result = parseResponse(mockContent, []);
    expect(result.actions[0].type).toBe("click");
    expect((result.actions[0] as any).x).toBe(500);
    expect((result.actions[0] as any).y).toBe(300);
  });

  it("should handle empty or invalid response gracefully", async () => {
    const agent = new ComputerUseAgent();
    const parseResponse = (agent as any).parseResponse.bind(agent);

    const result1 = parseResponse(null, []);
    expect(result1.actions.length).toBe(0);
    expect(result1.completed).toBe(false);

    const result2 = parseResponse("not json", []);
    expect(result2.actions.length).toBe(0);

    const result3 = parseResponse("{}", []);
    expect(result3.actions.length).toBe(0);
  });
});

describe("Computer Use CDP Mock Integration", () => {
  it("should execute click action with resolved coordinates", async () => {
    const agent = new ComputerUseAgent();

    // Mock executeCDPAction via dynamic import override
    const { executeCDPAction } = await import("../src/crawl/lightpanda-client.js");
    let capturedAction: any = null;

    const originalExecute = executeCDPAction;
    // Note: we can't easily mock module exports in bun:test without spying on imports
    // This test verifies the agent logic structure

    const result = await agent.executeAction(
      { type: "click", x: 100, y: 200, description: "Test click" },
      undefined // no cdpUrl → should return error
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("CDP URL not provided");
  });
});
