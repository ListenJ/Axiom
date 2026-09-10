/**
 * 审计 C-3 / C-4 / 整改 R2 Task 2.5 —— 权限硬底线接线 + 双层复核降级可见性
 *
 * 修复前：
 *   - permissions.ts 的 HIGH_RISK_PATTERNS 硬底线全仓零调用方（死代码）；
 *   - 边缘初筛降级/失败时双层复核整体旁路且无任何痕迹（双重 fail-open）。
 *
 * 修复后契约：
 *   1. ToolRegistry 默认守卫在复核前执行硬底线：高危命令/敏感路径直接拒绝；
 *   2. 初筛降级时计数器递增并写审计事件；EDGE_RISK_FAIL_CLOSED=1 时升级审批。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import {
  monitorToolPayload,
  getDegradedBypassCount,
  resetDegradedBypassCount,
} from "../../src/agents/risk-monitor.js";

describe("ToolRegistry 权限硬底线（C-3）", () => {
  test("command 字段命中 HIGH_RISK_PATTERNS 直接拒绝执行", async () => {
    const registry = new ToolRegistry(); // 默认守卫
    let executed = false;
    registry.add({
      name: "hardfloor_probe",
      description: "probe",
      inputSchema: {},
      handler: async () => {
        executed = true;
        return { ok: true };
      },
    } as any);

    const meta = registry.getToolsMeta()[0];
    const wrapped = (registry as unknown as { tools: Array<{ handler: (a: any) => Promise<unknown> }> }).tools[0];
    expect(wrapped).toBeDefined();

    let err: Error | null = null;
    try {
      await wrapped.handler({ command: "rm -rf /", _meta: meta });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(String(err!.message)).toContain("High-risk operation detected");
    expect(executed).toBe(false);
  });

  test("敏感路径删除被拒绝，普通命令放行", async () => {
    const registry = new ToolRegistry();
    registry.add({
      name: "hardfloor_probe_delete",
      description: "probe",
      inputSchema: {},
      handler: async () => ({ ok: true }),
    } as any);
    const wrapped = (registry as unknown as { tools: Array<{ handler: (a: any) => Promise<unknown> }> }).tools[0];

    // 工具名含 delete → path 字段按 delete 语义过闸
    await expect(
      wrapped.handler({ path: "/etc/shadow" }),
    ).rejects.toThrow(/HardFloor/);
  });

  test("普通负载不受影响（不触网：非监视工具名）", async () => {
    const registry = new ToolRegistry();
    registry.add({
      name: "hardfloor_probe3",
      description: "probe",
      inputSchema: {},
      handler: async () => ({ ok: true }),
    } as any);
    const wrapped = (registry as unknown as { tools: Array<{ handler: (a: any) => Promise<unknown> }> }).tools[0];
    const r = await wrapped.handler({ command: "ls -la" });
    expect(r).toEqual({ ok: true });
  });
});

describe("风险初筛降级可见性与可选 fail-closed（C-4）", () => {
  const origFailClosed = process.env.EDGE_RISK_FAIL_CLOSED;

  beforeEach(() => {
    resetDegradedBypassCount();
    delete process.env.EDGE_RISK_FAIL_CLOSED;
  });
  afterEach(() => {
    if (origFailClosed === undefined) delete process.env.EDGE_RISK_FAIL_CLOSED;
    else process.env.EDGE_RISK_FAIL_CLOSED = origFailClosed;
  });

  test("降级 low 默认仍放行，但计数器递增（可观测）", async () => {
    const before = getDegradedBypassCount();
    const verdict = await monitorToolPayload("terminal_exec", { command: "ls" }, {
      screen: async () => ({ risk: "low", degraded: true }),
    });
    expect(verdict).toBe("pass");
    expect(getDegradedBypassCount()).toBe(before + 1);
  });

  test("EDGE_RISK_FAIL_CLOSED=1 时降级即升级审批", async () => {
    process.env.EDGE_RISK_FAIL_CLOSED = "1";
    const verdict = await monitorToolPayload("terminal_exec", { command: "ls" }, {
      screen: async () => ({ risk: "low", degraded: true }),
    });
    expect(verdict).toBe("require-approval");
  });

  test("screen 抛异常在 fail-closed 下同样升级", async () => {
    process.env.EDGE_RISK_FAIL_CLOSED = "1";
    const verdict = await monitorToolPayload("terminal_exec", { command: "ls" }, {
      screen: async () => { throw new Error("edge down"); },
    });
    expect(verdict).toBe("require-approval");
  });

  test("非降级的正常 low 不计数", async () => {
    const before = getDegradedBypassCount();
    await monitorToolPayload("terminal_exec", { command: "ls" }, {
      screen: async () => ({ risk: "low", degraded: false }),
    });
    expect(getDegradedBypassCount()).toBe(before);
  });
});
