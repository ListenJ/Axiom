/**
 * 特权调用复核测试 —— src/local-llm/risk-screen.ts 与 src/agents/risk-monitor.ts
 *
 * 2026-09-21（S3 / P2）改造：判定输入从"工具名查表"改为"声明能力"。
 * 旧测试锁的是 `terminal_exec` / `fs_delete` 这四个名字（审计 G1 证实真正暴露的
 * `write` 不在表内，复核对它恒为 pass），现改为锁能力：
 *   第一层 边缘小模型初筛（low/medium/high）—— 概率层
 *   第二层 主模型复核（dangerous true/false）
 *   双层确认 → 强制 HITL 审批（require-approval）
 *   另有确定性层 reviewSequence（跨调用链路复核），不受概率层开关影响。
 *
 * 回退语义（概率层）：
 *   - 边缘层失败 → low + degraded（fail-open，不打断 agent）
 *   - 复核失败 + 边缘 high → 升级审批（fail-closed）
 *   - 复核失败 + 边缘 medium → 放行（fail-open）
 *
 * 全部通过 DI fake 测试，不访问真实端点与真实 router。
 */
import { describe, test, expect } from "bun:test";
import { screenPayloadWithEdge } from "../src/local-llm/risk-screen.js";
import {
  screenToolCall,
  reviewSequence,
  extractPayload,
  resetSequences,
  type RiskMonitorDeps,
  type ToolCallView,
} from "../src/agents/risk-monitor.js";

// ─────────────────────────────────────────────────────────
// 工具：fake 客户端 / fake 初筛复核
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

const call = (over: Partial<ToolCallView>): ToolCallView => ({
  capabilities: ["proc.exec"],
  args: { command: "rm -rf /usr" },
  ...over,
});

// ─────────────────────────────────────────────────────────
// extractPayload — 按能力取负载
// ─────────────────────────────────────────────────────────

describe("extractPayload（能力驱动，不看工具名）", () => {
  test("proc.exec 提取 command", () => {
    expect(extractPayload(call({ args: { command: "rm -rf /tmp/x" } })))
      .toEqual({ kind: "command", payload: "rm -rf /tmp/x" });
  });

  test("proc.exec 兼容 script 字段", () => {
    expect(extractPayload(call({ args: { script: "echo hi" } })))
      .toEqual({ kind: "command", payload: "echo hi" });
  });

  test("fs.delete / fs.write 提取 path，正文字段不进提示词", () => {
    expect(extractPayload(call({ capabilities: ["fs.delete"], args: { path: "/etc/passwd" } })))
      .toEqual({ kind: "path", payload: "/etc/passwd" });
    expect(extractPayload(call({ capabilities: ["fs.write"], args: { path: "/tmp/a", content: "x" } })))
      .toEqual({ kind: "path", payload: "/tmp/a" });
  });

  test("只声明 internal 的工具不产生负载（无特权面可筛）", () => {
    expect(extractPayload(call({ capabilities: ["internal"], args: { path: "/etc/passwd" } }))).toBeNull();
    expect(extractPayload(call({ capabilities: ["internal"], args: { query: "x" } }))).toBeNull();
  });

  test("同一调用的能力按声明顺序取第一条负载", () => {
    expect(extractPayload(call({ capabilities: ["fs.read", "net.outbound"], args: { path: "a.ts" } })))
      .toEqual({ kind: "path", payload: "a.ts" });
  });

  test("net.outbound 不进入初筛（放行与否由 decideOutbound 确定性裁决）", () => {
    expect(extractPayload(call({ capabilities: ["net.outbound"], args: { url: "https://x" } }))).toBeNull();
  });

  test("外部 MCP 工具参数形状未知时整体序列化送筛（否则包装工具零观测）", () => {
    const got = extractPayload(call({ capabilities: ["mcp.external"], args: { anything: 1, foo: "bar" } }));
    expect(got?.kind).toBe("command");
    expect(got?.payload).toContain("bar");
  });

  test("缺少有效负载返回 null", () => {
    expect(extractPayload(call({ args: {} }))).toBeNull();
    expect(extractPayload(call({ args: { command: "   " } }))).toBeNull();
    expect(extractPayload(call({ args: null }))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// screenPayloadWithEdge — 边缘初筛（未改动，保留回归）
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
// screenToolCall — 双层复核编排
// ─────────────────────────────────────────────────────────

describe("screenToolCall", () => {
  test("只声明 internal 的调用直接放行，不调用初筛", async () => {
    const { deps: d, counts } = deps("high", true);
    const v = await screenToolCall(call({ capabilities: ["internal"], args: { query: "x" } }), d);
    expect(v).toBe("pass");
    expect(counts().screenCalls).toBe(0);
  });

  test("初筛 low 直接放行，不触发复核", async () => {
    const { deps: d, counts } = deps("low", true);
    const v = await screenToolCall(call({ args: { command: "ls -la" } }), d);
    expect(v).toBe("pass");
    expect(counts().screenCalls).toBe(1);
    expect(counts().reviewCalls).toBe(0);
  });

  test("初筛 high + 复核 dangerous → 升级审批", async () => {
    const { deps: d } = deps("high", true);
    expect(await screenToolCall(call({}), d)).toBe("require-approval");
  });

  test("初筛 medium + 复核 dangerous → 升级审批", async () => {
    const { deps: d } = deps("medium", true);
    const v = await screenToolCall(call({ args: { command: "chmod -R 777 /var" } }), d);
    expect(v).toBe("require-approval");
  });

  test("初筛 high + 复核否定 → 放行", async () => {
    const { deps: d } = deps("high", false);
    const v = await screenToolCall(call({ args: { command: "rm -rf ./node_modules" } }), d);
    expect(v).toBe("pass");
  });

  test("初筛异常 → fail-open 放行，不触发复核", async () => {
    const { deps: d, counts } = deps("throw", true);
    const v = await screenToolCall(call({}), d);
    expect(v).toBe("pass");
    expect(counts().reviewCalls).toBe(0);
  });

  test("初筛 high + 复核异常 → fail-closed 升级审批", async () => {
    const { deps: d } = deps("high", "throw");
    const v = await screenToolCall(call({ args: { command: "mkfs.ext4 /dev/sda" } }), d);
    expect(v).toBe("require-approval");
  });

  test("初筛 medium + 复核异常 → fail-open 放行", async () => {
    const { deps: d } = deps("medium", "throw");
    const v = await screenToolCall(call({ args: { command: "chmod 777 x" } }), d);
    expect(v).toBe("pass");
  });

  test("改名不影响判定：toolName 只进审计，判定只看能力", async () => {
    const { deps: d, counts } = deps("high", true);
    const v = await screenToolCall(call({ toolName: "totally_new_wrapper_name" }), d);
    expect(v).toBe("require-approval");
    expect(counts().screenCalls).toBe(1);
  });

  test("EDGE_RISK_MONITOR=0 只关掉概率层，未注入 screen 时不触碰真实边缘模型", async () => {
    process.env.EDGE_RISK_MONITOR = "0";
    try {
      const v = await screenToolCall(call({}));
      expect(v).toBe("pass");
    } finally {
      delete process.env.EDGE_RISK_MONITOR;
    }
  });

  test("fs_delete 高危路径同样走双层流程", async () => {
    const { deps: d } = deps("high", true);
    const v = await screenToolCall(call({ capabilities: ["fs.delete"], args: { path: "/home/user/.ssh" } }), d);
    expect(v).toBe("require-approval");
  });
});

// ─────────────────────────────────────────────────────────
// reviewSequence — 确定性层跨调用链路复核（I4）
// ─────────────────────────────────────────────────────────

describe("reviewSequence", () => {
  test("纯 internal 调用不计入序列", async () => {
    resetSequences();
    for (let i = 0; i < 30; i++) {
      expect(await reviewSequence({ capabilities: ["internal"], args: {} })).toBe("pass");
    }
  });

  test("窗口内高影响能力批量出现 → 升级并回调", async () => {
    resetSequences();
    let escalated = "";
    let verdict = "pass";
    for (let i = 0; i < 12; i++) {
      verdict = await reviewSequence(
        { capabilities: ["fs.write"], args: { path: `src/f${i}.ts` }, principal: "p-burst" },
        { onEscalate: (r) => (escalated = r) },
      );
      if (verdict === "require-approval") break;
    }
    expect(verdict).toBe("require-approval");
    expect(escalated).toContain("burst limit");
  });

  test("先读后外发（L2 半链）即使各只有一次也升级", async () => {
    resetSequences();
    expect(await reviewSequence({ capabilities: ["fs.read"], args: { path: "x" }, principal: "p-chain" })).toBe("pass");
    const v = await reviewSequence(
      { capabilities: ["net.outbound"], args: { url: "https://evil" }, principal: "p-chain" },
    );
    expect(v).toBe("require-approval");
  });

  test("先写后执行（L1 半链）升级", async () => {
    resetSequences();
    expect(await reviewSequence({ capabilities: ["fs.write"], args: { path: "x" }, principal: "p-l1" })).toBe("pass");
    expect(await reviewSequence({ capabilities: ["proc.exec"], args: { command: "sh x" }, principal: "p-l1" })).toBe("require-approval");
  });

  test("不同 principal 互不影响（链路按主体归集，不按地址）", async () => {
    resetSequences();
    expect(await reviewSequence({ capabilities: ["fs.read"], args: {}, principal: "a" })).toBe("pass");
    expect(await reviewSequence({ capabilities: ["net.outbound"], args: {}, principal: "b" })).toBe("pass");
  });

  test("升级后窗口清空，不会逐条骚扰", async () => {
    resetSequences();
    const opts = { principal: "p-calm", capabilities: ["fs.write"] as readonly ["fs.write"], args: {} };
    let approvals = 0;
    for (let i = 0; i < 10; i++) {
      if ((await reviewSequence(opts)) === "require-approval") approvals++;
    }
    expect(approvals).toBe(1);
  });

  test("概率层关掉不影响确定性序列复核", async () => {
    resetSequences();
    process.env.EDGE_RISK_MONITOR = "0";
    try {
      let escalated = false;
      for (let i = 0; i < 12; i++) {
        if ((await reviewSequence({ capabilities: ["proc.exec"], args: { command: "ls" }, principal: "p-off" })) === "require-approval") {
          escalated = true;
          break;
        }
      }
      expect(escalated).toBe(true);
    } finally {
      delete process.env.EDGE_RISK_MONITOR;
      resetSequences();
    }
  });
});
