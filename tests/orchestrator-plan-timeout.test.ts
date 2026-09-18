/**
 * 审计 H3（2026-08-28）：orchestrator_execute_plan 计划步骤超时兜底
 *
 * 此前 step schema 无 timeout 字段，handler 构造 task 也不透传 timeout →
 * 经 MCP 执行计划的步骤默认无超时，单步挂起则 Promise.all/串行循环永久挂起。
 * 本测试锁定三件事：
 *  1. 行为级：永不 resolve 的 fake agent + 步骤 timeoutMs=50 → 计划在超时后
 *     完成且 errors 含 timeout 信息（不再永久挂起）；
 *  2. 行为级：步骤级 timeoutMs 透传为 task.timeout 且可覆盖默认值
 *     （慢 agent 300ms resolve，timeoutMs=50 → 50ms 即超时失败）；
 *  3. 静态级：schema 含 timeoutMs 字段、构造处含 DEFAULT_STEP_TIMEOUT_MS 兜底，
 *     且常量值为 120000ms（默认兜底不可行为级等待，静态锁定）。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { logger } from "../src/utils/logger.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { registerOrchestratorTools } from "../src/mcp/server/orchestrator-tools.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "../src/mcp/server/orchestrator-tools.js";
import {
  getAgentOrchestrator,
  type AgentTask,
  type AgentResult,
} from "../src/agents/orchestrator.js";

/** 慢 agent：slow 类型 300ms 后 resolve；hang 类型永不 resolve */
function fakeAgentExecute(task: AgentTask): Promise<AgentResult> {
  if (task.type === "plan-timeout-slow") {
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            taskId: task.id,
            agentId: "plan-timeout-fake",
            success: true,
            duration: 1,
          }),
        300,
      ),
    );
  }
  return new Promise(() => {}); // plan-timeout-hang: 永挂
}

describe("审计 H3: orchestrator_execute_plan 步骤超时", () => {
  let orch: ReturnType<typeof getAgentOrchestrator>;
  let savedSelfEvolve: unknown;

  beforeAll(() => {
    // 复用全局单例（与生产 handler 一致），注册 fake agent（唯一 capability，不干扰其他测试）；
    // 失败路径会触发 selfEvolve.selfImprove → 真实模型调用，测试中摘除以保持确定性。
    orch = getAgentOrchestrator();
    savedSelfEvolve = (orch as any).options.selfEvolve;
    (orch as any).options.selfEvolve = undefined;
    orch.getRegistry().register({
      id: "plan-timeout-fake",
      name: "Plan Timeout Fake",
      description: "",
      capabilities: ["plan-timeout-hang", "plan-timeout-slow"],
      execute: fakeAgentExecute,
      healthCheck: async () => true,
    });
  });

  afterAll(() => {
    orch.getRegistry().unregister("plan-timeout-fake");
    (orch as any).options.selfEvolve = savedSelfEvolve;
  });

  /** 经 orchestrator_execute_plan handler 执行计划（守卫注入 no-op，绕开模式/权限闸） */
  async function runPlan(args: Record<string, unknown>): Promise<{
    success: boolean;
    errors: string[];
    stepResults: Record<string, unknown>;
  }> {
    const registry = new ToolRegistry({ guard: async () => {} });
    registerOrchestratorTools(registry);
    const handlers = registry.buildHttpHandlers();
    return (await handlers["orchestrator_execute_plan"](args)) as never;
  }

  test("永不 resolve 的步骤在 timeoutMs 到期后超时完成，不永久挂起", async () => {
    const result = await runPlan({
      name: "hang-plan",
      mode: "dag",
      steps: [
        {
          name: "hang-step",
          taskType: "plan-timeout-hang",
          taskDescription: "never resolves",
          timeoutMs: 50,
        },
        {
          name: "downstream",
          taskType: "plan-timeout-hang",
          taskDescription: "depends on hang-step",
          dependsOn: ["hang-step"],
          timeoutMs: 50,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join("\n")).toContain("timeout");
  });

  test("步骤级 timeoutMs 透传为 task.timeout（慢 agent 300ms，50ms 即超时）", async () => {
    const result = await runPlan({
      name: "slow-plan",
      mode: "parallel",
      steps: [
        {
          name: "slow-step",
          taskType: "plan-timeout-slow",
          taskDescription: "resolves after 300ms",
          timeoutMs: 50,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.errors.join("\n")).toContain("timeout");
  });

  test("静态：schema 含 timeoutMs，构造处含 DEFAULT_STEP_TIMEOUT_MS 兜底", () => {
    expect(DEFAULT_STEP_TIMEOUT_MS).toBe(120_000);
    const source = readFileSync("src/mcp/server/orchestrator-tools.ts", "utf8");
    expect(source).toContain("timeoutMs: z.number().int().positive().optional()");
    expect(source).toContain("timeout: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS");
  });

  // 审计 M7（2026-08-28）：AgentInterface.execute 无 AbortSignal（不改签名不扩面），
  // timeout 输 race 后孤儿任务后台续跑——落定时应记录 warn 留痕（含任务名）。
  test("超时 race 后孤儿任务后台落定时记录 warn", async () => {
    const warns: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const loggerAny = logger as unknown as {
      warn: (msg: string, ctx?: Record<string, unknown>) => void;
    };
    const origWarn = loggerAny.warn;
    loggerAny.warn = (msg, ctx) => {
      warns.push({ msg, ctx });
    };
    try {
      const result = await orch.executeTask({
        id: "orphan-probe",
        type: "plan-timeout-slow", // fake agent 300ms resolve；timeout 50ms → race 超时
        description: "orphan probe",
        input: {},
        timeout: 50,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");

      // 孤儿任务约 300ms 后落定，应出现含任务名的孤儿告警
      const hit = () =>
        warns.find((w) => w.msg.includes("Orphan task") && w.ctx?.taskId === "orphan-probe");
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && !hit()) {
        await Bun.sleep(20);
      }
      expect(hit()).toBeDefined();
    } finally {
      loggerAny.warn = origWarn;
    }
  });
});
