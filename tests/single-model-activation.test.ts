/**
 * 单模型接入验证 —— 只配一个 API Key（如 DEEPSEEK_API_KEY）即可激活全部操作。
 *
 * 断言：
 *   1. 注册表中每个 TaskRole 的候选/兜底链都包含 deepseek 模型（provider=deepseek）
 *      → 单一 deepseek key 即可为所有角色提供模型。
 *   2. listConfiguredProviders 只返回其 key env 已设置的 provider。
 */
import { describe, it, expect, afterAll } from "bun:test";
import type { TaskRole } from "../src/router/models/types.js";
import { findModelsForRole } from "../src/router/model-capability-registry.js";
import { listConfiguredProviders } from "../src/router/models.js";

const ROLES: TaskRole[] = [
  "decision", "architecture", "evaluation", "general-chat", "code-generation",
  "code-review", "embedding", "english", "rl", "general-tool", "coding",
  "research", "memory", "deep_research", "math", "review", "main_coding",
  "computer-use", "intent-classifier",
];

const KEY_ENVS = [
  "DEEPSEEK_API_KEY", "SILICONFLOW_API_KEY", "OFOXAI_API_KEY", "OPENROUTER_API_KEY",
  "ZHIPU_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY", "NIM_API_KEY",
  "OPENCODE_API_KEY", "OFOXAI_ANTHROPIC_API_KEY", "OFOXAI_GEMINI_API_KEY",
];

afterAll(() => {
  // 恢复用户环境
  for (const k of KEY_ENVS) {
    // 测试内只设置了 DEEPSEEK_API_KEY，恢复为删除
    delete process.env[k];
  }
});

describe("单模型接入全功能", () => {
  /** 视觉（computer-use）与嵌入（embedding）需多模态/嵌入端点，LLM key 不兜底，属例外 */
  const OPERATIONAL_EXCEPTIONS = new Set(["computer-use", "embedding"]);

  it("每个可操作角色都有 deepseek 候选模型（单 key 即可兜底）", () => {
    for (const role of ROLES) {
      if (OPERATIONAL_EXCEPTIONS.has(role)) continue;
      const models = findModelsForRole(role);
      expect(models.length, `role=${role} 应有候选模型`).toBeGreaterThan(0);
      const hasDeepseek = models.some((m) => m.provider === "deepseek");
      expect(hasDeepseek, `role=${role} 应含 deepseek 兜底模型`).toBe(true);
    }
  });

  it("视觉/嵌入角色按设计不要求 deepseek（多模态/嵌入端点另行配置）", () => {
    for (const role of ["computer-use", "embedding"] as TaskRole[]) {
      expect(findModelsForRole(role).length).toBeGreaterThan(0);
    }
  });

  it("仅配置 DEEPSEEK_API_KEY 时，listConfiguredProviders 只返回 deepseek", () => {
    for (const k of KEY_ENVS) delete process.env[k];
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const providers = listConfiguredProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) {
      // 每个返回的 provider 其 key env 都必须已设置
      expect(process.env[`${p.toUpperCase().replace(/-/g, "_")}_API_KEY`] ?? process.env[`${p.toUpperCase()}_API_KEY`])
        .toBeDefined();
    }
    expect(providers).toContain("deepseek");
  });
});


