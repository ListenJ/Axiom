/**
 * 审计 M8（2026-08-28）：orchestrator recordEvolution 非阻塞
 *
 * 此前 executeTask 在返回前同步 await selfImprove（内部 LLM 调用），每任务
 * 吞吐被进化回流放大。recordEvolution 返回值无任何消费方（全仓 3 处调用均
 * await 后丢弃），store.write 为独立 Map set + 唯一路径 vault 写（无读改写
 * 竞态），recordTrace 为同步入栈 → 改为 fire-and-forget（void + catch 兜底）。
 * 本测试锁定：executeTask 不等待 selfImprove 完成即返回。
 */
import { describe, test, expect } from "bun:test";
import { AgentOrchestrator } from "../src/agents/orchestrator.js";

describe("审计 M8: recordEvolution 非阻塞", () => {
  test("executeTask 不等待 selfImprove 完成", async () => {
    let improveCalled = false;
    const selfImprove = async () => {
      improveCalled = true;
      await Bun.sleep(200); // 模拟 LLM 进化回流耗时
      return { revisedPlan: ["x"], lesson: "", success: true };
    };

    const orch = new AgentOrchestrator({ selfEvolve: { selfImprove } });
    orch.getRegistry().register({
      id: "m8-fake",
      name: "M8 Fake",
      description: "",
      capabilities: ["m8-probe"],
      execute: async (task) => ({
        taskId: task.id,
        agentId: "m8-fake",
        success: true,
        duration: 1,
      }),
      healthCheck: async () => true,
    });

    const start = Date.now();
    const result = await orch.executeTask({
      id: "m8-t1",
      type: "m8-probe",
      description: "probe",
      input: {},
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    await Bun.sleep(1); // 让出轮次，确认回流已被触发
    expect(improveCalled).toBe(true);
    expect(elapsed).toBeLessThan(80); // 旧实现同步 await selfImprove(200ms) → 必红
  });
});
