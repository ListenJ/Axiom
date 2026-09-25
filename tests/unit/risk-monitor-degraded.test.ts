/**
 * 审计 C-3 / C-4 —— 权限硬底线接线 + 双层复核降级可见性（R1 能力口径）
 *
 * 修复前：
 *   - 命令危险判据硬底线全仓零调用方（死代码；R3-B 后单源于 command-safety.ts）；
 *   - 边缘初筛降级/失败时双层复核整体旁路且无任何痕迹（双重 fail-open）。
 *
 * 修复后契约（R1 之后判据从"工具名"换成"声明能力"）：
 *   1. ToolRegistry 默认守卫在复核前执行硬底线：高危命令/敏感路径直接拒绝；
 *   2. 初筛降级时计数器递增并写审计事件；降级处置按能力分档 ——
 *      特权能力（proc.exec / fs.write / …）一律升级审批，其余由 EDGE_RISK_FAIL_CLOSED 决定；
 *   3. 只读档位（fs.read）不进概率层，因此"离线可用性"不再依赖降级放行这条路径；
 *   4. S-8（R2-D）：命令类负载不做形态猜测，声明 proc.exec 就必须声明目标入参 ——
 *      本文件的 proc.exec 夹具因此都带 `{ "proc.exec": ["command"] }`，与运行时传的 args 同名。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import {
  screenToolCall,
  resetSequences,
  getDegradedBypassCount,
  resetDegradedBypassCount,
  type RiskMonitorDeps,
} from "../../src/agents/risk-monitor.js";
import type { Capability, PayloadFields } from "../../src/utils/permissions.js";

function probe(
  capability: readonly Capability[],
  name = "hardfloor_probe",
  payloadFields?: PayloadFields,
) {
  const registry = new ToolRegistry(); // 默认守卫
  const state = { executed: false };
  registry.add({
    name,
    description: "probe",
    inputSchema: {},
    capability,
    payloadFields,
    handler: async () => {
      state.executed = true;
      return { ok: true };
    },
  });
  const wrapped = (
    registry as unknown as { tools: Array<{ handler: (a: Record<string, unknown>) => Promise<unknown> }> }
  ).tools[0];
  expect(wrapped).toBeDefined();
  return { run: (args: Record<string, unknown>) => wrapped!.handler(args), state };
}

describe("ToolRegistry 权限硬底线（C-3）", () => {
  // 概率层与初筛端点无关：本组只锁确定性硬底线，关掉概率层以免测试触达真实边缘模型
  beforeAll(() => {
    process.env.EDGE_RISK_MONITOR = "0";
  });
  afterAll(() => {
    delete process.env.EDGE_RISK_MONITOR;
  });
  beforeEach(() => resetSequences());

  test("声明 proc.exec 的工具，command 命中硬底线直接拒绝执行", async () => {
    const { run, state } = probe(["proc.exec"], "hardfloor_probe", { "proc.exec": ["command"] });
    let err: Error | null = null;
    try {
      await run({ command: "rm -rf /" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(String(err!.message)).toContain("High-risk operation detected");
    expect(state.executed).toBe(false);
  });

  test("操作类型由声明能力推导（fs.delete 声明下 path 按 delete 语义过闸）", async () => {
    const { run, state } = probe(["fs.delete"], "hardfloor_probe_delete");
    await expect(run({ path: "/etc/shadow" })).rejects.toThrow(/HardFloor/);
    expect(state.executed).toBe(false);
  });

  test("改名不影响过闸：同一 proc.exec 声明换成任意名字照样拒绝", async () => {
    const { run } = probe(["proc.exec"], "mcp_github_whatever_wrapper", { "proc.exec": ["command"] });
    await expect(run({ command: "DROP TABLE users" })).rejects.toThrow(/HardFloor/);
  });

  test("安全负载正常执行（未被守卫误伤）", async () => {
    const { run, state } = probe(["proc.exec"], "hardfloor_probe3", { "proc.exec": ["command"] });
    expect(await run({ command: "ls -la" })).toEqual({ ok: true });
    expect(state.executed).toBe(true);
  });
});

describe("风险初筛降级可见性与分档处置（C-4）", () => {
  const origFailClosed = process.env.EDGE_RISK_FAIL_CLOSED;
  const origRiskMonitor = process.env.EDGE_RISK_MONITOR;

  const degradedLow = (over: Partial<RiskMonitorDeps> = {}): RiskMonitorDeps => ({
    screen: async () => ({ risk: "low" as const, degraded: true }),
    ...over,
  });

  beforeEach(() => {
    resetDegradedBypassCount();
    delete process.env.EDGE_RISK_FAIL_CLOSED;
    // LLM 默认关闭策略（用户指令 2026-09-18）：本 describe 验证"已授权"路径
    process.env.EDGE_RISK_MONITOR = "1";
  });
  afterEach(() => {
    if (origFailClosed === undefined) delete process.env.EDGE_RISK_FAIL_CLOSED;
    else process.env.EDGE_RISK_FAIL_CLOSED = origFailClosed;
    if (origRiskMonitor === undefined) delete process.env.EDGE_RISK_MONITOR;
    else process.env.EDGE_RISK_MONITOR = origRiskMonitor;
  });

  test("降级 + 特权能力 → 升级审批并计数（审计修复：此处原为 fail-open）", async () => {
    // ⚠️ 行为变更说明（审计 A 配套修复，非测试写错）：
    // 本用例原先断言 verdict === "pass"，即 C-4 决策「降级默认 fail-open 以不阻断离线环境」。
    // 实测该默认导致注入的 terminal_exec 调用被一路放行（命令真实执行）——
    // 防护在最需要时（离线/模型不可达）恰好失效。现按能力分档，离线可用性另由只读豁免保证。
    const before = getDegradedBypassCount();
    const verdict = await screenToolCall(
      { capabilities: ["proc.exec"], args: { command: "ls" } },
      degradedLow(),
    );
    expect(verdict).toBe("require-approval");
    expect(getDegradedBypassCount()).toBe(before + 1);
  });

  test("只读档位根本不进概率层：不初筛、不计数、不受降级影响", async () => {
    let screened = 0;
    const before = getDegradedBypassCount();
    const verdict = await screenToolCall(
      { capabilities: ["fs.read"], args: { path: "x" } },
      degradedLow({
        screen: async () => {
          screened++;
          return { risk: "low" as const, degraded: true };
        },
      }),
    );
    expect(verdict).toBe("pass");
    expect(screened).toBe(0);
    expect(getDegradedBypassCount()).toBe(before);
  });

  test("非特权能力默认 fail-open，EDGE_RISK_FAIL_CLOSED=1 时一律升级", async () => {
    const globCall = { capabilities: ["fs.glob"] as const, args: { pattern: "**/*.env" } };
    expect(await screenToolCall(globCall, degradedLow())).toBe("pass");
    process.env.EDGE_RISK_FAIL_CLOSED = "1";
    expect(await screenToolCall(globCall, degradedLow())).toBe("require-approval");
  });

  test("screen 抛异常与 degraded 同源处置：两种失败方式都不能用来绕过", async () => {
    const throwing = { screen: async () => { throw new Error("edge down"); } };
    expect(await screenToolCall({ capabilities: ["proc.exec"], args: { command: "ls" } }, throwing)).toBe(
      "require-approval",
    );
    process.env.EDGE_RISK_FAIL_CLOSED = "1";
    expect(await screenToolCall({ capabilities: ["fs.glob"], args: { pattern: "*" } }, throwing)).toBe(
      "require-approval",
    );
  });

  test("非降级的正常 low 不计数", async () => {
    const before = getDegradedBypassCount();
    await screenToolCall(
      { capabilities: ["proc.exec"], args: { command: "ls" } },
      { screen: async () => ({ risk: "low" as const, degraded: false }) },
    );
    expect(getDegradedBypassCount()).toBe(before);
  });
});
