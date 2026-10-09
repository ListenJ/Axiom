/**
 * ADR-014：运行时自扩展能力的安全与分域门（fail-closed）。
 *
 * 覆盖：
 *   - 外围 provider 可热加（低危/内部能力）；
 *   - 内核能力**不得自动注册**（placement="kernel-proposal" → 拒绝；只能 proposeCapability）；
 *   - 未声明副作用 → 拒绝（无声明即不可信）；
 *   - 高危能力（proc.exec/fs.write/net.outbound/...）未经授权 → 拒绝；
 *   - 高危能力即使授权，也不得 in-process 注册（须 worker/sandbox 隔离）。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  capabilityRegistry,
  CapabilityRegistrationError,
  type CapabilityProvider,
} from "../../src/dre/runtime/capability-registry.js";

const base = (over: Partial<CapabilityProvider>): CapabilityProvider => ({
  id: "dyn-1",
  name: "Dyn Provider",
  type: "external",
  capabilities: ["analysis.summarization"],
  costPerCall: 0,
  avgLatencyMs: 10,
  reliability: 0.8,
  maxConcurrency: 4,
  metadata: {},
  ...over,
});

describe("ADR-014 运行时自扩展：安全 + 分域", () => {
  beforeEach(() => capabilityRegistry.reset());

  test("外围 provider（内部副作用）可热加并被 select 命中", () => {
    capabilityRegistry.registerDynamicProvider(
      base({ placement: "periphery", isolation: "in-process", sideEffects: ["internal"], invoke: async () => ({ ok: true }) }),
    );
    const caps = capabilityRegistry.listByContract("analysis.summarization");
    expect(caps).toHaveLength(1);
    expect(caps[0].provider.source).toBe("dynamic");
    expect(capabilityRegistry.select("analysis.summarization")).not.toBeNull();
  });

  test("内核归属 provider 不得自动注册（必须走提案）", () => {
    expect(() =>
      capabilityRegistry.registerDynamicProvider(
        base({ placement: "kernel-proposal", sideEffects: ["internal"] }),
      ),
    ).toThrow(CapabilityRegistrationError);
    expect(capabilityRegistry.listByContract("analysis.summarization")).toHaveLength(0);
  });

  test("未声明 sideEffects → 拒绝（无声明即不可信）", () => {
    expect(() =>
      capabilityRegistry.registerDynamicProvider(base({ placement: "periphery" })),
    ).toThrow(/未声明 sideEffects/);
  });

  test("高危能力未授权 → 拒绝（fail-closed）", () => {
    expect(() =>
      capabilityRegistry.registerDynamicProvider(
        base({ placement: "periphery", isolation: "sandbox", sideEffects: ["net.outbound"] }),
      ),
    ).toThrow(/未获授权/);
    expect(capabilityRegistry.listByContract("analysis.summarization")).toHaveLength(0);
  });

  test("高危能力已授权但仍 in-process → 拒绝（须 worker/sandbox）", () => {
    expect(() =>
      capabilityRegistry.registerDynamicProvider(
        base({ placement: "periphery", isolation: "in-process", sideEffects: ["proc.exec"] }),
        { authorized: true },
      ),
    ).toThrow(/worker\/sandbox 隔离/);
  });

  test("高危能力已授权 + sandbox 隔离 → 允许注册", () => {
    capabilityRegistry.registerDynamicProvider(
      base({ placement: "periphery", isolation: "sandbox", sideEffects: ["net.outbound", "db.write"], sandbox: { command: "echo" } }),
      { authorized: true },
    );
    expect(capabilityRegistry.listByContract("analysis.summarization")).toHaveLength(1);
  });

  test("listContracts 实况：无 provider 时为空，注册后列出该契约", () => {
    expect(capabilityRegistry.listContracts()).toEqual([]);
    capabilityRegistry.registerDynamicProvider(
      base({ placement: "periphery", isolation: "in-process", sideEffects: ["internal"], invoke: async () => ({}) }),
    );
    expect(capabilityRegistry.listContracts()).toContain("analysis.summarization");
  });

  test("proposeCapability 只记录提案，不注册、不执行", () => {
    const p = capabilityRegistry.proposeCapability({ contract: "knowledge.retrieval", rationale: "高频缺口" });
    expect(p.id).toBeTruthy();
    expect(p.status).toBe("pending");
    expect(capabilityRegistry.listByContract("knowledge.retrieval")).toHaveLength(0); // 未注册
    expect(capabilityRegistry.listKernelProposals()).toHaveLength(1);
  });
});
