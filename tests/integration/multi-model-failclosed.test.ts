/**
 * 多模型协同 S5：端到端 fail-closed 铁律（对齐 S-A8 切片 7）
 *
 * 契约（计划 2026-09-10-multi-model-collaboration-survey-plan.md S5）：
 * 真实 fake router（单一 executeWithRole spy 同时承接任务执行/交叉验证/仲裁三类调用）
 * 串联 TaskOrchestrator.execute（S4 审核回环）← verify 适配 ← CrossValidator（S1 聚合/S2 分发/S3 仲裁）。
 *
 * 验收：
 * 1. 正常结论 → 共识 AGREE → passed（放行）；
 * 2. 幻觉注入 → 共识 DISAGREE → 修正一轮仍不过 → degraded（拦截，绝不静默放行）；
 * 3. 协调器全角色异常 → abstain → insufficient → 未决 → degraded，且 logger.warn 告警；
 * 4. 平票 + 仲裁弃权 → 未决 → degraded（S3 接缝端到端）。
 *
 * 铁律总断言：任何场景下幻觉/未决结论都不得产生 status='passed'。
 * 隔离：explain 任务走 research 单角色（非 code 任务，跳过 retrieve 文件访问）；零网络零真实 LLM。
 */
import { describe, expect, it, spyOn, afterEach } from "bun:test";
import { orchestrator } from "../../src/router/task-orchestrator.js";
import { router, type ChatMessage, type SmartAssignmentResponse } from "../../src/router/model-router.js";
import {
  CrossValidator,
  parseVoteVerdict,
  type VoteDispatch,
  type VerificationVote,
} from "../../src/agents/cross-validator.js";
import { logger } from "../../src/utils/logger.js";
import type { TaskRole } from "../../src/router/models/types.js";

const TASK = "explain why the sky is blue"; // → research 单角色，非 code 任务
const VOTE_ROLES: readonly TaskRole[] = ["research", "review"];

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

function resp(content: string | null, model: string, role: string): SmartAssignmentResponse {
  return {
    role: role as SmartAssignmentResponse["role"],
    model,
    provider: "mock",
    endpoint: "mock",
    content,
    usage: { total_tokens: 5 },
    latency_ms: 1,
  };
}

interface Scenario {
  /** 任务答案生成器（n=第几次答案调用） */
  answer: (n: number) => string;
  /** 票面序列（按验证调用次序循环取值；Error=该角色分发异常） */
  votes: Array<string | Error>;
  /** 仲裁票面（缺省=不会被调用到；Error=仲裁异常） */
  arbitration?: string | Error;
}

/**
 * 安装 fake router：按消息特征路由三类调用。
 * 票面 system 含「事实核查员」（voteMessages 固定前缀）、仲裁含「仲裁」、其余=任务答案。
 */
function installFakeRouter(scenario: Scenario) {
  const state = {
    answerCalls: 0,
    voteCalls: 0,
    arbCalls: 0,
    excludeSeen: [] as Array<string[] | undefined>,
  };
  const spy = spyOn(router, "executeWithRole").mockImplementation(async (role, msgs, opts) => {
    const sys = String(msgs[0]?.content ?? "");
    if (sys.includes("事实核查员")) {
      const i = state.voteCalls++;
      state.excludeSeen.push(opts?.excludeModels ? [...opts.excludeModels] : undefined);
      const v = scenario.votes[i % scenario.votes.length]!;
      if (v instanceof Error) throw v;
      return resp(v, `voter-${i + 1}`, String(role));
    }
    if (sys.includes("仲裁")) {
      state.arbCalls += 1;
      const a = scenario.arbitration;
      if (a instanceof Error) throw a;
      return resp(a ?? null, "arbiter", "evaluation");
    }
    state.answerCalls += 1;
    return resp(scenario.answer(state.answerCalls), `answerer-${state.answerCalls}`, String(role));
  });
  spies.push(spy);
  return state;
}

/** 生产同构接线：dispatch/arbitrate 都经同一 router（D2 冻结口径） */
function makeValidator(withArbitration = true): CrossValidator {
  const dispatch: VoteDispatch = async (role, messages, opts) => {
    const r = await router.executeWithRole(role, messages as ChatMessage[], opts);
    return { model: r.model, content: r.content };
  };
  const arbitrate = withArbitration
    ? async (conclusion: string, _votes: readonly VerificationVote[]) => {
        const r = await router.executeWithRole("evaluation", [
          {
            role: "system",
            content: "你是仲裁角色。独立裁决下述结论，回答以一行 `VERDICT: AGREE`、`VERDICT: DISAGREE` 或 `VERDICT: ABSTAIN` 结尾。",
          },
          { role: "user", content: conclusion },
        ]);
        return parseVoteVerdict(r.content);
      }
    : undefined;
  return new CrossValidator({ dispatch, ...(arbitrate ? { arbitrate } : {}) });
}

/** verify 适配器：交叉验证最终结论即审核结论；disagree/未决一律 fail-closed */
function makeVerifier(validator: CrossValidator) {
  return async (answer: string) => {
    const r = await validator.validate(answer, VOTE_ROLES);
    const verdict = r.arbitration.finalVerdict;
    if (verdict === "agree") return { ok: true };
    return {
      ok: false,
      feedback: `交叉验证未通过（finalVerdict=${verdict ?? "未决"}，outcome=${r.aggregate.outcome}），请修正`,
    };
  };
}

describe("S5 端到端 fail-closed 铁律", () => {
  it("正常结论：共识 AGREE → passed 放行，excludeModels 累积去重（独立模型语义）", async () => {
    const state = installFakeRouter({
      answer: () => "空气散射使天空呈蓝色",
      votes: ["VERDICT: AGREE", "VERDICT: AGREE"],
    });
    const r = await orchestrator.execute(TASK, { verify: makeVerifier(makeValidator()) });
    expect(r.verification).toEqual({ status: "passed", attempts: 1 });
    expect(state.answerCalls).toBe(1); // 无需修正轮
    expect(state.voteCalls).toBe(2); // ≥2 独立模型验证（设计 3.3）
    // 第二张票必须避开第一张票的模型（顺序分发去重铁律）
    expect(state.excludeSeen[0]).toEqual([]);
    expect(state.excludeSeen[1]).toContain("voter-1");
  });

  it("幻觉注入：共识 DISAGREE → 修正一轮仍 DISAGREE → degraded 拦截（绝不静默放行）", async () => {
    const state = installFakeRouter({
      answer: (n) => `hallucination-v${n}`,
      votes: ["VERDICT: DISAGREE", "VERDICT: DISAGREE"],
    });
    const r = await orchestrator.execute(TASK, { verify: makeVerifier(makeValidator()) });
    expect(r.verification).toEqual({ status: "degraded", attempts: 2 }); // 拦截标记
    expect(r.finalAnswer).toBe("hallucination-v2"); // 保留结果交调用方处置，但绝不 passed
    expect(state.answerCalls).toBe(2); // 修正一轮，绝不第三轮
    expect(state.voteCalls).toBe(4); // 两轮各 2 票
  });

  it("协调器全角色异常：abstain→insufficient→仲裁弃权→未决 → degraded + logger.warn 告警", async () => {
    const state = installFakeRouter({
      answer: (n) => `answer-v${n}`,
      votes: [new Error("upstream 502"), new Error("timeout")],
      arbitration: "VERDICT: ABSTAIN",
    });
    const warnSpy = spyOn(logger, "warn");
    spies.push(warnSpy);
    const r = await orchestrator.execute(TASK, { verify: makeVerifier(makeValidator()) });
    expect(r.verification).toEqual({ status: "degraded", attempts: 2 }); // fail-closed
    expect(r.finalAnswer).toBe("answer-v2"); // 主链路答案不丢
    expect(state.voteCalls).toBe(4); // 两轮全部角色分发失败
    // 告警铁律：分发异常不得静默（S-A8 切片 7 对齐）
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("CrossValidator"))).toBe(true);
  });

  it("平票 + 仲裁弃权：tie→仲裁 ABSTAIN→未决 → degraded（S3 接缝端到端，绝不默认放行）", async () => {
    const state = installFakeRouter({
      answer: (n) => `answer-v${n}`,
      votes: ["VERDICT: AGREE", "VERDICT: DISAGREE"],
      arbitration: "VERDICT: ABSTAIN",
    });
    const r = await orchestrator.execute(TASK, { verify: makeVerifier(makeValidator()) });
    expect(r.verification.status).toBe("degraded");
    expect(state.arbCalls).toBe(2); // 两轮各触发一次仲裁
    expect(state.voteCalls).toBe(4);
  });
});
