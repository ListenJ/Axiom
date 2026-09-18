/**
 * 多模型协同 S4：TaskOrchestrator 审核回环（缺口 B：执行→指挥回验→修正→降级）
 *
 * 契约（计划 2026-09-10-multi-model-collaboration-survey-plan.md S4）：
 * - execute() 新增可选 opts.verify(answer) => {ok, feedback?} | boolean；
 * - 未配置 verify → verification.status='not-verified'，主链路行为零扰动；
 * - verify.ok=true → 'passed'（直出，无修正）；
 * - 首次 ok=false 带 feedback → 追加反馈重跑一次 → 再验：通过='corrected'；
 * - 二次仍 ok=false → 'degraded'（最多修正一次，绝不无限重试；结果保留但标记降级）；
 * - verify 自身抛错 → 'degraded' 且答案不丢、不触发修正重跑（校验器已挂，重跑无意义）。
 *
 * 隔离：task 走 explain→research 单角色路径（isCodeTask=false 跳过 retrieve 文件访问），
 * 每用例独立 spy + 闭包计数器 + 显式 restore，零网络零真实 LLM。
 */
import { describe, expect, it, spyOn, afterEach } from "bun:test";
import { orchestrator } from "../../src/router/task-orchestrator.js";
import { router } from "../../src/router/model-router.js";
import type { ChatMessage, SmartAssignmentResponse } from "../../src/router/model-router.js";

const TASK = "explain how the router works"; // → research 单角色，非 code 任务

/** 安装 executeWithRole spy，返回闭包计数器与收到的消息序列；afterEach 统一 restore */
function installSpy(impl: (n: number, msgs: ChatMessage[]) => SmartAssignmentResponse) {
  const state = { calls: 0, seen: [] as ChatMessage[][] };
  const spy = spyOn(router, "executeWithRole").mockImplementation(async (_role, msgs) => {
    state.calls += 1;
    state.seen.push([...msgs]);
    return impl(state.calls, msgs);
  });
  spies.push(spy);
  return state;
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

function fakeResp(content: string, role: string): SmartAssignmentResponse {
  return {
    role: role as SmartAssignmentResponse["role"],
    model: "mock-model",
    provider: "mock-provider",
    endpoint: "mock",
    content,
    usage: { total_tokens: 5 },
    latency_ms: 1,
  };
}

describe("S4 审核回环", () => {
  it("未配置 verify → status=not-verified，finalAnswer 正常，executeWithRole 仅调 1 次", async () => {
    const state = installSpy((n) => fakeResp(`answer-v${n}`, "research"));
    const r = await orchestrator.execute(TASK);
    expect(r.verification).toEqual({ status: "not-verified", attempts: 0 });
    expect(r.finalAnswer).toBe("answer-v1");
    expect(state.calls).toBe(1);
  });

  it("verify 通过 → status=passed，无修正，executeWithRole 1 次", async () => {
    const state = installSpy((n) => fakeResp(`answer-v${n}`, "research"));
    const r = await orchestrator.execute(TASK, { verify: async () => ({ ok: true }) });
    expect(r.verification).toEqual({ status: "passed", attempts: 1 });
    expect(r.finalAnswer).toBe("answer-v1");
    expect(state.calls).toBe(1);
  });

  it("首次不过带 feedback、修正后通过 → status=corrected，重跑 1 次（共 2 调用），finalAnswer 为修正版", async () => {
    const state = installSpy((n) => fakeResp(`answer-v${n}`, "research"));
    const r = await orchestrator.execute(TASK, {
      verify: async (answer) =>
        answer === "answer-v1" ? { ok: false, feedback: "补充：需提到 fallback" } : { ok: true },
    });
    expect(r.verification).toEqual({ status: "corrected", attempts: 2 });
    expect(r.finalAnswer).toBe("answer-v2");
    expect(state.calls).toBe(2);
    // 修正调用须把 feedback 作为额外 user 消息追加（末条 role=user 承载反馈）
    expect(state.seen[1]!.length).toBeGreaterThan(state.seen[0]!.length);
    expect(state.seen[1]![state.seen[1]!.length - 1]!.role).toBe("user");
  });

  it("修正消息含 feedback 文本", async () => {
    const state = installSpy((n) => fakeResp(`answer-v${n}`, "research"));
    await orchestrator.execute(TASK, {
      verify: async (answer) =>
        answer === "answer-v1" ? { ok: false, feedback: "MARKER_FEEDBACK_TEXT" } : { ok: true },
    });
    const secondMsgs = state.seen[1]!;
    expect(secondMsgs.some((m) => m.content.includes("MARKER_FEEDBACK_TEXT"))).toBe(true);
  });

  it("二次仍不过 → status=degraded，最多修正一次（共 2 调用，绝不第 3 次），finalAnswer 保留修正版", async () => {
    const state = installSpy((n) => fakeResp(`answer-v${n}`, "research"));
    const r = await orchestrator.execute(TASK, {
      verify: async () => ({ ok: false, feedback: "still wrong" }),
    });
    expect(r.verification).toEqual({ status: "degraded", attempts: 2 });
    expect(r.finalAnswer).toBe("answer-v2"); // 保留修正结果，但标记降级交调用方处置
    expect(state.calls).toBe(2); // 铁律：不第三次
  });

  it("verify 自身抛错 → fail-closed 降级（不崩主链路、不触发修正重跑，status=degraded）", async () => {
    const state = installSpy((n) => fakeResp(`answer-v${n}`, "research"));
    const r = await orchestrator.execute(TASK, {
      verify: async () => {
        throw new Error("verifier down");
      },
    });
    expect(r.verification.status).toBe("degraded");
    expect(r.finalAnswer).toBe("answer-v1"); // 主链路答案不丢
    expect(state.calls).toBe(1); // 校验器已挂，不重跑
  });
});
