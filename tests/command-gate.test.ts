/**
 * R-024 交互终端审批门（CommandGate）测试
 *
 * 覆盖：
 *  - off 模式直接放行（默认，向后兼容）
 *  - risky 模式：危险命令触发审批（risk=destructive）；拒绝 → Ctrl-C + denied 提示；安全命令直接放行
 *  - strict 模式：任意非空命令触发审批（危险命令 risk=destructive，其余 unknown）；空行放行
 *  - 行缓冲语义：字符逐个 ingest 不触发审批，回车才整行判定（xterm 逐键转发场景）
 *  - 审批期间后续行缓冲（有界），当前行结算后按序处理；期间键入的部分字符结算后冲刷
 *  - 无审批 handler 时 fail-closed 自动拒绝
 */
import { describe, expect, it } from "bun:test";
import { ApprovalBridge } from "../src/utils/approval-bridge.js";
import { CommandGate, parseApprovalMode, PTY_APPROVAL_MODE_ENV } from "../src/terminal/command-gate.js";
import type { PtySession } from "../src/terminal/pty-session.js";

const MODE = PTY_APPROVAL_MODE_ENV;

class FakeSession implements PtySession {
  id = "fake-pty-1";
  readonly exited: Promise<number> = new Promise(() => {});
  written = "";
  notified = "";
  write(input: string): void {
    this.written += input;
  }
  notify(chunk: string): void {
    this.notified += chunk;
  }
  subscribe(): () => void {
    return () => {};
  }
  close(): void {}
}

interface ApprovalCall {
  tool: string;
  args: unknown;
  risk?: string;
}

function makeBridge(decisions: boolean[] = [true]): {
  calls: ApprovalCall[];
  request: (tool: string, args: unknown, opts?: { risk?: string }) => Promise<boolean>;
} {
  const calls: ApprovalCall[] = [];
  let i = 0;
  return {
    calls,
    request: async (tool, args, opts) => {
      calls.push({ tool, args, risk: opts?.risk });
      return decisions[Math.min(i++, decisions.length - 1)]!;
    },
  };
}

function deferredBridge(): {
  bridge: { calls: ApprovalCall[]; request: (tool: string, args: unknown, opts?: { risk?: string }) => Promise<boolean> };
  calls: ApprovalCall[];
  resolvers: Array<(v: boolean) => void>;
} {
  const resolvers: Array<(v: boolean) => void> = [];
  const calls: ApprovalCall[] = [];
  return {
    calls,
    resolvers,
    bridge: {
      calls,
      request: (tool, args, opts) =>
        new Promise<boolean>((res) => {
          calls.push({ tool, args, risk: opts?.risk });
          resolvers.push(res);
        }),
    },
  };
}

describe("CommandGate 模式解析", () => {
  it("未设置/off=放行；risky/strict 生效；未知值 fail-closed 按 strict", () => {
    expect(parseApprovalMode("")).toBe("off");
    expect(parseApprovalMode("off")).toBe("off");
    expect(parseApprovalMode("risky")).toBe("risky");
    expect(parseApprovalMode("strict")).toBe("strict");
    expect(parseApprovalMode("STRICT")).toBe("strict");
    expect(parseApprovalMode("bogus")).toBe("strict");
  });
});

describe("CommandGate 审批行为", () => {
  it("off 模式（默认）：命令直接透传，不触发审批", async () => {
    const session = new FakeSession();
    const bridge = makeBridge();
    const gate = new CommandGate(session, { bridge });
    await gate.write("echo hi\r");
    expect(session.written).toBe("echo hi\r");
    expect(bridge.calls.length).toBe(0);
  });

  it("risky 模式：危险命令触发审批（risk=destructive），拒绝时 Ctrl-C + denied 提示", async () => {
    process.env[MODE] = "risky";
    try {
      const session = new FakeSession();
      const bridge = makeBridge([false]);
      const gate = new CommandGate(session, { bridge });
      await gate.write("rm -rf /\r");
      expect(bridge.calls.length).toBe(1);
      expect(bridge.calls[0]!.tool).toBe("pty_terminal_input");
      expect(bridge.calls[0]!.args).toEqual({ command: "rm -rf /" });
      expect(bridge.calls[0]!.risk).toBe("destructive");
      expect(session.written).toContain("rm -rf /");
      expect(session.written).toContain("\x03");
      expect(session.written).not.toContain("\r");
      expect(session.notified).toContain("blocked by approval");
    } finally {
      delete process.env[MODE];
    }
  });

  it("risky 模式：安全命令直接放行", async () => {
    process.env[MODE] = "risky";
    try {
      const session = new FakeSession();
      const bridge = makeBridge();
      const gate = new CommandGate(session, { bridge });
      await gate.write("echo hi\r");
      expect(bridge.calls.length).toBe(0);
      expect(session.written).toBe("echo hi\r");
    } finally {
      delete process.env[MODE];
    }
  });

  it("risky 模式：审批通过后写入回车执行", async () => {
    process.env[MODE] = "risky";
    try {
      const session = new FakeSession();
      const bridge = makeBridge([true]);
      const gate = new CommandGate(session, { bridge });
      await gate.write("rm -rf /tmp/x\r");
      expect(bridge.calls.length).toBe(1);
      expect(session.written).toBe("rm -rf /tmp/x\r");
      expect(session.notified).toBe("");
    } finally {
      delete process.env[MODE];
    }
  });

  it("strict 模式：任意非空命令触发审批；空行放行；危险命令 risk=destructive", async () => {
    process.env[MODE] = "strict";
    try {
      const session = new FakeSession();
      const bridge = makeBridge([true, false]);
      const gate = new CommandGate(session, { bridge });
      await gate.write("echo hi\r");
      expect(bridge.calls.length).toBe(1);
      expect(bridge.calls[0]!.risk).toBe("unknown");
      await gate.write("\r");
      expect(bridge.calls.length).toBe(1); // 空行不触发
      expect(session.written).toBe("echo hi\r\r");
      await gate.write("rm -rf /\r");
      expect(bridge.calls.length).toBe(2);
      expect(bridge.calls[1]!.risk).toBe("destructive");
    } finally {
      delete process.env[MODE];
    }
  });

  it("行缓冲：字符逐个 ingest 不触发审批，回车才整行判定", async () => {
    process.env[MODE] = "strict";
    try {
      const session = new FakeSession();
      const bridge = makeBridge([true]);
      const gate = new CommandGate(session, { bridge });
      for (const ch of "echo a") {
        await gate.write(ch);
      }
      expect(bridge.calls.length).toBe(0);
      await gate.write("\r");
      expect(bridge.calls.length).toBe(1);
      expect(bridge.calls[0]!.args).toEqual({ command: "echo a" });
      expect(session.written).toBe("echo a\r");
    } finally {
      delete process.env[MODE];
    }
  });

  it("审批期间后续行缓冲，当前行结算后按序处理；期间键入的部分字符结算后冲刷", async () => {
    process.env[MODE] = "strict";
    try {
      const session = new FakeSession();
      const { bridge, resolvers } = deferredBridge();
      const gate = new CommandGate(session, { bridge });
      const p1 = gate.write("rm -rf /\r");
      const p2 = gate.write("echo ok\r");
      await gate.write("z"); // 审批期间的部分字符
      await Promise.resolve();
      await Promise.resolve();
      expect(resolvers.length).toBe(1); // 后续行被缓冲，未触发第二次审批
      expect(bridge.calls[0]!.args).toEqual({ command: "rm -rf /" });
      resolvers[0]!(false); // 拒绝 rm
      await p1;
      await Promise.resolve();
      await Promise.resolve();
      expect(resolvers.length).toBe(2); // 缓冲的 echo ok 按序审批
      expect(bridge.calls[1]!.args).toEqual({ command: "echo ok" });
      resolvers[1]!(true); // 批准 echo ok
      await p2;
      expect(session.written).toContain("\x03"); // 第一行被拒绝
      expect(session.written).toContain("echo ok\r"); // 第二行审批通过后执行
      expect(session.written).toContain("z"); // 审批期间键入的部分字符被冲刷
    } finally {
      delete process.env[MODE];
    }
  });

  it("无审批 handler：fail-closed 自动拒绝", async () => {
    process.env[MODE] = "risky";
    try {
      const session = new FakeSession();
      const bridge = new ApprovalBridge(); // 无 handler → 1s 自动拒绝
      const gate = new CommandGate(session, { bridge });
      const start = Date.now();
      await gate.write("rm -rf /\r");
      expect(Date.now() - start).toBeGreaterThanOrEqual(900);
      expect(session.written).toContain("\x03");
      expect(session.notified).toContain("blocked by approval");
    } finally {
      delete process.env[MODE];
    }
  });

  it("有界队列：积压超过上限时丢弃并提示", async () => {
    process.env[MODE] = "strict";
    try {
      const session = new FakeSession();
      const { bridge, resolvers } = deferredBridge();
      const gate = new CommandGate(session, { bridge, maxQueue: 2 });
      const p1 = gate.write("a\r");
      gate.write("b\r");
      await gate.write("c\r");
      await gate.write("d\r");
      await Promise.resolve();
      await Promise.resolve();
      expect(session.notified).toContain("queue is full");
      expect(resolvers.length).toBe(1); // 只有 a 进入审批，b 缓冲
      resolvers[0]!(true);
      await p1;
    } finally {
      delete process.env[MODE];
    }
  });
});
