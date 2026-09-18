/**
 * S3 主链路结构化输出收紧 —— zod 解析接缝测试
 *
 * 对应 docs/superpowers/specs/2026-08-29-p1-lift-design.md §S3：
 * 四处解析点（intent-enhancer 云意图 / edge preflight 合并 / risk-monitor 复核 /
 * DRE 云决策）由 extractJson+手写字段检查改为导出 zod schema 校验。
 *
 * 红线：解析失败的降级行为与现状逐字节一致 —— 畸形输入走既有回退路径
 * （null / baseIntent / CloudDecisionInvalidError），代表输入取自各域既有测试。
 * 每处 2 例：合法输入通过且结果同旧；畸形输入被 schema 拒绝（与旧手写检查
 * 同判拒，端到端降级由既有测试覆盖：intent-enhancer.test.ts「非法意图回退」、
 * chat-preflight-parallel.test.ts「意图非法/缺字段 → null」、
 * unit/cloud-decision-guard.test.ts「非 JSON 抛错」）。
 */
import { describe, test, expect } from "bun:test";
import { intentResponseSchema } from "../src/agents/intent-enhancer.js";
import { mergedPreflightSchema } from "../src/services/chat-preflight.js";
import { riskReviewSchema } from "../src/agents/risk-monitor.js";
import {
  dreDecisionSchema,
  parseCloudDecisionOrThrow,
  CloudDecisionInvalidError,
} from "../src/dre/constraints.js";

describe("intentResponseSchema — intent-enhancer 云意图解析接缝", () => {
  test("合法分类输出通过且结果同旧（枚举意图 + confidence 区间边界）", () => {
    // 代表输入取自 intent-enhancer.test.ts「LLM 返回合法 JSON 时修正意图」
    const r = intentResponseSchema.safeParse({ intent: "code", confidence: 0.9, reason: "编程问题" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.intent).toBe("code");
      expect(r.data.confidence).toBe(0.9);
      expect(r.data.reason).toBe("编程问题");
    }
    // 无 reason / 区间边界（1B 边缘层 confidence 常为 0）与旧解析一致放行
    expect(intentResponseSchema.safeParse({ intent: "research", confidence: 0.85 }).success).toBe(true);
    expect(intentResponseSchema.safeParse({ intent: "plan", confidence: 0 }).success).toBe(true);
    expect(intentResponseSchema.safeParse({ intent: "chat", confidence: 1 }).success).toBe(true);
  });

  test("畸形输入拒绝（与旧手写检查同判拒 → 端到端同走 baseIntent 回退）", () => {
    // 非法意图（intent-enhancer.test.ts「LLM 返回非法意图时回退到 baseIntent」的输入）
    expect(intentResponseSchema.safeParse({ intent: "invalid-category", confidence: 0.9 }).success).toBe(false);
    // 错型 / 缺字段 / 越界 —— 旧 typeof 检查同判失败返回 null
    expect(intentResponseSchema.safeParse({ intent: "code", confidence: "high" }).success).toBe(false);
    expect(intentResponseSchema.safeParse({ intent: "code" }).success).toBe(false);
    expect(intentResponseSchema.safeParse({ intent: "code", confidence: 1.2 }).success).toBe(false);
  });
});

describe("mergedPreflightSchema — edge preflight 合并解析接缝", () => {
  test("合法合并输出通过且结果同旧（trim 语义 + 丢弃多余字段）", () => {
    // 代表输入取自 chat-preflight-parallel.test.ts「纯 JSON 与 code fence 包裹 JSON 均可解析」
    const r = mergedPreflightSchema.safeParse({ rewritten: "clean task", intent: "code", confidence: 0.8 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ rewritten: "clean task", intent: "code", confidence: 0.8 });
    }
    // 旧实现 trim 后判空/枚举：空白字段 trim 后等价放行
    const t = mergedPreflightSchema.safeParse({ rewritten: "  r  ", intent: " code ", confidence: 0.9 });
    expect(t.success).toBe(true);
    if (t.success) {
      expect(t.data).toEqual({ rewritten: "r", intent: "code", confidence: 0.9 });
    }
    // 多余字段与旧实现一样不进入结果（LLM 附带噪声不致失败）
    const e = mergedPreflightSchema.safeParse({ rewritten: "r", intent: "write", confidence: 0.55, extra: 1 });
    expect(e.success).toBe(true);
    if (e.success) {
      expect(e.data).toEqual({ rewritten: "r", intent: "write", confidence: 0.55 });
    }
  });

  test("畸形输入拒绝（与旧检查同判拒 → 端到端同返回 null 回退串行）", () => {
    // chat-preflight-parallel.test.ts「意图非法 / 非对象 JSON / 缺字段 → null」的输入
    expect(mergedPreflightSchema.safeParse({ rewritten: "r", intent: "banana", confidence: 0.9 }).success).toBe(false);
    expect(mergedPreflightSchema.safeParse({ intent: "code", confidence: 0.9 }).success).toBe(false);
    expect(mergedPreflightSchema.safeParse({ rewritten: "   ", intent: "code", confidence: 0.9 }).success).toBe(false);
    expect(mergedPreflightSchema.safeParse({ rewritten: "r", intent: "code", confidence: "0.9" }).success).toBe(false);
  });
});

describe("riskReviewSchema — risk-monitor 复核解析接缝", () => {
  test("合法复核输出通过且结果同旧（reason 缺省 = undefined）", () => {
    const r = riskReviewSchema.safeParse({ dangerous: true, reason: "递归删除" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dangerous).toBe(true);
      expect(r.data.reason).toBe("递归删除");
    }
    // reason 缺省：与旧 typeof 分支一致返回 undefined（不致 parse 失败）
    const nr = riskReviewSchema.safeParse({ dangerous: false });
    expect(nr.success).toBe(true);
    if (nr.success) {
      expect(nr.data.dangerous).toBe(false);
      expect(nr.data.reason).toBeUndefined();
    }
  });

  test("畸形输入拒绝（与旧 typeof dangerous 检查同判拒 → 复核视为不可用 null）", () => {
    expect(riskReviewSchema.safeParse({ dangerous: "yes" }).success).toBe(false);
    expect(riskReviewSchema.safeParse({ reason: "只有 reason" }).success).toBe(false);
    expect(riskReviewSchema.safeParse(null).success).toBe(false);
    expect(riskReviewSchema.safeParse("not json").success).toBe(false);
  });
});

describe("dreDecisionSchema / parseCloudDecisionOrThrow — DRE 云决策解析接缝", () => {
  test("合法云决策通过且结果同旧（含 confidence 0/1 边界）", () => {
    // 代表输入取自 unit/cloud-decision-guard.test.ts 与 dre-constraints.test.ts
    const d = parseCloudDecisionOrThrow('{"action":"act","content":"执行","confidence":0.9}');
    expect(d).toEqual({ action: "act", content: "执行", confidence: 0.9 });
    expect(dreDecisionSchema.safeParse({ action: "observe", content: "继续观察", confidence: 0.6 }).success).toBe(true);
    expect(dreDecisionSchema.safeParse({ action: "reflect", content: "需要反思", confidence: 1 }).success).toBe(true);
    expect(dreDecisionSchema.safeParse({ action: "act", content: "执行", confidence: 0 }).success).toBe(true);
  });

  test("畸形输出拒绝并抛 CloudDecisionInvalidError（降级链入口同旧）", () => {
    // cloud-decision-guard.test.ts「非 JSON / 缺 content 抛 CloudDecisionInvalidError」
    expect(() => parseCloudDecisionOrThrow("抱歉，我无法以 JSON 回答……")).toThrow(CloudDecisionInvalidError);
    expect(() => parseCloudDecisionOrThrow('{"action":"observe","content":"x"}')).toThrow(CloudDecisionInvalidError);
    // 枚举越界 / confidence 越界 / 错型（dre-constraints.test.ts 同判 false 的输入）
    expect(() => parseCloudDecisionOrThrow('{"action":"delete","content":"x","confidence":0.5}')).toThrow(CloudDecisionInvalidError);
    expect(() => parseCloudDecisionOrThrow('{"action":"observe","content":"x","confidence":1.2}')).toThrow(CloudDecisionInvalidError);
    expect(() => parseCloudDecisionOrThrow('{"action":"observe","content":"x","confidence":-0.1}')).toThrow(CloudDecisionInvalidError);
    expect(dreDecisionSchema.safeParse({ action: "observe", content: 123, confidence: 0.5 }).success).toBe(false);
  });
});
