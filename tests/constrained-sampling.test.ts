/**
 * DRE 约束采样测试（P2 收尾 S1，评估报告"过紧 TOP3"）
 *
 * 背景：temp0 + 固定种子（默认 seed=42）下采样确定，n=3 拒绝采样三票必全同，
 * 造成 3 倍成本空转，且 modeAmbiguous 分支永不触发。修复后：
 * - 生效 temperature === 0 → n 强制 1（三票同值，众数投票数学等价单票，省 2/3 成本）
 * - temp > 0 → 保持 n=3 投票（真实拒绝采样语义）
 * 同时静态断言 maxTokens 默认 2048（与 clampMaxTokens 构成双层钳制）。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LLMClient } from "../src/dre/llm/client.js";

const MOCK_RESPONSE = {
  content: '{"verdict":"accept","confidence":0.9,"chain":[],"evidence_refs":[]}',
  model: "test",
  usage: { promptTokens: 1, completionTokens: 1 },
  finishReason: "stop",
};

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { enum: ["accept", "reject"] },
    confidence: { minimum: 0, maximum: 1 },
    chain: {},
    evidence_refs: {},
  },
  required: ["verdict", "confidence", "chain", "evidence_refs"],
};

/** 替换实例 generate 记录调用次数与生效温度（公共接口注入，不发网络请求） */
function mockGenerate(client: LLMClient): { calls: number; temperatures: number[] } {
  const state = { calls: 0, temperatures: [] as number[] };
  (client as unknown as { generate: unknown }).generate = async (
    _prompt: string,
    opts?: { temperature?: number },
  ) => {
    state.calls++;
    state.temperatures.push(opts?.temperature ?? -1);
    return { ...MOCK_RESPONSE };
  };
  return state;
}

describe("generateConstrained 拒绝采样（temp0 空转修复）", () => {
  it("temp0（默认配置）→ generate 恰 1 次，结果与旧 n=3 全同票一致", async () => {
    const client = new LLMClient({ baseUrl: "http://127.0.0.1:1", model: "test" });
    const state = mockGenerate(client);

    const result = await client.generateConstrained("prompt", SCHEMA);

    expect(state.calls).toBe(1);
    expect(state.temperatures).toEqual([0]);
    // 与旧 n=3（三票必同值 → 众数即该值）结果一致
    expect(result.verdict).toBe("accept");
    expect(result.confidence).toBe(0.9);
    expect("modeAmbiguous" in result).toBe(false);
  });

  it("temp0.7 → 保持 n=3 投票，generate 收到 0.7", async () => {
    const client = new LLMClient({ baseUrl: "http://127.0.0.1:1", model: "test", temperature: 0.7 });
    const state = mockGenerate(client);

    const result = await client.generateConstrained("prompt", SCHEMA);

    expect(state.calls).toBe(3);
    expect(state.temperatures).toEqual([0.7, 0.7, 0.7]);
    expect(result.verdict).toBe("accept");
  });

  it("静态断言：maxTokens 默认 2048（512 已移除，双层钳制注释在位）", () => {
    const source = readFileSync(join(import.meta.dir, "../src/dre/llm/client.ts"), "utf8");
    expect(source).toContain("maxTokens: 2048");
    expect(source).not.toContain("maxTokens: 512");
    expect(source).toContain("clampMaxTokens");
  });
});
