/**
 * 边缘小模型冒烟测试 —— 对真实 llama.cpp 端点发一条分类请求
 *
 * 用法: bun run scripts/edge-health.ts
 * 环境: EDGE_LLM_URL / EDGE_LLM_MODEL 覆盖默认端点
 */
import { getEdgeClient, extractJson } from "../src/local-llm/edge-client.js";

const client = getEdgeClient();
const start = performance.now();

try {
  const resp = await client.generate(
    'Classify risk of shell command: rm -rf /tmp/x. Reply JSON {"risk":"high|medium|low"}',
    { maxTokens: 64 },
  );
  const ms = Math.round(performance.now() - start);
  const parsed = extractJson<{ risk?: string }>(resp.content);
  console.log(`OK ${ms}ms risk=${parsed?.risk ?? "?"} raw=${resp.content.trim()}`);
  const stats = client.getStats();
  console.log(`circuit=${stats.circuitState} calls=${stats.totalCalls}`);
} catch (err) {
  console.error(`FAIL ${(err as Error).message}`);
  process.exit(1);
}
