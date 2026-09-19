/**
 * 轨迹保留策略：体积 × 时间 × 会话（联合会话处理）
 *
 * 为什么需要：方案 C 要把轨迹持久化到磁盘，而 `real-usage` 的 JSONL 是**纯追加、无上限**。
 * 只落盘不设限 = 把 B3-Medium 修掉的"内存无界增长"（见 `tests/agent-trace-bounded.test.ts`）
 * 换个地方复发。故持久化与保留策略必须同时上线。
 *
 * ## 语义（用户裁定：体积 + 时间 + 会话，精细化）
 *
 * 1. **会话原子**：同一 `sessionId` 的记录**整组保留或整组淘汰**，绝不拆散。
 *    理由：回看一个会话时只看到半截，比看不到更糟。
 * 2. **时间维度**：最后活动时间早于 `now - retentionMs` 的会话整组淘汰。
 * 3. **体积维度**：仍超出 `maxBytes` 时，按会话最后活动时间**从旧到新**整组淘汰。
 * 4. **会话豁免**：最后活动在 `activeWindowMs` 内的会话**不被体积规则淘汰** ——
 *    正在进行的对话不该因为文件变大而被削掉尾巴。
 * 5. **下限只约束体积**：`minKeepRecords` 防止体积裁剪把日志压到不可用；
 *    但**不**阻止时间淘汰 —— 否则 `retentionMs` 承诺会被静默违背（超窗数据留着不放）。
 * 6. **确定性**：不读系统时钟（`now` 为入参）、不用 `localeCompare`
 *    （同 `lastActivity` 时按 unitKey **码元序** tie-break），故同输入必得同输出。
 *
 * 本模块是**纯函数**：不碰文件系统。文件重写由调用方负责（见 `compactTraceFile` 待接）。
 */

/** 参与保留判定所需的最小记录形状（其余字段原样保留） */
export interface RetentionRecord {
  id: string;
  /** 会话标识；缺省时该记录作为**独立单元**参与 */
  sessionId?: string;
  /** 最后活动时间（毫秒）。缺省视为 0（极旧） */
  timestamp?: number;
  [key: string]: unknown;
}

export interface RetentionPolicy {
  /** 文件体积上限（字节） */
  maxBytes: number;
  /** 保留窗口（毫秒）：最后活动早于此的会话整组淘汰 */
  retentionMs: number;
  /** 活跃窗口（毫秒）：窗口内的会话不被体积规则淘汰 */
  activeWindowMs: number;
  /** 体积裁剪的记录数下限（不影响时间淘汰） */
  minKeepRecords: number;
}

export interface RetentionOutcome {
  /** 保留的记录（**保持输入顺序**） */
  keep: RetentionRecord[];
  /** 淘汰的记录（**保持输入顺序**） */
  drop: RetentionRecord[];
  bytesBefore: number;
  bytesAfter: number;
  /** 因时间窗口淘汰的记录数 */
  droppedByTime: number;
  /** 因体积上限淘汰的记录数 */
  droppedBySize: number;
}

/** 单条记录的落盘字节数（含换行，与实际 JSONL 写法一致） */
export function recordBytes(record: RetentionRecord): number {
  return Buffer.byteLength(JSON.stringify(record) + "\n", "utf8");
}

interface Unit {
  key: string;
  indices: number[];
  lastActivity: number;
  bytes: number;
  count: number;
}

/**
 * 切分保留集合。纯函数：不读时钟、不碰文件系统、不改入参。
 */
export function selectRetained(
  records: readonly RetentionRecord[],
  policy: RetentionPolicy,
  now: number,
): RetentionOutcome {
  const bytesBefore = records.reduce((sum, r) => sum + recordBytes(r), 0);

  // ---- 归组：会话原子 ----
  const units = new Map<string, Unit>();
  records.forEach((record, index) => {
    // 's:' / 'o:' 前缀避免「无 sessionId 的记录 id」与真实 sessionId 撞名
    const key = record.sessionId ? `s:${record.sessionId}` : `o:${record.id}`;
    const ts = typeof record.timestamp === "number" ? record.timestamp : 0;
    let unit = units.get(key);
    if (!unit) {
      unit = { key, indices: [], lastActivity: ts, bytes: 0, count: 0 };
      units.set(key, unit);
    }
    unit.indices.push(index);
    unit.bytes += recordBytes(record);
    unit.count += 1;
    if (ts > unit.lastActivity) unit.lastActivity = ts;
  });

  // ---- 时间维度：超窗整组淘汰 ----
  const dropped = new Set<string>();
  const timeCutoff = now - policy.retentionMs;
  for (const unit of units.values()) {
    if (unit.lastActivity < timeCutoff) dropped.add(unit.key);
  }

  let keptBytes = bytesBefore;
  let keptCount = records.length;
  for (const key of dropped) {
    const unit = units.get(key)!;
    keptBytes -= unit.bytes;
    keptCount -= unit.count;
  }
  const droppedByTime = records.length - keptCount;

  // ---- 体积维度：按会话最后活动时间从旧到新整组淘汰 ----
  let droppedBySize = 0;
  const activeCutoff = now - policy.activeWindowMs;
  while (keptBytes > policy.maxBytes) {
    const candidates: Unit[] = [];
    for (const unit of units.values()) {
      if (dropped.has(unit.key)) continue;
      // 4. 会话豁免：活跃会话不动
      if (unit.lastActivity >= activeCutoff) continue;
      // 5. 下限只约束体积
      if (keptCount - unit.count < policy.minKeepRecords) continue;
      candidates.push(unit);
    }
    if (candidates.length === 0) break; // 全被豁免/触底 → 宁可超限，不再削

    // 6. 确定性排序：lastActivity 升序，其次 unitKey 码元序
    candidates.sort((a, b) => {
      if (a.lastActivity !== b.lastActivity) return a.lastActivity - b.lastActivity;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    const victim = candidates[0]!;
    dropped.add(victim.key);
    keptBytes -= victim.bytes;
    keptCount -= victim.count;
    droppedBySize += victim.count;
  }

  const keep: RetentionRecord[] = [];
  const drop: RetentionRecord[] = [];
  records.forEach((record, index) => {
    const key = record.sessionId ? `s:${record.sessionId}` : `o:${record.id}`;
    if (dropped.has(key)) drop.push(record);
    else keep.push(record);
    void index;
  });

  return {
    keep,
    drop,
    bytesBefore,
    bytesAfter: keptBytes,
    droppedByTime,
    droppedBySize,
  };
}

// ============================================================================
// 场景自适应：策略推导（切片 A3d）
// ============================================================================

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const HOUR = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR;

/**
 * 推导用的阈值与边界。**具名常量**（不散落魔法数），改动只在此处。
 *
 * 取值理由：本系统跑在**用户本机**（无运维兜底），故以"磁盘不会被日志撑爆"
 * 为第一约束 —— 体积上限取可用空间的 1% 并夹在 [4 MiB, 256 MiB]：
 * 下夹保证日志仍可用，上夹保证磁盘再大也不会无界增长。
 */
export const POLICY_BOUNDS = {
  maxBytesFloor: 4 * MIB,
  maxBytesCeiling: 256 * MIB,
  minKeepFloor: 50,
  minKeepCeiling: 2000,
  /** 可用空间低于此值 → 临界档（保留窗口收到最短） */
  freeDiskCriticalBytes: 2 * GIB,
  /** 可用空间低于此值（但不低于临界）→ 紧张档 */
  freeDiskTightBytes: 10 * GIB,
  /** 体积上限 = 可用空间 / 该除数（1%） */
  freeDiskShareDivisor: 100,
  /** 每会话为下限预留的记录数 */
  recordsPerSessionForMinKeep: 10,
  /** 平均每会话记录数超过此值 → 视为"高密度对话"，收窄豁免窗口 */
  densePerSessionThreshold: 50,
  retentionDaysNormal: 90,
  retentionDaysTight: 30,
  retentionDaysCritical: 7,
  activeWindowMsNormal: 24 * HOUR,
  activeWindowMsDense: 12 * HOUR,
} as const;

/** 推导策略所需的**可观测输入**。调用方负责采集（副作用在边界上），并应记录以便复现。 */
export interface RetentionSignals {
  /** 当前日志文件字节数 */
  fileBytes: number;
  /** 当前记录条数 */
  recordCount: number;
  /** 涉及的不同会话数 */
  sessionCount: number;
  /** 所在卷的可用字节数（如 `fs.statfsSync(dir)` 的 `bavail * bsize`） */
  freeDiskBytes: number;
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}

/**
 * 由**场景信号**推导保留策略。**纯函数**：不读时钟、不碰文件系统、无随机。
 *
 * 与确定性的关系（重要）：自适应本身会让"何时跑"影响"留下哪些记录"。
 * 本模块的做法是把副作用**挡在边界外** —— 这里只做 signals → policy 的纯映射，
 * 因此**只要 signals 相同，policy 必相同**；调用方记录 signals 即可完整复现一次裁剪决策。
 */
/**
 * 由可用空间推导体积上限（可用空间的 1%，夹在 [4 MiB, 256 MiB]）。
 * 单独抽出的原因：**廉价探测**只需这一项即可判断"值不值得全量扫描"，
 * 不必为此构造完整的 `RetentionSignals`（那需要先解析整个文件）。
 */
export function resolveMaxBytes(freeDiskBytes: number): number {
  const free = Number.isFinite(freeDiskBytes) && freeDiskBytes > 0 ? freeDiskBytes : 0;
  return clampInt(
    Math.floor(free / POLICY_BOUNDS.freeDiskShareDivisor),
    POLICY_BOUNDS.maxBytesFloor,
    POLICY_BOUNDS.maxBytesCeiling,
  );
}

export function resolvePolicy(signals: RetentionSignals): RetentionPolicy {
  const free = Number.isFinite(signals.freeDiskBytes) && signals.freeDiskBytes > 0
    ? signals.freeDiskBytes
    : 0;

  // 1) 磁盘压力分档 → 保留窗口
  const retentionDays =
    free < POLICY_BOUNDS.freeDiskCriticalBytes
      ? POLICY_BOUNDS.retentionDaysCritical
      : free < POLICY_BOUNDS.freeDiskTightBytes
        ? POLICY_BOUNDS.retentionDaysTight
        : POLICY_BOUNDS.retentionDaysNormal;

  // 2) 体积上限 = 可用空间 1%，夹在 [4 MiB, 256 MiB]
  const maxBytes = resolveMaxBytes(free);

  // 3) 记录下限随会话数缩放（会话多则多留，保证每个会话都有样本）
  const sessions = Number.isFinite(signals.sessionCount) && signals.sessionCount > 0
    ? Math.floor(signals.sessionCount)
    : 0;
  const minKeepRecords = clampInt(
    sessions * POLICY_BOUNDS.recordsPerSessionForMinKeep,
    POLICY_BOUNDS.minKeepFloor,
    POLICY_BOUNDS.minKeepCeiling,
  );

  // 4) 活跃豁免窗口随"记录密度"调整：高密度对话收窄窗口，避免豁免把文件顶在上限之上
  const records = Number.isFinite(signals.recordCount) && signals.recordCount > 0
    ? signals.recordCount
    : 0;
  const perSession = sessions > 0 ? records / sessions : records;
  const activeWindowMs =
    perSession > POLICY_BOUNDS.densePerSessionThreshold
      ? POLICY_BOUNDS.activeWindowMsDense
      : POLICY_BOUNDS.activeWindowMsNormal;

  return {
    maxBytes,
    retentionMs: retentionDays * DAY_MS,
    activeWindowMs,
    minKeepRecords,
  };
}


// ============================================================================
// 压实触发决策（切片 A3b 后半：精细化触发）
// ============================================================================

/**
 * 触发参数默认值。**具名常量**，可经 opts 覆盖（精细化调节）。
 *
 * `triggerRatio = 0.8`：体积达到**上限的 80%** 才考虑压实 —— 留 20% 余量，
 *   避免压完很快又触到上限而反复重写。
 * `cooldownMs = 10 分钟`：持续高压下若每批都压实，CPU/IO 会被打满而收益递减。
 */
export const COMPACTION_TRIGGER_DEFAULTS = {
  triggerRatio: 0.8,
  cooldownMs: 10 * 60 * 1000,
} as const;

/** 廉价探测所需的输入：**只需两次系统调用**（statSync 体积 + statfsSync 可用空间） */
export interface CompactionTriggerSignals {
  fileBytes: number;
  freeDiskBytes: number;
  /** 当前时间（毫秒）——入参而非读时钟，保证可复现 */
  now: number;
  /** 上次压实时间；null = 从未压过 */
  lastCompactionAt: number | null;
}

export interface CompactionDecision {
  compact: boolean;
  reason: "below-threshold" | "cooldown" | "trigger";
  /** 由可用空间推导出的体积上限 */
  effectiveMaxBytes: number;
  /** 触发阈值 = floor(上限 × triggerRatio) */
  thresholdBytes: number;
}

/**
 * 判定"该不该压实"。**纯函数**：不读时钟、不碰文件系统、无随机。
 *
 * 判定顺序（冷却优先于阈值）：冷却期内即便超阈值也不压，避免高压下反复重写。
 */
export function decideCompaction(
  signals: CompactionTriggerSignals,
  opts?: { triggerRatio?: number; cooldownMs?: number },
): CompactionDecision {
  const effectiveMaxBytes = resolveMaxBytes(signals.freeDiskBytes);

  const rawRatio = opts?.triggerRatio ?? COMPACTION_TRIGGER_DEFAULTS.triggerRatio;
  const triggerRatio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0.01, rawRatio)) : COMPACTION_TRIGGER_DEFAULTS.triggerRatio;
  const thresholdBytes = Math.floor(effectiveMaxBytes * triggerRatio);

  const cooldownMs = opts?.cooldownMs ?? COMPACTION_TRIGGER_DEFAULTS.cooldownMs;
  if (
    signals.lastCompactionAt !== null &&
    Number.isFinite(signals.lastCompactionAt) &&
    signals.now - signals.lastCompactionAt < cooldownMs
  ) {
    return { compact: false, reason: "cooldown", effectiveMaxBytes, thresholdBytes };
  }

  const fileBytes = Number.isFinite(signals.fileBytes) && signals.fileBytes > 0 ? signals.fileBytes : 0;
  if (fileBytes < thresholdBytes) {
    return { compact: false, reason: "below-threshold", effectiveMaxBytes, thresholdBytes };
  }
  return { compact: true, reason: "trigger", effectiveMaxBytes, thresholdBytes };
}
