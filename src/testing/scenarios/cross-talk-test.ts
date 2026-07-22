/**
 * 对话串词（状态泄漏）检测测试
 *
 * 创建多个并发会话，每个持唯一 secret token。
 * Mock 响应应仅含本会话 secret；按概率注入其它会话 secret 模拟串词。
 * 检测响应中是否出现非本会话 secret，判定串词违规。
 */

import { logger } from "../../utils/logger.js";
import type { TestTask, TestResult, TestError } from "../cluster/types.js";
import { calculatePercentiles } from "./concurrent-load.js";

/**
 * 运行对话串词检测测试。
 *
 * 支持参数：
 *   - params.crossTalkRate：模拟串词概率（默认 0.05）
 *   - params.mockDelayMs：单次响应模拟耗时（默认 5ms）
 */
export async function runCrossTalkTest(task: TestTask): Promise<TestResult> {
  const crossTalkRate =
    typeof task.params.crossTalkRate === "number"
      ? task.params.crossTalkRate
      : 0.05;
  const mockDelayMs =
    typeof task.params.mockDelayMs === "number" ? task.params.mockDelayMs : 5;

  logger.info(
    `[cross-talk] task=${task.id} sessions=${task.concurrency} ` +
      `requestsPerUser=${task.requestsPerUser} crossTalkRate=${crossTalkRate}`
  );

  // 为每个会话生成唯一 secret token
  const secrets: string[] = [];
  for (let s = 0; s < task.concurrency; s++) {
    const rand = Math.random().toString(36).slice(2, 10);
    secrets.push(`SECRET-${s}-${rand}`);
  }

  const startTime = Date.now();
  const responseTimes: number[] = [];
  let totalMessages = 0;
  let crossTalkCount = 0;
  const errors: TestError[] = [];

  // 单个会话：使用独立 context 对象，确保无共享状态
  const session = async (sessionId: number): Promise<void> => {
    const context = new Map<string, string>();
    context.set("secret", secrets[sessionId]);

    for (let i = 0; i < task.requestsPerUser; i++) {
      const reqStart = Date.now();
      const mySecret = context.get("secret") as string;
      const message = `Session ${sessionId} message ${i} with token ${mySecret}`;

      // Mock 响应：应仅包含本会话 secret
      let response = `Acknowledged: ${message}`;

      // 模拟串词：注入其它会话 secret
      if (Math.random() < crossTalkRate && task.concurrency > 1) {
        const offset = 1 + Math.floor(Math.random() * (task.concurrency - 1));
        const otherId = (sessionId + offset) % task.concurrency;
        response += ` [leaked: ${secrets[otherId]}]`;
      }

      await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
      const responseTime = Date.now() - reqStart;
      responseTimes.push(responseTime);
      totalMessages++;

      // 检测响应中是否含其它会话 secret → 串词违规
      for (let other = 0; other < task.concurrency; other++) {
        if (other === sessionId) continue;
        if (response.includes(secrets[other])) {
          crossTalkCount++;
          errors.push({
            timestamp: Date.now(),
            type: "cross-talk",
            message: `Cross-talk detected: session ${sessionId} leaked secret from session ${other}`,
            context: {
              sessionId,
              requestIndex: i,
              leakedSecret: secrets[other],
            },
          });
          break; // 每条消息计一次违规
        }
      }
    }
  };

  const sessions: Array<Promise<void>> = [];
  for (let s = 0; s < task.concurrency; s++) {
    sessions.push(session(s));
  }
  await Promise.all(sessions);

  const durationMs = Date.now() - startTime;
  const { p50, p95, p99, avg } = calculatePercentiles(responseTimes);
  const throughput = durationMs > 0 ? (totalMessages / durationMs) * 1000 : 0;
  const crossTalkRateMeasured =
    totalMessages > 0 ? crossTalkCount / totalMessages : 0;

  logger.info(
    `[cross-talk] task=${task.id} done: total=${totalMessages} ` +
      `crossTalk=${crossTalkCount} rate=${crossTalkRateMeasured.toFixed(4)}`
  );

  return {
    taskId: task.id,
    nodeId: task.assignedNodeId ?? "local",
    status: "completed",
    durationMs,
    metrics: {
      totalRequests: totalMessages,
      successCount: totalMessages - crossTalkCount,
      failureCount: crossTalkCount,
      avgResponseMs: avg,
      p50ResponseMs: p50,
      p95ResponseMs: p95,
      p99ResponseMs: p99,
      throughput,
      crossTalkCount,
      crossTalkRate: crossTalkRateMeasured,
      errorRate: crossTalkRateMeasured,
    },
    errors,
  };
}
