/**
 * 多模型协同 S1：CrossValidator 纯聚合逻辑（缺口 A 的投票内核，零 LLM 零网络）
 *
 * 设计来源：docs/superpowers/plans/2026-09-10-multi-model-collaboration-survey-plan.md
 * 决策 D3（已冻结）：多数投票；平票/有效票不足交仲裁角色（S3 接缝 = needsArbitration）。
 *
 * 铁律（对齐 S-A8 fail-closed）：任何不确定形态（空票/单票/平票/全弃权）
 * 一律 needsArbitration=true 且 finalVerdict=null——绝不默认放行。
 *
 * 本文件只做纯函数聚合；模型调用（Dispatcher.dispatch）与裁决（ValidationPipeline/
 * 仲裁角色）分别归 S2/S3，经依赖注入接入（规则 8：接缝在测试面）。
 */

/** 单模型验证票：agree=认可结论；disagree=否定结论；abstain=该模型未能给出可判票（超时/解析失败，S2 映射） */
export type VoteVerdict = "agree" | "disagree" | "abstain";

export interface VerificationVote {
  model: string;
  verdict: VoteVerdict;
}

/** 聚合结局：consensus=有效票全一致；majority=严格多数；tie=平票；insufficient=有效票 <2（不满足 ≥2 独立验证） */
export type VoteOutcome = "consensus" | "majority" | "tie" | "insufficient";

export interface VoteAggregate {
  outcome: VoteOutcome;
  /** consensus/majority 时为定论方向；tie/insufficient 为 null（待 S3 仲裁） */
  finalVerdict: "agree" | "disagree" | null;
  /** tie/insufficient=true → 交仲裁角色（D3 冻结语义） */
  needsArbitration: boolean;
  agree: number;
  disagree: number;
  abstain: number;
}

/** 满足交叉验证所需的最少有效票数（设计 3.3："至少两个不同模型独立验证"） */
export const MIN_VALID_VOTES = 2;

/**
 * 纯聚合：投票列表 → 结构化裁决。
 * 置换不变（顺序无关）；计数恒等于输入长度（守恒）。
 */
export function aggregateVotes(votes: readonly VerificationVote[]): VoteAggregate {
  let agree = 0;
  let disagree = 0;
  let abstain = 0;
  for (const v of votes) {
    switch (v.verdict) {
      case "agree":
        agree += 1;
        break;
      case "disagree":
        disagree += 1;
        break;
      case "abstain":
        abstain += 1;
        break;
    }
  }

  const valid = agree + disagree;
  const base = { agree, disagree, abstain };

  if (valid < MIN_VALID_VOTES) {
    return { ...base, outcome: "insufficient", finalVerdict: null, needsArbitration: true };
  }
  if (agree === disagree) {
    return { ...base, outcome: "tie", finalVerdict: null, needsArbitration: true };
  }
  const winner: "agree" | "disagree" = agree > disagree ? "agree" : "disagree";
  const loser = valid - (winner === "agree" ? agree : disagree);
  return {
    ...base,
    outcome: loser === 0 ? "consensus" : "majority",
    finalVerdict: winner,
    needsArbitration: false,
  };
}
