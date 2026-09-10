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
import type { TaskRole } from "../router/models/types.js";

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

// ============ S2：分发端口 + 票面解析 + CrossValidator（依赖注入，零直接 import router） ============

/**
 * 分发端口（D2 冻结：生产接 Dispatcher.dispatch/executeWithRole，测试注入 fake）。
 * 返回 {model, content}：model 供 excludeModels 去重，content 为模型自由文本票面。
 * 抛错 = 该角色验证失败（错误隔离，映射 abstain）。
 */
export type VoteDispatch = (
  role: TaskRole,
  messages: readonly { role: string; content: string }[],
  opts?: { excludeModels?: string[] },
) => Promise<{ model: string; content: string | null }>;

/**
 * 票面文本 → 票。DISAGREE 含 AGREE 子串，必须先判 disagree（子串陷阱）。
 * 无关键词/空/null → abstain（可判票缺失，不猜测方向——fail-closed）。
 */
export function parseVoteVerdict(text: string | null | undefined): VoteVerdict {
  if (!text) return "abstain";
  if (/disagree/i.test(text)) return "disagree";
  if (/agree/i.test(text)) return "agree";
  return "abstain";
}

/** 验证者系统提示：要求模型独立判断结论并输出规范票面 */
function voteMessages(conclusion: string): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content:
        "你是独立事实核查员。仅依据你自身的知识与给定的证据判断下述结论是否成立，" +
        "不要迎合提问者的立场。回答必须以一行 `VERDICT: AGREE` 或 `VERDICT: DISAGREE` 结尾。",
    },
    { role: "user", content: conclusion },
  ];
}

export interface CrossValidatorDeps {
  dispatch: VoteDispatch;
  /**
   * 仲裁端口（D3 冻结：平票/有效票不足时交裁决；生产可接仲裁角色或 ValidationPipeline，
   * 接缝与 dispatch 同构由调用方适配，S3 只约定"结论+全票→票"契约）。缺省则分歧保持未决。
   */
  arbitrate?: ArbitrateFn;
}

/**
 * 仲裁端口：给定结论与分歧票面，产出独立裁决票。
 * 返回 abstain = 仲裁者亦无法定夺（fail-closed 未决，绝不默认放行）。
 */
export type ArbitrateFn = (
  conclusion: string,
  votes: readonly VerificationVote[],
) => Promise<VoteVerdict>;

/** 仲裁阶段结果（needsArbitration=false 时 triggered=false、finalVerdict 透传聚合结论） */
export interface ArbitrationResult {
  /** 是否进入仲裁流程（= aggregate.needsArbitration 且已配置 arbitrate） */
  triggered: boolean;
  /** 是否得到确定裁决（共识/多数恒 true；仲裁 agree/disagree 为 true；仲裁 abstain/抛错/未配置为 false） */
  resolved: boolean;
  /** 仲裁者原始票（未触发仲裁为 null） */
  verdict: VoteVerdict | null;
  /** 最终结论方向：共识/多数=聚合结论；仲裁成功=仲裁票；未决=null（fail-closed） */
  finalVerdict: "agree" | "disagree" | null;
}

export interface CrossValidationResult {
  votes: VerificationVote[];
  aggregate: VoteAggregate;
  arbitration: ArbitrationResult;
}

export class CrossValidator {
  private readonly deps: CrossValidatorDeps;

  constructor(deps: CrossValidatorDeps) {
    this.deps = deps;
  }

  /**
   * 对结论做 ≥N 角色独立交叉验证（设计 3.3）。
   * 顺序分发（非并发）：excludeModels 须累积前序已用模型，保证"独立模型"语义——
   * 并发的话后发调用看不到先发返回的模型，去重失效（S2 计划措辞修正，见 ops log 偏差）。
   * 单角色失败 → abstain 票（错误隔离）；有效票不足由 aggregateVotes 兜底 fail-closed。
   */
  async validate(
    conclusion: string,
    roles: readonly TaskRole[],
    opts?: { excludeModels?: readonly string[] },
  ): Promise<CrossValidationResult> {
    const used: string[] = [...(opts?.excludeModels ?? [])];
    const votes: VerificationVote[] = [];
    for (const role of roles) {
      try {
        const res = await this.deps.dispatch(role, voteMessages(conclusion), {
          excludeModels: [...used],
        });
        used.push(res.model);
        votes.push({ model: res.model, verdict: parseVoteVerdict(res.content) });
      } catch {
        votes.push({ model: `role:${role}`, verdict: "abstain" });
      }
    }
    const aggregate = aggregateVotes(votes);
    return { votes, aggregate, arbitration: await this.arbitrate(conclusion, votes, aggregate) };
  }

  /**
   * 分歧裁决（S3）。铁律：
   * - 共识/多数（needsArbitration=false）→ 直接透传聚合结论，**绝不叫仲裁**（防翻案已定结论）；
   * - tie/insufficient 且已配置 arbitrate → 触发仲裁；仲裁 abstain/抛错 → 未决（finalVerdict=null）；
   * - 未配置 arbitrate → 保持分歧未决（triggered=false，向后兼容 S1/S2 语义）。
   */
  private async arbitrate(
    conclusion: string,
    votes: readonly VerificationVote[],
    aggregate: VoteAggregate,
  ): Promise<ArbitrationResult> {
    if (!aggregate.needsArbitration) {
      return {
        triggered: false,
        resolved: true,
        verdict: null,
        finalVerdict: aggregate.finalVerdict,
      };
    }
    if (!this.deps.arbitrate) {
      return { triggered: false, resolved: false, verdict: null, finalVerdict: null };
    }
    try {
      const verdict = await this.deps.arbitrate(conclusion, votes);
      const decided = verdict === "agree" || verdict === "disagree";
      return {
        triggered: true,
        resolved: decided,
        verdict,
        finalVerdict: decided ? verdict : null,
      };
    } catch {
      // 仲裁自身异常 → fail-closed 未决（对齐 S-A8 崩坏隔离：绝不默认放行）
      return { triggered: true, resolved: false, verdict: null, finalVerdict: null };
    }
  }
}
