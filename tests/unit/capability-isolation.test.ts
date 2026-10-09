/**
 * ADR-014 §7-2：能力执行**按声明强制隔离**（运行时，非仅校验声明）。
 *
 * - in-process：调用 provider.invoke；
 * - worker：子进程执行（JSON stdin/stdout）；
 * - 注册/执行时"声明了隔离却缺可执行体" → 拒绝（fail-closed，不退回进程内）。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import {
  capabilityRegistry,
  CapabilityRegistrationError,
  type CapabilityProvider,
} from "../../src/dre/runtime/capability-registry.js";
import { CapabilityIsolationError } from "../../src/dre/runtime/capability-isolation.js";

const base = (over: Partial<CapabilityProvider>): CapabilityProvider => ({
  id: "iso-1",
  name: "Iso Provider",
  type: "external",
  capabilities: ["analysis.summarization"],
  costPerCall: 0,
  avgLatencyMs: 5,
  reliability: 0.9,
  maxConcurrency: 2,
  metadata: {},
  ...over,
});

describe("ADR-014 §7-2 能力隔离执行", () => {
  beforeEach(() => capabilityRegistry.reset());

  test("in-process：invokeCapability 调用 provider.invoke 并记录结果", async () => {
    capabilityRegistry.registerDynamicProvider(
      base({ placement: "periphery", isolation: "in-process", sideEffects: ["internal"], invoke: async (req) => ({ got: req.n }) }),
    );
    const out = (await capabilityRegistry.invokeCapability("analysis.summarization", { n: 7 })) as { got: number };
    expect(out.got).toBe(7);
  });

  test("worker：invokeCapability 经子进程执行（JSON 往返）", async () => {
    const worker = `.tmp/iso-echo-${process.pid}.ts`;
    fs.mkdirSync(".tmp", { recursive: true });
    fs.writeFileSync(worker, `
const chunks = [];
for await (const c of Bun.stdin.stream()) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString() || "{}");
console.log(JSON.stringify({ echo: req.value ?? null }));
`, "utf8");
    try {
      capabilityRegistry.registerDynamicProvider(
        base({ placement: "periphery", isolation: "worker", sideEffects: ["internal"], worker: { entry: worker } }),
      );
      const out = (await capabilityRegistry.invokeCapability("analysis.summarization", { value: "hello" }, { timeoutMs: 20_000 })) as { echo: string };
      expect(out.echo).toBe("hello");
    } finally {
      try { fs.rmSync(worker); } catch { /* ignore */ }
    }
  }, 30_000);

  test("注册 fail-closed：worker 缺 entry / sandbox 缺 command / in-process 缺 invoke", () => {
    expect(() =>
      capabilityRegistry.registerDynamicProvider(base({ placement: "periphery", isolation: "worker", sideEffects: ["internal"] })),
    ).toThrow(/缺 worker.entry/);
    expect(() =>
      capabilityRegistry.registerDynamicProvider(base({ placement: "periphery", isolation: "sandbox", sideEffects: ["internal"] })),
    ).toThrow(/缺 sandbox.command/);
    expect(() =>
      capabilityRegistry.registerDynamicProvider(base({ placement: "periphery", isolation: "in-process", sideEffects: ["internal"] })),
    ).toThrow(/缺 invoke/);
  });

  test("无 provider 可服务契约时 invokeCapability 拒绝", async () => {
    await expect(capabilityRegistry.invokeCapability("code.review", {})).rejects.toThrow(CapabilityRegistrationError);
  });

  test("CapabilityIsolationError 有明确类型（供调用方分类处理）", () => {
    expect(new CapabilityIsolationError("x").name).toBe("CapabilityIsolationError");
  });
});
