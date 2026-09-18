/**
 * 多模型协同 S1：CrossValidator 纯聚合逻辑测试（投票/分歧/降级，零 LLM 零网络）
 *
 * 契约（计划 2026-09-10-multi-model-collaboration-survey-plan.md S1，D3 冻结）：
 * - 有效票 = agree + disagree（abstain 不计入多数判定）；
 * - 有效票 < 2 → insufficient（不满足"≥2 模型独立验证"，fail-closed 交仲裁）；
 * - 有效票全一致 → consensus；严格多数 → majority；平票 → tie；
 * - tie/insufficient → needsArbitration=true 且 finalVerdict=null（S3 仲裁接缝）。
 */
import { describe, expect, it } from "bun:test";
import {
  aggregateVotes,
  parseVoteVerdict,
  CrossValidator,
  type VerificationVote,
  type VoteDispatch,
  type ArbitrateFn,
} from "../../src/agents/cross-validator.js";

/** 便捷构造：按票型字符串数组生成投票（模型名自动编号） */
function votes(...kinds: Array<"agree" | "disagree" | "abstain">): VerificationVote[] {
  return kinds.map((verdict, i) => ({ model: `m-${i + 1}`, verdict }));
}

describe("S1 aggregateVotes：共识与多数", () => {
  it("双模一致 agree → consensus，finalVerdict=agree，无需仲裁", () => {
    const r = aggregateVotes(votes("agree", "agree"));
    expect(r.outcome).toBe("consensus");
    expect(r.finalVerdict).toBe("agree");
    expect(r.needsArbitration).toBe(false);
    expect(r).toMatchObject({ agree: 2, disagree: 0, abstain: 0 });
  });

  it("2-1 多数 agree → majority，finalVerdict=agree", () => {
    const r = aggregateVotes(votes("agree", "agree", "disagree"));
    expect(r.outcome).toBe("majority");
    expect(r.finalVerdict).toBe("agree");
    expect(r.needsArbitration).toBe(false);
    expect(r).toMatchObject({ agree: 2, disagree: 1, abstain: 0 });
  });

  it("双模一致 disagree → consensus，finalVerdict=disagree（共识不预设方向偏置）", () => {
    const r = aggregateVotes(votes("disagree", "disagree"));
    expect(r.outcome).toBe("consensus");
    expect(r.finalVerdict).toBe("disagree");
    expect(r.needsArbitration).toBe(false);
  });

  it("1-2 多数 disagree → majority，finalVerdict=disagree", () => {
    const r = aggregateVotes(votes("agree", "disagree", "disagree"));
    expect(r.outcome).toBe("majority");
    expect(r.finalVerdict).toBe("disagree");
    expect(r.needsArbitration).toBe(false);
  });
});

describe("S1 aggregateVotes：分歧与降级（fail-closed 交仲裁）", () => {
  it("平票 1-1 → tie，needsArbitration=true，finalVerdict=null", () => {
    const r = aggregateVotes(votes("agree", "disagree"));
    expect(r.outcome).toBe("tie");
    expect(r.finalVerdict).toBeNull();
    expect(r.needsArbitration).toBe(true);
  });

  it("平票 2-2（含弃权不影响有效票）→ tie", () => {
    const r = aggregateVotes(votes("agree", "agree", "disagree", "disagree"));
    expect(r.outcome).toBe("tie");
    expect(r.needsArbitration).toBe(true);
  });

  it("单模型退化（有效票 1）→ insufficient，不满足 ≥2 独立验证，交仲裁", () => {
    const r = aggregateVotes(votes("agree"));
    expect(r.outcome).toBe("insufficient");
    expect(r.finalVerdict).toBeNull();
    expect(r.needsArbitration).toBe(true);
  });

  it("空投票 → insufficient（fail-closed，绝不默认放行）", () => {
    const r = aggregateVotes([]);
    expect(r.outcome).toBe("insufficient");
    expect(r.needsArbitration).toBe(true);
  });

  it("全弃权 → insufficient（无有效票）", () => {
    const r = aggregateVotes(votes("abstain", "abstain", "abstain"));
    expect(r.outcome).toBe("insufficient");
    expect(r).toMatchObject({ agree: 0, disagree: 0, abstain: 3 });
    expect(r.needsArbitration).toBe(true);
  });

  it("abstain 稀释：agree+abstain → 有效票 1 → insufficient", () => {
    const r = aggregateVotes(votes("agree", "abstain"));
    expect(r.outcome).toBe("insufficient");
    expect(r.needsArbitration).toBe(true);
  });

  it("abstain 不掩盖多数：agree+agree+disagree+abstain → majority(agree)", () => {
    const r = aggregateVotes(votes("agree", "agree", "disagree", "abstain"));
    expect(r.outcome).toBe("majority");
    expect(r.finalVerdict).toBe("agree");
    expect(r).toMatchObject({ agree: 2, disagree: 1, abstain: 1 });
  });

  it("agree+disagree+abstain → 有效票 1-1 → tie（弃权不改变平票）", () => {
    const r = aggregateVotes(votes("agree", "disagree", "abstain"));
    expect(r.outcome).toBe("tie");
    expect(r.needsArbitration).toBe(true);
  });
});

describe("S1 aggregateVotes：不变量", () => {
  it("计数守恒：agree+disagree+abstain === 输入票数（任意票型组合）", () => {
    const cases: Array<Array<"agree" | "disagree" | "abstain">> = [
      [],
      ["agree"],
      ["agree", "disagree", "abstain"],
      ["abstain", "abstain", "agree", "agree", "disagree"],
      ["disagree", "disagree", "disagree"],
    ];
    for (const kinds of cases) {
      const r = aggregateVotes(votes(...kinds));
      expect(r.agree + r.disagree + r.abstain).toBe(kinds.length);
    }
  });

  it("outcome 与 needsArbitration 严格互斥：consensus/majority 必无需仲裁，tie/insufficient 必交仲裁", () => {
    const decided = [
      aggregateVotes(votes("agree", "agree")),
      aggregateVotes(votes("agree", "agree", "disagree")),
    ];
    const unresolved = [
      aggregateVotes(votes("agree", "disagree")),
      aggregateVotes(votes("agree")),
      aggregateVotes([]),
    ];
    for (const r of decided) {
      expect(r.needsArbitration).toBe(false);
      expect(r.finalVerdict).not.toBeNull();
    }
    for (const r of unresolved) {
      expect(r.needsArbitration).toBe(true);
      expect(r.finalVerdict).toBeNull();
    }
  });

  it("投票顺序不影响结果（置换不变性）", () => {
    const a = aggregateVotes(votes("agree", "disagree", "agree"));
    const b = aggregateVotes(votes("disagree", "agree", "agree"));
    expect(a).toEqual(b);
  });
});

// ============ S2：validate 接注入 dispatch（fake router，零网络） ============

/** 票面文本解析（D2 复用 registry 角色，模型以自由文本作答，需鲁棒解析成票） */
describe("S2 parseVoteVerdict：票面解析", () => {
  it("显式 VERDICT: AGREE / DISAGREE（大小写不敏感）", () => {
    expect(parseVoteVerdict("VERDICT: AGREE")).toBe("agree");
    expect(parseVoteVerdict("verdict: disagree")).toBe("disagree");
  });

  it("裸词 AGREE / DISAGREE（含 DISAGREE 不误判为 AGREE——子串陷阱）", () => {
    expect(parseVoteVerdict("AGREE")).toBe("agree");
    expect(parseVoteVerdict("DISAGREE")).toBe("disagree");
    expect(parseVoteVerdict("I DISAGREE with this claim.")).toBe("disagree");
  });

  it("先给理由再给票（取票面关键词）", () => {
    expect(parseVoteVerdict("After checking the sources, I agree.")).toBe("agree");
  });

  it("无票面关键词 / 空 / null → abstain（未能给出可判票）", () => {
    expect(parseVoteVerdict("maybe, not sure")).toBe("abstain");
    expect(parseVoteVerdict("")).toBe("abstain");
    expect(parseVoteVerdict(null)).toBe("abstain");
    expect(parseVoteVerdict(undefined)).toBe("abstain");
  });
});

/** fake dispatch：记录调用序列（含 messages 供仲裁提示词断言），按脚本返回 {model, content} 或抛错 */
function makeDispatchFake(
  script: Array<{ model: string; content: string | null } | { error: true }>,
) {
  const calls: Array<{ role: string; excludeModels: string[]; messages: readonly { role: string; content: string }[] }> = [];
  let i = 0;
  const dispatch: VoteDispatch = async (role, messages, opts) => {
    calls.push({ role, excludeModels: [...(opts?.excludeModels ?? [])], messages });
    const step = script[i++];
    if (!step) throw new Error("fake dispatch: script exhausted");
    if ("error" in step) throw new Error("upstream 500");
    return step;
  };
  return { dispatch, calls };
}

describe("S2 CrossValidator.validate：分发 + 聚合 + fail-closed", () => {
  it("三角色全 agree → consensus，dispatch 收到 3 次调用", async () => {
    const { dispatch, calls } = makeDispatchFake([
      { model: "deepseek-a", content: "VERDICT: AGREE" },
      { model: "qwen-b", content: "I agree" },
      { model: "glm-c", content: "agree" },
    ]);
    const v = new CrossValidator({ dispatch });
    const r = await v.validate("Kubernetes 是容器编排系统", ["decision", "evaluation", "review"]);
    expect(calls.length).toBe(3);
    expect(r.votes.map((x) => x.verdict)).toEqual(["agree", "agree", "agree"]);
    expect(r.aggregate.outcome).toBe("consensus");
    expect(r.aggregate.finalVerdict).toBe("agree");
  });

  it("2 agree + 1 disagree → majority(agree)，票按角色顺序记录", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: "DISAGREE" },
      { model: "m3", content: "AGREE" },
    ]);
    const r = await new CrossValidator({ dispatch }).validate("x", ["decision", "review", "research"]);
    expect(r.aggregate).toMatchObject({ outcome: "majority", finalVerdict: "agree", agree: 2, disagree: 1 });
  });

  it("excludeModels 累积防重复：第 2 次调用收到第 1 次返回的模型", async () => {
    const { dispatch, calls } = makeDispatchFake([
      { model: "deepseek-a", content: "AGREE" },
      { model: "qwen-b", content: "AGREE" },
    ]);
    await new CrossValidator({ dispatch }).validate("x", ["decision", "evaluation"]);
    expect(calls[0].excludeModels).toEqual([]);
    expect(calls[1].excludeModels).toContain("deepseek-a");
  });

  it("调用方预置 excludeModels 透传并累积", async () => {
    const { dispatch, calls } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: "AGREE" },
    ]);
    await new CrossValidator({ dispatch }).validate("x", ["decision", "review"], {
      excludeModels: ["forbidden-model"],
    });
    expect(calls[0].excludeModels).toEqual(["forbidden-model"]);
    expect(calls[1].excludeModels).toEqual(["forbidden-model", "m1"]);
  });

  it("错误隔离：某角色 dispatch 抛错 → 该票记 abstain，不使整体崩溃", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { error: true },
      { model: "m3", content: "AGREE" },
    ]);
    const r = await new CrossValidator({ dispatch }).validate("x", ["decision", "review", "research"]);
    expect(r.votes.map((x) => x.verdict)).toEqual(["agree", "abstain", "agree"]);
    expect(r.aggregate).toMatchObject({ outcome: "consensus", finalVerdict: "agree", abstain: 1 });
  });

  it("content 为 null（上游空响应）→ abstain", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: null },
      { model: "m3", content: "AGREE" },
    ]);
    const r = await new CrossValidator({ dispatch }).validate("x", ["decision", "review", "research"]);
    expect(r.votes[1].verdict).toBe("abstain");
  });

  it("全角色抛错 → 全 abstain → insufficient + needsArbitration（fail-closed）", async () => {
    const { dispatch } = makeDispatchFake([{ error: true }, { error: true }]);
    const r = await new CrossValidator({ dispatch }).validate("x", ["decision", "review"]);
    expect(r.aggregate.outcome).toBe("insufficient");
    expect(r.aggregate.needsArbitration).toBe(true);
    expect(r.aggregate.finalVerdict).toBeNull();
  });

  it("单角色验证 → insufficient（有效票 <2，不满足 ≥2 独立验证）", async () => {
    const { dispatch } = makeDispatchFake([{ model: "m1", content: "AGREE" }]);
    const r = await new CrossValidator({ dispatch }).validate("x", ["decision"]);
    expect(r.aggregate.outcome).toBe("insufficient");
    expect(r.aggregate.needsArbitration).toBe(true);
  });
});

// ============ S3：分歧裁决（仲裁端口注入，fail-closed 未决不默认放行） ============

/** fake arbitrate：记录入参，按脚本返回票或抛错 */
function makeArbitrateFake(
  step: { verdict: "agree" | "disagree" | "abstain" } | { error: true },
) {
  const calls: Array<{ conclusion: string; votes: readonly VerificationVote[] }> = [];
  const arbitrate: ArbitrateFn = async (conclusion, votes) => {
    calls.push({ conclusion, votes: [...votes] });
    if ("error" in step) throw new Error("arbiter upstream 500");
    return step.verdict;
  };
  return { arbitrate, calls };
}

describe("S3 CrossValidator 仲裁接缝：触发与裁决", () => {
  it("平票 + 仲裁 agree → triggered/resolved，finalVerdict=agree，仲裁收到结论与全票", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: "DISAGREE" },
    ]);
    const { arbitrate, calls } = makeArbitrateFake({ verdict: "agree" });
    const r = await new CrossValidator({ dispatch, arbitrate }).validate("K8s 是数据库", [
      "decision",
      "review",
    ]);
    expect(r.aggregate.outcome).toBe("tie");
    expect(r.arbitration.triggered).toBe(true);
    expect(r.arbitration.resolved).toBe(true);
    expect(r.arbitration.finalVerdict).toBe("agree");
    expect(calls.length).toBe(1);
    expect(calls[0].conclusion).toBe("K8s 是数据库");
    expect(calls[0].votes.map((v) => v.verdict)).toEqual(["agree", "disagree"]);
  });

  it("有效票不足（单票）+ 仲裁 disagree → finalVerdict=disagree（仲裁可救 insufficient）", async () => {
    const { dispatch } = makeDispatchFake([{ model: "m1", content: "AGREE" }]);
    const { arbitrate } = makeArbitrateFake({ verdict: "disagree" });
    const r = await new CrossValidator({ dispatch, arbitrate }).validate("x", ["decision"]);
    expect(r.aggregate.outcome).toBe("insufficient");
    expect(r.arbitration).toMatchObject({ triggered: true, resolved: true, finalVerdict: "disagree" });
  });

  it("仲裁弃权（abstain）→ resolved=false + finalVerdict=null（fail-closed 未决）", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: "DISAGREE" },
    ]);
    const { arbitrate } = makeArbitrateFake({ verdict: "abstain" });
    const r = await new CrossValidator({ dispatch, arbitrate }).validate("x", ["decision", "review"]);
    expect(r.arbitration).toMatchObject({
      triggered: true,
      resolved: false,
      verdict: "abstain",
      finalVerdict: null,
    });
  });

  it("仲裁抛错 → 不崩溃，resolved=false + finalVerdict=null（fail-closed）", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: "DISAGREE" },
    ]);
    const { arbitrate } = makeArbitrateFake({ error: true });
    const r = await new CrossValidator({ dispatch, arbitrate }).validate("x", ["decision", "review"]);
    expect(r.arbitration).toMatchObject({ triggered: true, resolved: false, finalVerdict: null });
  });

  it("共识（无需仲裁）→ arbitrate 零调用，arbitration.triggered=false 且 finalVerdict 透传聚合结论", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: "AGREE" },
    ]);
    const { arbitrate, calls } = makeArbitrateFake({ verdict: "disagree" });
    const r = await new CrossValidator({ dispatch, arbitrate }).validate("x", ["decision", "review"]);
    expect(calls.length).toBe(0); // 铁律：共识绝不叫仲裁（防仲裁翻案已定结论）
    expect(r.arbitration.triggered).toBe(false);
    expect(r.arbitration.resolved).toBe(true);
    expect(r.arbitration.finalVerdict).toBe("agree");
  });

  it("未配置 arbitrate 的分歧 → triggered=false、resolved=false（保持 S1/S2 语义不变）", async () => {
    const { dispatch } = makeDispatchFake([
      { model: "m1", content: "AGREE" },
      { model: "m2", content: "DISAGREE" },
    ]);
    const r = await new CrossValidator({ dispatch }).validate("x", ["decision", "review"]);
    expect(r.arbitration).toMatchObject({ triggered: false, resolved: false, finalVerdict: null });
  });
});
