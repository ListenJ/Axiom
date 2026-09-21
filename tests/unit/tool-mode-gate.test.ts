/**
 * 审计整改 O1 —— 执行模式门控接线 + 权限硬底线键名扩展
 *
 * 契约（主控裁决）：
 *   1. Plan 封禁无条件生效：defaultToolGuard 在硬底线之前插入模式检查，
 *      plan 模式下 blockedTools/破坏性/未分类工具直接拒绝；
 *   2. YOLO 直通；Agent 默认模式保持现行为（不强制审批），
 *      强制审批仅在 env AXIOM_ENFORCE_MODE_APPROVAL=1 时经 approval-bridge 启用；
 *   3. 硬底线键名正则扩为 ^(path|file|filePath|target|destination|source|from|to|repoPath|cwd|dir)$。
 *
 * 两条轨道各管一件事（R1 之后的口径）：模式门按 `TOOL_CLASSIFICATIONS` 的**名字**分类
 * （plan 黑名单是产品语义，改名只是换个黑名单项）；硬底线的**操作类型**只由注册处声明的
 * capability 推导（fs.delete/fs.write/…），字段名只决定"扫哪些入参"。因此下面的探针工具
 * 既要用分类表里的名字，也必须如实声明能力 —— 无声明在 add() 即抛（I1）。
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import { executionMode } from "../../src/agents/execution-mode.js";
import {
  ApprovalBridge,
  setApprovalBridge,
  type ApprovalRequest,
} from "../../src/utils/approval-bridge.js";
import type { Capability } from "../../src/utils/permissions.js";

// 本文件锁的是确定性两层（模式门 + 硬底线）。概率层默认开着会真去连边缘端点，而端点
// 不可达时按审计 C-4 口径「降级 + 特权能力 ⇒ 强制审批」，判定会随环境网络状态漂移。
// 这里关掉概率层（它不影响任何确定性强制），自身口径由 tests/risk-monitor.test.ts 与
// tests/unit/risk-monitor-degraded.test.ts 用 DI fake 锁定。
beforeAll(() => {
  process.env.EDGE_RISK_MONITOR = "0";
});
afterAll(() => {
  delete process.env.EDGE_RISK_MONITOR;
});

/** 构建挂默认守卫的 registry，返回被包裹的 handler 与执行探针 */
function makeProbe(name: string, capability: readonly Capability[]) {
  const registry = new ToolRegistry(); // 默认守卫
  let executed = false;
  registry.add({
    name,
    description: "probe",
    inputSchema: {},
    capability,
    handler: async () => {
      executed = true;
      return { ok: true };
    },
  });
  const wrapped = (
    registry as unknown as { tools: Array<{ handler: (a: Record<string, unknown>) => Promise<unknown> }> }
  ).tools[0];
  return { wrapped, wasExecuted: () => executed };
}

describe("O1a: Plan 封禁无条件生效", () => {
  afterEach(() => executionMode.setMode("agent"));

  test("plan 模式下 fs_write 被阻断且不执行", async () => {
    executionMode.setMode("plan");
    const { wrapped, wasExecuted } = makeProbe("fs_write", ["fs.write"]);
    await expect(wrapped.handler({ path: "D:/tmp/x.txt" })).rejects.toThrow(/ModeGate/);
    expect(wasExecuted()).toBe(false);
  });

  test("plan 模式下只读工具正常放行", async () => {
    executionMode.setMode("plan");
    const { wrapped, wasExecuted } = makeProbe("fs_read", ["fs.read"]);
    const r = await wrapped.handler({ path: "D:/tmp/ok.txt" });
    expect(r).toEqual({ ok: true });
    expect(wasExecuted()).toBe(true);
  });
});

describe("O1b: Agent/YOLO 审批门控（AXIOM_ENFORCE_MODE_APPROVAL=1）", () => {
  const origEnv = process.env.AXIOM_ENFORCE_MODE_APPROVAL;

  afterEach(() => {
    executionMode.setMode("agent");
    if (origEnv === undefined) delete process.env.AXIOM_ENFORCE_MODE_APPROVAL;
    else process.env.AXIOM_ENFORCE_MODE_APPROVAL = origEnv;
    setApprovalBridge(new ApprovalBridge());
  });

  function injectDenyingBridge(requests: ApprovalRequest[]) {
    const fake = {
      request: async (tool: string, args: unknown, opts?: unknown) => {
        requests.push({ id: "fake", tool, args, risk: (opts as { risk?: ApprovalRequest["risk"] })?.risk ?? "unknown", requestedAt: Date.now(), timeoutMs: 0 });
        return false;
      },
      denyAll: () => 0,
    };
    setApprovalBridge(fake as unknown as ApprovalBridge);
  }

  test("agent + env=1 + bridge 拒绝 → destructive 工具被阻断，bridge 被调用", async () => {
    process.env.AXIOM_ENFORCE_MODE_APPROVAL = "1";
    const requests: ApprovalRequest[] = [];
    injectDenyingBridge(requests);
    const { wrapped, wasExecuted } = makeProbe("fs_delete", ["fs.delete"]);
    await expect(wrapped.handler({})).rejects.toThrow(/approval denied/i);
    expect(wasExecuted()).toBe(false);
    expect(requests.length).toBe(1);
    expect(requests[0].tool).toBe("fs_delete");
  });

  test("agent 无 env → 保持现行为：不调审批直接执行", async () => {
    delete process.env.AXIOM_ENFORCE_MODE_APPROVAL;
    const requests: ApprovalRequest[] = [];
    injectDenyingBridge(requests);
    const { wrapped, wasExecuted } = makeProbe("fs_delete", ["fs.delete"]);
    const r = await wrapped.handler({});
    expect(r).toEqual({ ok: true });
    expect(wasExecuted()).toBe(true);
    expect(requests.length).toBe(0);
  });

  test("yolo + env=1 → 直通执行，bridge 不被调用", async () => {
    process.env.AXIOM_ENFORCE_MODE_APPROVAL = "1";
    executionMode.setMode("yolo");
    const requests: ApprovalRequest[] = [];
    injectDenyingBridge(requests);
    const { wrapped, wasExecuted } = makeProbe("fs_delete", ["fs.delete"]);
    const r = await wrapped.handler({});
    expect(r).toEqual({ ok: true });
    expect(wasExecuted()).toBe(true);
    expect(requests.length).toBe(0);
  });
});

describe("O1c: 权限硬底线键名扩展", () => {
  afterEach(() => executionMode.setMode("agent"));

  test.each(["filePath", "repoPath", "cwd", "dir"] as const)(
    "delete 语义工具的 %s 字段命中敏感路径被拒",
    async (key) => {
      executionMode.setMode("agent");
      const { wrapped, wasExecuted } = makeProbe(`hardfloor_probe_${key}_delete`, ["fs.delete"]);
      await expect(
        wrapped.handler({ [key]: "/etc/shadow" } as Record<string, string>),
      ).rejects.toThrow(/HardFloor/);
      expect(wasExecuted()).toBe(false);
    },
  );

  test("扩展键名普通值不受影响", async () => {
    executionMode.setMode("agent");
    const { wrapped, wasExecuted } = makeProbe("hardfloor_probe_ok_delete", ["fs.delete"]);
    const r = await wrapped.handler({ filePath: "D:/workspace/normal.txt" });
    expect(r).toEqual({ ok: true });
    expect(wasExecuted()).toBe(true);
  });
});
