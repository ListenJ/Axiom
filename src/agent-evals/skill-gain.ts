/**
 * 技能增益反馈（skill-gain）：只注入「经评测验证有增益」的技能。
 *
 * 设计（深模块）：
 *  - baseline 按任务族记录无注入时的通过率；
 *  - injection 按技能记录注入后的任务通过情况；
 *  - shouldInject(skillId, family)：无记录 → 允许试用；有记录且注入通过率低于
 *    该族基线通过率（-0.1 容差）→ 不注入（负增益过滤）；否则注入。
 *  - 持久化 data/skill-gain.json（容错，失败不阻断）。
 */
import fs from "node:fs";
import path from "node:path";
import type { TaskFamily } from "./tasks.js";
import type { TaskResult } from "./metrics.js";

interface Persisted {
  baseline: Record<string, { count: number; pass: number }>;
  injection: Record<string, { count: number; pass: number }>;
}

export interface GainSummary {
  skillId: string;
  injectedRate: number | null;
  baselineRate: number | null;
  gain: number | null; // 注入通过率 - 基线通过率（百分点）
  samples: number;
}

export interface SkillGainStore {
  load(): Persisted | null;
  save(data: Persisted): void;
}

export function createFileGainStore(filePath = "data/skill-gain.json"): SkillGainStore {
  return {
    load() {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return sanitizeGain(raw);
      } catch {
        return null;
      }
    },
    save(data) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    },
  };
}

let defaultTracker: SkillGainTracker | undefined;
/** 进程级默认增益跟踪器（评测流程共用，懒加载）。 */
export function getDefaultGainTracker(): SkillGainTracker {
  return (defaultTracker ??= new SkillGainTracker({ store: createFileGainStore() }));
}

/** 消毒持久化数据：丢弃非法计数（非负整数、pass<=count），损坏字段静默忽略。 */
function sanitizeGain(raw: unknown): Persisted {
  const out: Persisted = { baseline: {}, injection: {} };
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  const clean = (obj: unknown): Record<string, { count: number; pass: number }> => {
    const res: Record<string, { count: number; pass: number }> = {};
    if (typeof obj !== "object" || obj === null) return res;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "object" || v === null) continue;
      const { count, pass } = v as Record<string, unknown>;
      if (
        typeof count === "number" && Number.isInteger(count) && count >= 0 &&
        typeof pass === "number" && Number.isInteger(pass) && pass >= 0 && pass <= count
      ) {
        res[k] = { count, pass };
      }
    }
    return res;
  };
  out.baseline = clean(r.baseline);
  out.injection = clean(r.injection);
  return out;
}

export class SkillGainTracker {
  private baseline = new Map<string, { count: number; pass: number }>();
  private injection = new Map<string, { count: number; pass: number }>();

  constructor(private readonly deps: { store?: SkillGainStore } = {}) {
    try {
      const persisted = deps.store?.load() ?? null;
      if (persisted) {
        for (const [family, v] of Object.entries(persisted.baseline)) this.baseline.set(family, v);
        for (const [skillId, v] of Object.entries(persisted.injection)) this.injection.set(skillId, v);
      }
    } catch {
      // 读取失败不阻断
    }
  }

  /** 记录一次无注入任务的通过情况（按任务族） */
  recordBaseline(family: TaskFamily, passed: boolean): void {
    const cur = this.baseline.get(family) ?? { count: 0, pass: 0 };
    cur.count++;
    if (passed) cur.pass++;
    this.baseline.set(family, cur);
    this.persist();
  }

  /** 记录一次技能注入任务的通过情况 */
  recordInjection(skillId: string, passed: boolean): void {
    const cur = this.injection.get(skillId) ?? { count: 0, pass: 0 };
    cur.count++;
    if (passed) cur.pass++;
    this.injection.set(skillId, cur);
    this.persist();
  }

  /** 该技能相对该任务族基线的增益（百分点）；样本不足或无基线返回 null */
  gainOf(skillId: string, family: TaskFamily): number | null {
    const inj = this.injection.get(skillId);
    const base = this.baseline.get(family);
    if (!inj || inj.count === 0) return null;
    if (!base || base.count === 0) return null; // 无基线 → 增益未知（勿用自引用回退压成 0）
    const injectedRate = inj.pass / inj.count;
    const baselineRate = base.pass / base.count;
    return Math.round((injectedRate - baselineRate) * 1000) / 10;
  }

  /**
   * 是否允许注入（收紧版）：
   *  - auto-induce 高频词技能：要求极强正增益（≥10pp）且样本 ≥20，否则不注入（跨族上下文噪声）；
   *  - auto-fix 方法论技能：样本 <3 允许试用；样本 ≥3 要求严格正增益。
   */
  shouldInject(skillId: string, family: TaskFamily): boolean {
    const inj = this.injection.get(skillId);
    const base = this.baseline.get(family);
    if (skillId.startsWith("auto-induce-")) {
      // 高频词技能（术语共现产物，非方法论）：要求极强正增益（>=10pp）且样本 >=20 才注入
      if (!inj || inj.count < 20) return false;
      if (!base || base.count === 0) return false; // 无基线无法证明极强正增益 → 宁缺毋滥
      const injectedRate = inj.pass / inj.count;
      const baselineRate = base.pass / base.count;
      return injectedRate - baselineRate >= 0.1;
    }
    if (!inj || inj.count < 3) {
      return true; // auto-fix 方法论技能允许试用
    }
    if (!base || base.count === 0) {
      // 无基线：契约「无记录 → 允许试用」——有通过样本即注入，全败不注入
      // （修复：旧自引用回退 baselineRate=injectedRate 把增益恒压 0，永远拒绝）
      return inj.pass > 0;
    }
    const injectedRate = inj.pass / inj.count;
    const baselineRate = base.pass / base.count;
    return injectedRate > baselineRate;
  }

  /**
   * 从评测结果批量记录增益反馈（能力口径）：执行错误（限流/传输等 provider 侧故障）
   * 不计入基线/注入样本——与 metrics.ts 的 capability-denominated 口径一致。
   */
  recordFromResults(baselineResults: readonly TaskResult[], evolvedResults: readonly TaskResult[]): void {
    for (const r of baselineResults) {
      if (r.executionError) continue;
      this.recordBaseline(r.family, r.passed);
    }
    for (const r of evolvedResults) {
      if (r.executionError) continue;
      for (const skillId of r.injectedSkills ?? []) this.recordInjection(skillId, r.passed);
    }
  }

  listGain(family: TaskFamily): GainSummary[] {
    return [...this.injection.keys()].map((skillId) => {
      const inj = this.injection.get(skillId)!;
      const base = this.baseline.get(family);
      return {
        skillId,
        injectedRate: Math.round((inj.pass / inj.count) * 1000) / 10,
        baselineRate: base && base.count > 0 ? Math.round((base.pass / base.count) * 1000) / 10 : null,
        gain: this.gainOf(skillId, family),
        samples: inj.count,
      };
    });
  }

  private persist(): void {
    try {
      this.deps.store?.save({
        baseline: Object.fromEntries(this.baseline),
        injection: Object.fromEntries(this.injection),
      });
    } catch {
      // 持久化失败不阻断
    }
  }
}
