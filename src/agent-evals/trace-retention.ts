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
