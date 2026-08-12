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
        if (typeof raw !== "object" || raw === null) return null;
        return {
          baseline: raw.baseline ?? {},
          injection: raw.injection ?? {},
        } as Persisted;
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
    const injectedRate = inj.pass / inj.count;
    const baselineRate = base && base.count > 0 ? base.pass / base.count : injectedRate;
    return Math.round((injectedRate - baselineRate) * 1000) / 10;
  }

  /** 是否允许注入：无记录 → 试用；负增益（< -10pp）→ 禁止 */
  shouldInject(skillId: string, family: TaskFamily): boolean {
    const gain = this.gainOf(skillId, family);
    if (gain === null) return true;
    return gain >= -10;
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
