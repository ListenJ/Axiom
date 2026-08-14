/**
 * 多用户并发幻觉检测测试
 *
 * 基于 fact base 生成查询，模拟 LLM 响应（默认 mock），
 * 用轻量级 Jaccard 相似度判定响应是否幻觉（不引入完整 HallucinationDetector）。
 */

import { logger } from "../../utils/logger.js";
import type { TestTask, TestResult, TestError } from "../cluster/types.js";
import { calculatePercentiles } from "./concurrent-load.js";
import { createSeededRng } from "./random.js";

/** 测试用事实条目（轻量结构，不依赖 memory 模块） */
interface TestFact {
  text: string;
  confidence: number;
}

/** 默认测试事实库（10 条覆盖多主题） */
export const DEFAULT_TEST_FACTS: TestFact[] = [
  { text: "The Earth orbits around the Sun once every 365.25 days.", confidence: 1.0 },
  { text: "Water boils at 100 degrees Celsius at sea level pressure.", confidence: 1.0 },
  { text: "The Great Wall of China is located in northern China.", confidence: 0.9 },
  { text: "Photosynthesis converts carbon dioxide and water into glucose and oxygen.", confidence: 1.0 },
  { text: "The speed of light in vacuum is approximately 299792458 meters per second.", confidence: 1.0 },
  { text: "Mount Everest is the highest mountain above sea level on Earth.", confidence: 0.95 },
  { text: "The Pacific Ocean is the largest and deepest ocean on Earth.", confidence: 0.95 },
  { text: "DNA carries the genetic instructions for living organisms.", confidence: 1.0 },
  { text: "The human heart has four chambers two atria and two ventricles.", confidence: 0.9 },
  { text: "Java is a programming language released in 1995 by Sun Microsystems.", confidence: 0.85 },
];

/** 编造的（幻觉）响应池 — 与事实库词汇重叠低 */
const FABRICATED_RESPONSES: string[] = [
  "The Eiffel Tower was built in 1492 and is located in Berlin Germany.",
  "Humans only use ten percent of their brains during waking hours.",
  "Goldfish have a memory span of only three seconds total.",
  "Lightning never strikes the same place twice in nature.",
  "Sugar directly causes hyperactivity in children according to clinical trials.",
];

/** 简单分词（小写 + 字母数字序列，过滤长度<2） */
function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g);
  return tokens ? tokens.filter((t) => t.length >= 2) : [];
}

/** Jaccard 相似度（基于 token 集合） */
function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 轻量级幻觉检测：响应与事实库最大相似度低于阈值则判定为幻觉 */
function detectHallucination(
  response: string,
  facts: TestFact[],
  threshold: number
): boolean {
  const respTokens = tokenize(response);
  if (respTokens.length === 0) return true;
  let maxSim = 0;
  for (const fact of facts) {
    const sim = jaccardSimilarity(respTokens, tokenize(fact.text));
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim < threshold;
}

/**
 * 运行多用户并发幻觉检测测试。
 *
 * 支持参数：
 *   - params.facts：事实库（{text, confidence}[]，默认 DEFAULT_TEST_FACTS）
 *   - params.hallucinationRate：模拟产生幻觉响应的概率（默认 0.1）
 *   - params.similarityThreshold：幻觉判定相似度阈值（默认 0.3）
 *   - params.mockDelayMs：单次响应模拟耗时（默认 5ms）
 */
export async function runHallucinationTest(task: TestTask): Promise<TestResult> {
  const facts: TestFact[] = Array.isArray(task.params.facts)
    ? (task.params.facts as TestFact[])
    : DEFAULT_TEST_FACTS;
  const hallucinationRate =
    typeof task.params.hallucinationRate === "number"
      ? task.params.hallucinationRate
      : 0.1;
  const similarityThreshold =
    typeof task.params.similarityThreshold === "number"
      ? task.params.similarityThreshold
      : 0.3;
  const mockDelayMs =
    typeof task.params.mockDelayMs === "number" ? task.params.mockDelayMs : 5;
  // 确定性随机源：传 params.seed 时用 seeded PRNG（可复现），否则 Math.random
  const rand =
    typeof task.params.seed === "number"
      ? createSeededRng(task.params.seed)
      : Math.random;

  logger.info(
    `[hallucination] task=${task.id} concurrency=${task.concurrency} ` +
      `requestsPerUser=${task.requestsPerUser} facts=${facts.length} ` +
      `hallucinationRate=${hallucinationRate} threshold=${similarityThreshold}`
  );

  const startTime = Date.now();
  const responseTimes: number[] = [];
  let totalResponses = 0;
  let hallucinationCount = 0;
  const errors: TestError[] = [];

  const user = async (userId: number): Promise<void> => {
    for (let i = 0; i < task.requestsPerUser; i++) {
      const reqStart = Date.now();
      const fact = facts[Math.floor(rand() * facts.length)];
      const isHallucinated = rand() < hallucinationRate;
      // 模拟 LLM 响应：幻觉→编造语句；否则返回接近事实的陈述
      const response = isHallucinated
        ? FABRICATED_RESPONSES[
            Math.floor(rand() * FABRICATED_RESPONSES.length)
          ]
        : `According to verified records, ${fact.text}`;
      await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
      const responseTime = Date.now() - reqStart;
      responseTimes.push(responseTime);
      totalResponses++;

      const detected = detectHallucination(response, facts, similarityThreshold);
      if (detected) {
        hallucinationCount++;
        errors.push({
          timestamp: Date.now(),
          type: "hallucination",
          message: "Hallucination detected in response",
          context: {
            userId,
            requestIndex: i,
            response: response.slice(0, 100),
            expectedFact: fact.text.slice(0, 60),
          },
        });
      }
    }
  };

  const users: Array<Promise<void>> = [];
  for (let u = 0; u < task.concurrency; u++) {
    users.push(user(u));
  }
  await Promise.all(users);

  const durationMs = Date.now() - startTime;
  const { p50, p95, p99, avg } = calculatePercentiles(responseTimes);
  const throughput = durationMs > 0 ? (totalResponses / durationMs) * 1000 : 0;
  const hallucinationRateMeasured =
    totalResponses > 0 ? hallucinationCount / totalResponses : 0;

  logger.info(
    `[hallucination] task=${task.id} done: total=${totalResponses} ` +
      `hallucinations=${hallucinationCount} rate=${hallucinationRateMeasured.toFixed(4)}`
  );

  return {
    taskId: task.id,
    nodeId: task.assignedNodeId ?? "local",
    status: "completed",
    durationMs,
    metrics: {
      totalRequests: totalResponses,
      successCount: totalResponses - hallucinationCount,
      failureCount: hallucinationCount,
      avgResponseMs: avg,
      p50ResponseMs: p50,
      p95ResponseMs: p95,
      p99ResponseMs: p99,
      throughput,
      hallucinationCount,
      hallucinationRate: hallucinationRateMeasured,
      errorRate: hallucinationRateMeasured,
    },
    errors,
  };
}
