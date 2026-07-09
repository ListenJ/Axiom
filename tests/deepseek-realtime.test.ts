/**
 * 真实 DeepSeek API 测试
 * 使用 router.chat() 遍历模型列表，DeepSeek 有最高优先级
 */
import { describe, it, expect } from "bun:test";

describe("DeepSeek 真实链路", () => {
  it("router.chat 完整链路 (DeepSeek 优先)", async () => {
    const { router } = await import("../src/router/model-router.js");
    const result = await router.chat("general-chat", [
      { role: "user", content: "Reply with exactly 3 words: what is sky?" },
    ]);
    expect(result.content).toBeDefined();
    expect(result.content!.length).toBeGreaterThan(0);
    console.log(`  ✓ Model: ${result.model}`);
    console.log(`  ✓ Provider: ${result.provider}`);
    console.log(`  ✓ Response: "${result.content!.trim()}"`);
  }, 120000);

  it("services.executeChat 完整链路", async () => {
    const { executeChat } = await import("../src/services/index.js");
    const result = await executeChat(
      [{ role: "user", content: "Reply 'marco': say polo" }],
      null,
      "general-chat",
    );
    expect(result.content).toBeDefined();
    console.log(`  ✓ Service: "${result.content!.trim()}"`);
  }, 120000);

  it("services + intent 链路", async () => {
    const { executeChat, prepareChatContext } = await import("../src/services/index.js");
    const { chatMessages, intentInfo } = await prepareChatContext(
      [{ role: "user", content: "Write bubble sort in Python" }],
      true,
      null,
    );
    expect(intentInfo).toBeDefined();
    console.log(`  ✓ Intent: ${intentInfo!.intent}`);

    const result = await executeChat(chatMessages, intentInfo, undefined);
    expect(result.content).toBeDefined();
    console.log(`  ✓ Generated (${result.content!.length} chars)`);
  }, 120000);
});
