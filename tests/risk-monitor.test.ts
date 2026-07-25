/**
 * 高危操作双层复核测试 —— 验证 src/local-llm/risk-screen.ts 与 src/agents/risk-monitor.ts
 *
 * 设计：正则硬底线（permissions.ts）之外，对灰区操作做
 *   第一层 边缘小模型初筛（low/medium/high）
 *   第二层 主模型复核（dangerous true/false）
 *   双层确认 → 强制 HITL 审批（require-approval）
 *
 * 回退语义：
 *   - 边缘层失败 → low + degraded（fail-open，不打断 agent）
 *   - 复核失败 + 边缘 high → 升级审批（fail-closed）
 *   - 复核失败 + 边缘 medium → 放行（fail-open）
 *
 * 全部通过 DI fake 测试，不访问真实端点与真实 router。
 */
import { describe, test, expect } from "bun:test";
import { screenPayloadWithEdge } from "../src/local-llm/risk-screen.js";
import { monitorToolPayload, extractPayload, type RiskMonitorDeps } from "../src/agents/risk-monitor.js";

// ─────────────────────────────────────────────────────────
// 工具：fake 客户端 / fake 复核
// ─────────────────────────────────────────────────────────

function fakeClient(impl: () => { content: string }) {
  let calls = 0;
  return {
    client: {
      generate: async () => {
        calls++;
        const r = impl();
        return { content: r.content, model: "mock", usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop" };
      },
    },
    getCalls: () => calls,
  };
}

function deps(screenRisk: "low" | "medium" | "high" | "throw", reviewDangerous: boolean | "throw" | "none") {
  let screenCalls = 0;
  let reviewCalls = 0;
  const d: RiskMonitorDeps = {
    screen: async () => {
      screenCalls++;
      if (screenRisk === "throw") throw new Error("edge down");
      return { risk: screenRisk, reason: "fake", degraded: false };
    },
    review: async () => {
      reviewCalls++;
      if (reviewDangerous === "throw") throw new Error("router down");
      return { dangerous: reviewDangerous === true, reason: "fake" };
    },
  };
  return { deps: d, counts: () => ({ screenCalls, reviewCalls }) };
}

// ─────────────────────────────────────────────────────────
// extractPayload — 负载提取
// ─────────────────────────────────────────────────────────

describe("extractPayload", () => {
  test("terminal_exec 提取 command", () => {
    expect(extractPayload("terminal_exec", { command: "rm -rf /tmp/x" }))
      .toEqual({ kind: "command", payload: "rm -rf /tmp/x" });
  });

  test("terminal_exec 兼容 script 字段", () => {
    expect(extractPayload("terminal_exec", { script: "echo hi" }))
      .toEqual({ kind: "command", payload: "echo hi" });
  });

  test("fs_delete/fs_write/fs_move 提取 path", () => {
    expect(extractPayload("fs_delete", { path: "/etc/passwd" }))
      .toEqual({ kind: "path", payload: "/etc/passwd" });
    expect(extractPayload("fs_write", { path: "/tmp/a", content: "x" }))
      .toEqual({ kind: "path", payload: "/tmp/a" });
    expect(extractPayload("fs_move", { path: "/tmp/a" }))
      .toEqual({ kind: "path", payload: "/tmp/a" });
  });

  test("只读工具与无关工具返回 null", () => {
    expect(extractPayload("fs_read", { path: "/etc/passwd" })).toBeNull();
    expect(extractPayload("web_search", { query: "rm -rf /" })).toBeNull();
    expect(extractPayload("memory_write", { content: "x" })).toBeNull();
  });

  test("缺少有效负载返回 null", () => {
    expect(extractPayload("terminal_exec", {})).toBeNull();
    expect(extractPayload("terminal_exec", { command: "   " })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// screenPayloadWithEdge — 边缘初筛
// ─────────────────────────────────────────────────────────

describe("screenPayloadWithEdge", () => {
  test("合法 JSON 返回对应风险等级", async () => {
    const { client } = fakeClient(() => ({ content: '{"risk":"high","reason":"递归删除"}' }));
    const r = await screenPayloadWithEdge("rm -rf /tmp/x", "command", client);
    expect(r.risk).toBe("high");
    expect(r.degraded).toBe(false);
  });

  test("带 code fence 的 JSON 也能解析", async () => {
    const { client } = fakeClient(() => ({ content: '```json\n{"risk":"low"}\n```' }));
    const r = await screenPayloadWithEdge("ls -la", "command", client);
    expect(r.risk).toBe("low");
    expect(r.degraded).toBe(false);
  });

  test("垃圾输出降级为 low（fail-open）", async () => {
    const { client } = fakeClient(() => ({ content: "我觉得这个命令有点危险" }));
    const r = await screenPayloadWithEdge("rm -rf /", "command", client);
    expect(r.risk).toBe("low");
    expect(r.degraded).toBe(true);
  });

  test("非法枚举值降级为 low", async () => {
    const { client } = fakeClient(() => ({ content: '{"risk":"extreme"}' }));
    const r = await screenPayloadWithEdge("x", "command", client);
    expect(r.risk).toBe("low");
    expect(r.degraded).toBe(true);
  });

  test("客户端异常降级为 low（fail-open）", async () => {
    const { client } = fakeClient(() => { throw new Error("circuit open"); });
    const r = await screenPayloadWithEdge("x", "command", client);
    expect(r.risk).toBe("low");
    expect(r.degraded).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// monitorToolPayload — 双层复核编排
// ─────────────────────────────────────────────────────────

describe("monitorToolPayload", () => {
  test("无关工具直接放行，不调用初筛", async () => {
    const { deps: d, counts } = deps("high", true);
    const v = await monitorToolPayload("web_search", { query: "x" }, d);
    expect(v).toBe("pass");
    expect(counts().screenCalls).toBe(0);
  });

  test("初筛 low 直接放行，不触发复核", async () => {
    const { deps: d, counts } = deps("low", true);
    const v = await monitorToolPayload("terminal_exec", { command: "ls -la" }, d);
    expect(v).toBe("pass");
    expect(counts().screenCalls).toBe(1);
    expect(counts().reviewCalls).toBe(0);
  });

  test("初筛 high + 复核 dangerous → 升级审批", async () => {
    const { deps: d } = deps("high", true);
    const v = await monitorToolPayload("terminal_exec", { command: "rm -rf /usr" }, d);
    expect(v).toBe("require-approval");
  });

  test("初筛 medium + 复核 dangerous → 升级审批", async () => {
    const { deps: d } = deps("medium", true);
    const v = await monitorToolPayload("terminal_exec", { command: "chmod -R 777 /var" }, d);
    expect(v).toBe("require-approval");
  });

  test("初筛 high + 复核否定 → 放行", async () => {
    const { deps: d } = deps("high", false);
    const v = await monitorToolPayload("terminal_exec", { command: "rm -rf ./node_modules" }, d);
    expect(v).toBe("pass");
  });

  test("初筛异常 → fail-open 放行，不触发复核", async () => {
    const { deps: d, counts } = deps("throw", true);
    const v = await monitorToolPayload("terminal_exec", { command: "rm -rf /usr" }, d);
    expect(v).toBe("pass");
    expect(counts().reviewCalls).toBe(0);
  });

  test("初筛 high + 复核异常 → fail-closed 升级审批", async () => {
    const { deps: d } = deps("high", "throw");
    const v = await monitorToolPayload("terminal_exec", { command: "mkfs.ext4 /dev/sda" }, d);
    expect(v).toBe("require-approval");
  });

  test("初筛 medium + 复核异常 → fail-open 放行", async () => {
    const { deps: d } = deps("medium", "throw");
    const v = await monitorToolPayload("terminal_exec", { command: "chmod 777 x" }, d);
    expect(v).toBe("pass");
  });

  test("EDGE_RISK_MONITOR=0 时完全旁路", async () => {
    process.env.EDGE_RISK_MONITOR = "0";
    try {
      const { deps: d, counts } = deps("high", true);
      const v = await monitorToolPayload("terminal_exec", { command: "rm -rf /usr" }, d);
      expect(v).toBe("pass");
      expect(counts().screenCalls).toBe(0);
    } finally {
      delete process.env.EDGE_RISK_MONITOR;
    }
  });

  test("fs_delete 高危路径也走双层流程", async () => {
    const { deps: d } = deps("high", true);
    const v = await monitorToolPayload("fs_delete", { path: "/home/user/.ssh" }, d);
    expect(v).toBe("require-approval");
  });
});
