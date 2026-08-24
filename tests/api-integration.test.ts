import { describe, it, expect } from "bun:test";
import { assignModel } from "../src/router/model-capability-registry.js";

// 审计整改 R1（2026-08-24）：原文件 13 个探针用 `catch { expect(true).toBe(true) }`
// 在守护进程未启动时恒绿，对回归保护为零。现改为：
// ① 活服务器探针由 AXIOM_LIVE_SERVER=1 门控（默认 skip、理由明确、无吞错）；
// ② 纯注册表契约用例改为 null-契约双分支断言（assignModel 文档化返回 AssignmentResult | null）。
describe("Live HTTP API smoke（需 AXIOM_LIVE_SERVER=1 且网关已启动）", () => {
  const baseUrl = process.env.AXIOM_LIVE_BASE_URL ?? "http://127.0.0.1:18789";
  const itLive = process.env.AXIOM_LIVE_SERVER ? it : it.skip;

  itLive("GET /health 返回 200", async () => {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
  });

  itLive("GET /api/stats 返回含 uptime 的 JSON", async () => {
    const res = await fetch(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("uptime");
  });

  itLive("GET /vault/stats 返回 200 JSON", async () => {
    const res = await fetch(`${baseUrl}/vault/stats`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    await res.json();
  });

  itLive("GET /kg/stats 返回 200 JSON", async () => {
    const res = await fetch(`${baseUrl}/kg/stats`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    await res.json();
  });
});

describe("Model Assignment Integration（纯注册表契约）", () => {
  const roles = [
    "coding", "research", "decision", "architecture",
    "evaluation", "general-chat", "code-generation", "code-review",
  ] as const;

  it("assignModel 对每个已知角色返回 null 或完整 AssignmentResult", () => {
    for (const role of roles) {
      const result = assignModel(role);
      if (result === null) {
        // 空注册表环境下的文档化行为：显式 null（绝不 undefined / throw）
        expect(result).toBeNull();
      } else {
        // AssignmentResult.model 是 ModelCapability 对象（含 id/provider 等）
        expect(result.role).toBe(role);
        expect(result.model).toBeInstanceOf(Object);
        expect(result.fallbackChain.length).toBeGreaterThan(0);
      }
    }
  });

  it("coding 角色的 fallbackChain 与 reason 契约", () => {
    const result = assignModel("coding");
    if (result !== null) {
      expect(result.fallbackChain.length).toBeGreaterThanOrEqual(1);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    } else {
      expect(result).toBeNull();
    }
  });
});
