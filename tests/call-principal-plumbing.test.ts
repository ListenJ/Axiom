/**
 * R3-③ 序列复核的主体接线（I4 的身份维度）
 *
 * 跨调用序列复核按主体分桶（`reviewSequence` 的键是 principal），而
 * `defaultToolGuard` 在**注册期**就被包进 handler，此前从未把主体交给它
 * （构造的 call 里没有 principal 字段）⇒ 全部调用落进同一个 `"unassigned"` 桶。
 * 后果有两个方向，都必须锁住：
 *   - 误读：审计里"谁串起了这条链"完全丢失，链路取证只剩一个常量；
 *   - 反向风险：接线做反会让不同调用方各算各的，于是"换个凭证就重开一条链"
 *     成为绕过路径 —— 所以同时锁住"未标注主体时仍共桶"（fail-closed）。
 *
 * 分工：`reviewSequence` 内部的配对/计数逻辑由 tests/risk-monitor.test.ts 与 S-7 锁；
 * 本文件只测**主体是否真的从调用上下文流到守卫**这条管道。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ANONYMOUS_PRINCIPAL,
  UNATTRIBUTED_PRINCIPAL,
  credentialPrincipal,
  currentCallPrincipal,
  runAsCallPrincipal,
} from "../src/utils/call-context.js";

// 概率层关掉：本文件只测确定性层的管道，不让初筛的模型调用参与结论
process.env.EDGE_RISK_MONITOR = "0";

const repoRoot = path.join(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

function walkTs(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walkTs(rel));
    else if (ent.name.endsWith(".ts")) out.push(rel);
  }
  return out.sort();
}

const makeRegistry = async () => {
  const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
  return new ToolRegistry(); // 默认守卫：与生产同一分层
};

/** 链路前段：写一个沙箱内的普通文件（能力 fs.write） */
const registerWriteProbe = (registry: Awaited<ReturnType<typeof makeRegistry>>, name: string) => {
  let executed = false;
  registry.add({
    name,
    description: "probe",
    capability: ["fs.write"],
    inputSchema: { path: { type: "string" }, content: { type: "string" } },
    handler: async () => {
      executed = true;
      return { ok: true };
    },
  } as never);
  return { ran: () => executed };
};

/** 链路后段：执行一条无害命令（能力 proc.exec）—— 单看这一次调用永远合规 */
const registerExecProbe = (registry: Awaited<ReturnType<typeof makeRegistry>>, name: string) => {
  let executed = false;
  registry.add({
    name,
    description: "probe",
    capability: ["proc.exec"],
    payloadFields: { "proc.exec": ["command"] },
    inputSchema: { command: { type: "string" } },
    handler: async () => {
      executed = true;
      return { ok: true };
    },
  } as never);
  return { ran: () => executed };
};

const WRITE_ARGS = { path: ".tmp/r3c/out.txt", content: "x" };
const EXEC_ARGS = { command: "echo ok" };

describe("R3-③ 工具守卫把当次调用的主体交给序列复核", () => {
  beforeEach(async () => {
    const { resetSequences } = await import("../src/agents/risk-monitor.js");
    resetSequences();
  });

  afterEach(async () => {
    const { resetSequences } = await import("../src/agents/risk-monitor.js");
    resetSequences();
  });

  test("同一主体的 write→exec 被升级并阻止执行", async () => {
    const registry = await makeRegistry();
    const write = registerWriteProbe(registry, "r3c_a_write");
    const exec = registerExecProbe(registry, "r3c_a_exec");
    await runAsCallPrincipal("r3c-caller-A", async () => {
      expect(await registry.execute("r3c_a_write", WRITE_ARGS)).toEqual({ ok: true });
      expect(write.ran()).toBe(true);
      await expect(registry.execute("r3c_a_exec", EXEC_ARGS)).rejects.toThrow(/复核判定为高危操作/);
      expect(exec.ran()).toBe(false);
    });
  });

  test("不同主体不得共用同一个序列窗口（换凭证不是续链）", async () => {
    const registry = await makeRegistry();
    const write = registerWriteProbe(registry, "r3c_b_write");
    const exec = registerExecProbe(registry, "r3c_b_exec");
    await runAsCallPrincipal("r3c-caller-B1", () => registry.execute("r3c_b_write", WRITE_ARGS));
    await runAsCallPrincipal("r3c-caller-B2", () => registry.execute("r3c_b_exec", EXEC_ARGS));
    expect(write.ran()).toBe(true);
    expect(exec.ran()).toBe(true);
  });

  test("未标注主体时仍然共桶：缺身份不得等于免序列", async () => {
    const registry = await makeRegistry();
    registerWriteProbe(registry, "r3c_c_write");
    const exec = registerExecProbe(registry, "r3c_c_exec");
    await registry.execute("r3c_c_write", WRITE_ARGS);
    await expect(registry.execute("r3c_c_exec", EXEC_ARGS)).rejects.toThrow(/复核判定为高危操作/);
    expect(exec.ran()).toBe(false);
  });

  test("升级留痕带主体：审计要能回答是谁串起了这条链", async () => {
    const { auditLogger } = await import("../src/utils/audit-logger.js");
    const real = auditLogger.log.bind(auditLogger);
    const seen: Array<{ event: string; reason?: string; metadata?: { payload?: string } }> = [];
    auditLogger.log = ((entry: { event: string; reason?: string; metadata?: { payload?: string } }) => {
      seen.push(entry);
    }) as typeof auditLogger.log;
    const registry = await makeRegistry();
    registerWriteProbe(registry, "r3c_d_write");
    registerExecProbe(registry, "r3c_d_exec");
    try {
      await runAsCallPrincipal("r3c-caller-D", async () => {
        await registry.execute("r3c_d_write", WRITE_ARGS);
        await expect(registry.execute("r3c_d_exec", EXEC_ARGS)).rejects.toThrow(/复核判定为高危操作/);
      });
    } finally {
      auditLogger.log = real;
    }
    const alerts = seen.filter((e) => e.event === "security.alert");
    expect(alerts.length).toBeGreaterThan(0);
    // 主体落在 payload（"谁 → 本轮观察到的能力"），命中原因落在 reason
    expect(alerts.map((e) => e.metadata?.payload).join("\n")).toContain("r3c-caller-D → [proc.exec]");
    expect(alerts.map((e) => e.reason).join("\n")).toContain("write-then-execute");
  });
});

describe("R3-③ 传输边界必须供给主体（HTTP 路由）", () => {
  const makeCtxWithReq = (method: string, p: string, headers: Record<string, string> = {}) => {
    const req = new Request(`http://r3c.test${p}`, { method, headers });
    const ctx = {
      url: new URL(`http://r3c.test${p}`),
      req,
      vault: null,
      db: null as never,
      pipeline: null as never,
      healthMonitor: null as never,
      fileWatcher: null,
      startupTime: Date.now(),
      baseHeaders: {},
      jsonResponse: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as never;
    return { ctx, req };
  };

  test("handler 在调用方主体上下文内执行（跨 await 仍不丢）", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter();
    let seen: string | null = "never-called";
    router.register({
      method: "GET",
      path: "/probe/principal",
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        seen = currentCallPrincipal();
        return new Response("ok");
      },
    });
    const { ctx, req } = makeCtxWithReq("GET", "/probe/principal", { authorization: "Bearer r3c-token-A" });
    await router.execute(ctx);
    expect(seen).toMatch(/^cred:[0-9a-f]{16}$/);
    // 与缓存键共用同一份派生（S-4 / I3 与 I4 不得各写一份身份口径）
    expect(seen).toBe(credentialPrincipal(req.headers));
  });

  test("不同凭证落到不同主体桶", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter();
    const seen: string[] = [];
    router.register({
      method: "GET",
      path: "/probe/pairs",
      handler: async () => {
        seen.push(currentCallPrincipal() ?? "null");
        return new Response("ok");
      },
    });
    await router.execute(makeCtxWithReq("GET", "/probe/pairs", { "x-api-key": "r3c-token-1" }).ctx);
    await router.execute(makeCtxWithReq("GET", "/probe/pairs", { "x-api-key": "r3c-token-2" }).ctx);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every((p) => /^cred:[0-9a-f]{16}$/.test(p))).toBeTrue();
  });

  test("无凭证的路由调用归入 anonymous，而不是未标注", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter();
    let seen: string | null = "never-called";
    router.register({
      method: "GET",
      path: "/probe/anonymous",
      handler: async () => {
        seen = currentCallPrincipal();
        return new Response("ok");
      },
    });
    await router.execute(makeCtxWithReq("GET", "/probe/anonymous").ctx);
    expect(seen).toBe(ANONYMOUS_PRINCIPAL);
  });
});

describe("R3-③ 主体口径单源", () => {
  test("序列复核的缺省桶名由上下文层供给，不再写第二份字面量", () => {
    const lines = read("src/agents/risk-monitor.ts").split("\n");
    const hardcoded = lines.filter((line) => /\?\?\s*["']unassigned["']/.test(line));
    expect(hardcoded.map((line) => line.trim())).toEqual([]);
    expect(lines.some((line) => line.includes("UNATTRIBUTED_PRINCIPAL"))).toBeTrue();
  });

  test("凭证→主体的派生只有一个定义点（缓存分桶与序列复核共用）", () => {
    const defs = walkTs("src").filter((rel) => /export function credentialPrincipal\b/.test(read(rel)));
    expect(defs).toEqual(["src/utils/call-context.ts"]);
    // 两处消费者不得再自己算一遍摘要：各算一份就会漂成两套"谁"
    for (const rel of ["src/core/http-router.ts", "src/mcp/server.ts"]) {
      const text = read(rel);
      expect(text).toContain("credentialPrincipal(");
      expect(/createHash\((["'])sha256\1\)/.test(text)).toBeFalse();
    }
  });
});
