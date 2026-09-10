/**
 * 多模型协同 S6：关键结论触发策略（缺口 D，平衡设计 3.3 与降本）
 *
 * 契约（计划 2026-09-10-multi-model-collaboration-survey-plan.md S6，D4 冻结）：
 * - decideCrossValidation：显式 force > skip 命中豁免 > critical 命中触发 > 默认不触发；
 * - createCrossValidationVerifier：恒按 decideCrossValidation 门控（D4：默认即关键结论触发，
 *   非全量）；trigger.force=true 恢复恒触发（S5 全量验证语义）；
 *   不触发时返回 {ok:true} 且绝不 dispatch（降本铁律：非关键结论零验证成本）；
 * - 触发时完整走 CrossValidator 投票/仲裁（S1-S3），disagree/未决 → fail-closed ok:false；
 * - 启发式是保守近似：调用方可用 opts.crossValidate 完全接管（纯函数无隐藏状态，规则 8）。
 */
import { describe, expect, it } from "bun:test";
import {
  decideCrossValidation,
  createCrossValidationVerifier,
  CrossValidator,
  type VoteDispatch,
} from "../../src/agents/cross-validator.js";
import type { TaskRole } from "../../src/router/models/types.js";

const ROLES: readonly TaskRole[] = ["research", "review"];

describe("S6 decideCrossValidation：触发边界", () => {
  it("显式 force=true 压过一切（含 skip 关键词）", () => {
    expect(
      decideCrossValidation("随便聊聊天气", {
        force: true,
        skipPatterns: [/天气/],
      }),
    ).toBe(true);
  });

  it("显式 force=false 压过一切（含 critical 关键词）", () => {
    expect(
      decideCrossValidation("数据库迁移方案", {
        force: false,
        criticalPatterns: [/迁移/],
      }),
    ).toBe(false);
  });

  it("force 缺省时 skip 压过 critical（闲聊即使含关键动作词也不触发）", () => {
    const opts = {
      criticalPatterns: [/迁移/],
      skipPatterns: [/闲聊|随便聊聊/],
    };
    expect(decideCrossValidation("随便聊聊数据库迁移的事", opts)).toBe(false);
    expect(decideCrossValidation("数据库迁移方案评审", opts)).toBe(true);
  });

  it("默认启发式：关键结论形态命中（事实/结论/决定/方案/迁移/架构/根因/验收…）", () => {
    for (const text of [
      "一个事实：服务已迁移", // 事实：
      "结论是根因在连接池", // 结论是
      "决定采用方案 B", // 决定采用
      "架构设计如下", // 架构设计
      "数据库迁移计划", // 迁移
      "方案对比", // 方案
      "验收标准", // 验收
      "上线部署", // 上线
      "发布说明", // 发布
      "回滚策略", // 回滚
      "最终决定", // 最终决定
      "the conclusion is that it works", // 英文 conclusion
      "we should deploy now", // 英文 deploy
    ]) {
      expect(decideCrossValidation(text, {})).toBe(true);
    }
  });

  it("默认启发式：闲聊/寒暄/简单问答不触发（降本侧）", () => {
    for (const text of [
      "今天天气怎么样",
      "你好",
      "讲个笑话",
      "嗨",
      "谢谢",
      "好的",
      "yes",
      "no",
      "hi there",
      "hello",
      "thanks a lot",
    ]) {
      expect(decideCrossValidation(text, {})).toBe(false);
    }
  });

  it("空文本 / 纯空白 → 不触发", () => {
    expect(decideCrossValidation("", {})).toBe(false);
    expect(decideCrossValidation("   \n  ", {})).toBe(false);
  });

  it("自定义 patterns 完全接管（默认启发式可被覆盖）", () => {
    const opts = { criticalPatterns: [/^KRITICAL/], skipPatterns: [] };
    expect(decideCrossValidation("KRITICAL whatever", opts)).toBe(true);
    expect(decideCrossValidation("一个事实：天空是蓝的", opts)).toBe(false); // 默认词表被覆盖
  });
});

/** 记录调用次数的 fake dispatch（零网络确定性） */
function makeFakeDispatch(impl: () => Promise<{ model: string; content: string | null }>) {
  const state = { calls: 0 };
  const dispatch: VoteDispatch = async () => {
    state.calls += 1;
    return impl();
  };
  return { dispatch, state };
}

describe("S6 createCrossValidationVerifier：降本铁律", () => {
  it("不触发 → 直接 ok:true，dispatch 零调用（非关键结论零验证成本）", async () => {
    const { dispatch, state } = makeFakeDispatch(async () => ({ model: "m", content: null }));
    const verify = createCrossValidationVerifier({ dispatch }, { roles: ROLES });
    const r = await verify("今天天气怎么样");
    expect(r).toEqual({ ok: true });
    expect(state.calls).toBe(0);
  });

  it("trigger.force=true → 恒触发（恢复 S5 全量验证语义），非关键文本也 dispatch", async () => {
    const { dispatch, state } = makeFakeDispatch(async () => ({
      model: "m",
      content: "VERDICT: AGREE",
    }));
    const verify = createCrossValidationVerifier({ dispatch }, { roles: ROLES, trigger: { force: true } });
    const r = await verify("随便什么文本");
    expect(r.ok).toBe(true);
    expect(state.calls).toBe(2); // 两角色各一票
  });

  it("触发 + 共识 DISAGREE → ok:false 且 feedback 带交叉验证语义", async () => {
    const { dispatch } = makeFakeDispatch(async () => ({
      model: "m",
      content: "VERDICT: DISAGREE",
    }));
    const verify = createCrossValidationVerifier({ dispatch }, { roles: ROLES });
    const r = await verify("一个事实：天空是绿色的");
    expect(r.ok).toBe(false);
    expect(String(r.feedback)).toContain("交叉验证未通过");
  });

  it("触发 + 未决（全异常→insufficient→无仲裁端口）→ fail-closed ok:false", async () => {
    const dispatch: VoteDispatch = async () => {
      throw new Error("upstream down");
    };
    const verify = createCrossValidationVerifier({ dispatch }, { roles: ROLES });
    const r = await verify("决定采用方案 C");
    expect(r.ok).toBe(false);
    expect(String(r.feedback)).toContain("未决");
  });

  it("显式 crossValidate=true 强制触发（即使启发式不命中）", async () => {
    const { dispatch, state } = makeFakeDispatch(async () => ({
      model: "m",
      content: "VERDICT: AGREE",
    }));
    const verify = createCrossValidationVerifier({ dispatch }, { roles: ROLES });
    const r = await verify("你好", { crossValidate: true });
    expect(r.ok).toBe(true);
    expect(state.calls).toBe(2);
  });

  it("opts 复用安全：连续两次 verify 不共享 excludeModels 残留", async () => {
    const used: Array<string[] | undefined> = [];
    const dispatch: VoteDispatch = async (_role, _msgs, opts) => {
      used.push(opts?.excludeModels ? [...opts.excludeModels] : undefined);
      return { model: `m-${used.length}`, content: "VERDICT: AGREE" };
    };
    const verify = createCrossValidationVerifier({ dispatch }, { roles: ROLES });
    await verify("结论是 A");
    await verify("结论是 B");
    // 每次 validate 的首票 excludeModels 必为空（不含上一轮残留）
    expect(used[0]).toEqual([]);
    expect(used[2]).toEqual([]);
  });
});

describe("S6 与 CrossValidator 集成：validator 注入复用", () => {
  it("传入现成 validator 时不再内部构造（同一实例语义）", async () => {
    const { dispatch, state } = makeFakeDispatch(async () => ({
      model: "m",
      content: "VERDICT: AGREE",
    }));
    const validator = new CrossValidator({ dispatch });
    const verify = createCrossValidationVerifier({ dispatch }, { roles: ROLES, validator });
    await verify("一个事实：1+1=2");
    expect(state.calls).toBe(2);
  });
});
