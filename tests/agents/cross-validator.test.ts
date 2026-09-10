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
  type VerificationVote,
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
