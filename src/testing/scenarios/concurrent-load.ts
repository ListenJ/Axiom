/**
 * 并发负载场景 — 基线性能测试
 *
 * 生成 concurrency 个并发 worker，每个发送 requestsPerUser 个请求，
 * 测量每请求响应时间、总耗时、吞吐量与成功率/失败率，并计算百分位指标。
 */

import { logger } from "../../utils/logger.js";
import type { TestTask, TestResult, TestError } from "../cluster/types.js";

/**
 * 计算百分位指标（P50/P95/P99/平均）。
 * 使用线性插值法，空数组返回全零。
 */
export function calculatePercentiles(values: number[]): {
  p50: number;
  p95: number;
  p99: number;
  avg: number;
} {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, avg: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const percentile = (p: number): number => {
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    const weight = idx - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };
  return {
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    avg,
  };
}

/**
 * 运行并发负载测试。
 *
 * 每个"请求"为一次可配置的异步操作（默认 mock 延迟）。
 * 支持参数：
 *   - params.mockDelayMs：模拟工作耗时（默认 5ms）
 *   - params.failureRate：模拟失败概率（默认 0）
 */
export async function runConcurrentLoad(task: TestTask): Promise<TestResult> {
  const mockDelayMs =
    typeof task.params.mockDelayMs === "number" ? task.params.mockDelayMs : 5;
  const failureRate =
    typeof task.params.failureRate === "number" ? task.params.failureRate : 0;

  logger.info(
    `[concurrent-load] task=${task.id} concurrency=${task.concurrency} ` +
      `requestsPerUser=${task.requestsPerUser} mockDelayMs=${mockDelayMs} failureRate=${failureRate}`
  );

  const startTime = Date.now();
  const responseTimes: number[] = [];
  let successCount = 0;
  let failureCount = 0;
  const errors: TestError[] = [];

  // 单个 worker：顺序发送 requestsPerUser 个请求
  const worker = async (workerId: number): Promise<void> => {
    for (let i = 0; i < task.requestsPerUser; i++) {
      const reqStart = Date.now();
      try {
        // 模拟工作耗时
        await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
        // 模拟失败
        if (failureRate > 0 && Math.random() < failureRate) {
          throw new Error(`Simulated failure (worker=${workerId}, req=${i})`);
        }
        responseTimes.push(Date.now() - reqStart);
        successCount++;
      } catch (err) {
        responseTimes.push(Date.now() - reqStart);
        failureCount++;
        errors.push({
          timestamp: Date.now(),
          type: "runtime",
          message: (err as Error).message,
          context: { workerId, requestIndex: i },
        });
      }
    }
  };

  // 并发启动所有 worker
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < task.concurrency; w++) {
    workers.push(worker(w));
  }
  await Promise.all(workers);

  const durationMs = Date.now() - startTime;
  const totalRequests = task.concurrency * task.requestsPerUser;
  const { p50, p95, p99, avg } = calculatePercentiles(responseTimes);
  const throughput = durationMs > 0 ? (totalRequests / durationMs) * 1000 : 0;

  logger.info(
    `[concurrent-load] task=${task.id} done: total=${totalRequests} ` +
      `success=${successCount} failure=${failureCount} ` +
      `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
      `throughput=${throughput.toFixed(2)}req/s`
  );

  return {
    taskId: task.id,
    nodeId: task.assignedNodeId ?? "local",
    status: "completed",
    durationMs,
    metrics: {
      totalRequests,
      successCount,
      failureCount,
      avgResponseMs: avg,
      p50ResponseMs: p50,
      p95ResponseMs: p95,
      p99ResponseMs: p99,
      throughput,
      errorRate: totalRequests > 0 ? failureCount / totalRequests : 0,
    },
    errors,
  };
}
