/**
 * SkillQualityTracker — 技能质量反馈记录（方向乙：经验→技能 → 可自我修正闭环）。
 *
 * 深模块：调用方只需 recordSkillOutcome / getSkillQuality / listSkillQuality /
 * deprecatedSkillIds；统计与判定规则（累计调用 >= 3 且成功率 < 0.5 → deprecated）
 * 全部藏在内部。依赖可注入（可选 store 持久化），模块自身不创建文件依赖。
 */
import path from "path";
import fs from "fs";

/** 单个 auto-induce-* 技能的质量记录（deprecated 为派生标记，不持久化） */
export interface SkillQualityRecord {
  skillId: string;
  /** 累计调用次数 */
  calls: number;
  /** 累计成功次数 */
  successes: number;
  /** 最近一次使用时间（epoch ms） */
  lastUsedAt: number;
  /** 是否已判定为 deprecated（calls >= 3 且 successes / calls < 0.5） */
  deprecated: boolean;
}

/** 持久化适配器（可选）：load 失败应返回 null，save 失败由调用方容错 */
export interface SkillQualityStore {
  load(): Record<string, { calls: number; successes: number; lastUsedAt: number }> | null;
  save(records: Record<string, { calls: number; successes: number; lastUsedAt: number }>): void;
}

export interface SkillQualityDeps {
  store?: SkillQualityStore;
}

export class SkillQualityTracker {
  private readonly records = new Map<string, { calls: number; successes: number; lastUsedAt: number }>();

  constructor(private readonly deps: SkillQualityDeps = {}) {
    try {
      const persisted = deps.store?.load() ?? null;
      if (persisted) {
        for (const [skillId, r] of Object.entries(persisted)) {
          this.records.set(skillId, { calls: r.calls, successes: r.successes, lastUsedAt: r.lastUsedAt });
        }
      }
    } catch {
      // 读取失败不阻断（退化为空内存记录）
    }
  }

  /** 记录一次技能使用结果（success=true/false）。 */
  recordSkillOutcome(skillId: string, success: boolean): void {
    const current = this.records.get(skillId) ?? { calls: 0, successes: 0, lastUsedAt: 0 };
    current.calls++;
    if (success) current.successes++;
    current.lastUsedAt = Date.now();
    this.records.set(skillId, current);
    try {
      this.deps.store?.save(Object.fromEntries(this.records));
    } catch {
      // 持久化失败不阻断（内存记录已生效）
    }
  }

  /** 读取单个技能的质量记录；无记录返回 undefined。 */
  getSkillQuality(skillId: string): SkillQualityRecord | undefined {
    const r = this.records.get(skillId);
    return r ? { ...r, skillId, deprecated: isDeprecated(r) } : undefined;
  }

  /** 全部质量记录只读快照。 */
  listSkillQuality(): SkillQualityRecord[] {
    return [...this.records.entries()].map(([skillId, r]) => ({
      ...r,
      skillId,
      deprecated: isDeprecated(r),
    }));
  }

  /** 已判定 deprecated 的技能 id 列表（只标记不删除注册，保持幂等）。 */
  deprecatedSkillIds(): string[] {
    return [...this.records.entries()]
      .filter(([, r]) => isDeprecated(r))
      .map(([skillId]) => skillId);
  }
}

/**
 * 轻量文件持久化：data/skill-quality.json。
 * load 对缺失/损坏/非法字段容错（返回 null / 跳过非法记录）；save 由调用方容错。
 *
 * 审计 Low（2026-08-29）：
 * - 路径锚定：默认落点绝对化为 `<cwd>/data/skill-quality.json`（对齐 real-usage.ts 的
 *   data/ 锚定惯例），避免工作目录漂移导致读写分裂；显式传入 filePath 原样使用（测试/自定义落点）。
 * - 原子写：save 先写同目录临时文件再 rename 覆盖，避免同步全量重写中途崩溃留下半截 JSON。
 */
export function createFileQualityStore(filePath?: string): SkillQualityStore {
  const resolvedPath = filePath ?? path.join(process.cwd(), "data", "skill-quality.json");
  return {
    load() {
      try {
        const raw = fs.readFileSync(resolvedPath, "utf-8");
        return sanitizePersisted(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    save(records) {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      const tmpPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), "utf-8");
        fs.renameSync(tmpPath, resolvedPath);
      } catch (e) {
        // 失败时清理临时文件后原样抛出（调用方容错语义不变）
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
        throw e;
      }
    },
  };
}

/** 判定规则：累计调用 >= 3 且成功率 < 0.5。 */
let defaultTracker: SkillQualityTracker | undefined;
/** 进程级默认质量跟踪器：skill-promotion 与 skill_run 共用，保证记录一致（懒加载）。 */
export function getDefaultQualityTracker(): SkillQualityTracker {
  return (defaultTracker ??= new SkillQualityTracker({ store: createFileQualityStore() }));
}

function isDeprecated(r: { calls: number; successes: number }): boolean {
  return r.calls >= 3 && r.successes / r.calls < 0.5;
}

/** 只保留字段合法（非负整数计数、非负时间戳）的记录，损坏数据静默丢弃。 */
function sanitizePersisted(
  raw: unknown,
): Record<string, { calls: number; successes: number; lastUsedAt: number }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, { calls: number; successes: number; lastUsedAt: number }> = {};
  for (const [skillId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const { calls, successes, lastUsedAt } = value as Record<string, unknown>;
    if (!isNonNegativeInt(calls) || !isNonNegativeInt(successes) || !isNonNegativeNumber(lastUsedAt)) continue;
    result[skillId] = { calls, successes, lastUsedAt };
  }
  return result;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
