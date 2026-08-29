/**
 * 幻觉判定持久化与校准数据积累 — S5（2026-08-29，docs/superpowers/specs/2026-08-29-p1-lift-design.md §S5）
 *
 * P0-C 校准债：双缝 verify（缝① chat / 缝② DRE）已运行但 verdict 未持久化，
 * calibrate（hallucination-detector）零数据 → 共形 p-value 判别力锁死。本模块：
 *
 *   1. `hallucination_verdicts` 表（migrate.ts 纳管同一 DDL；ensure 幂等）
 *   2. recordHallucinationVerdict：两缝 verdict 落库（吞错，不阻塞响应/推理链）
 *   3. calibrateFromStored：从落库 verdict 保守自动校准（数据不足跳过）
 *
 * 架构边：memory / dre 不 import db —— 缝① chat 侧 routes→db 直调（既有方向）；
 * 缝② dre 侧经 DREConfig.recordVerdict 端口由组合根（main.ts）注入适配器，dre 包
 * 不直引 db 层（与 P0-C hallucinationGate 注入同模式）。本模块仅 `import type`
 * detector 类型（零运行时依赖，db→memory 单向类型引用）。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import type {
  CalibrationPair,
  CalibrationQuality,
  ConformalHallucinationDetector,
} from "../memory/hallucination-detector.js";

/** statement 摘要输入上限（与 hallucination-detector VERIFY_STATEMENT_MAX_CHARS 对齐） */
const STATEMENT_MAX_CHARS = 2000;

/** evidence 指纹取排序后前 N 条拼接（防超长证据列表撑爆哈希输入） */
const EVIDENCE_FINGERPRINT_MAX_ITEMS = 8;

/** 校准默认最小对数：低于该值自动校准跳过（保守起步，避免小样本噪声） */
export const MIN_CALIBRATION_PAIRS = 50;

/** calibrateFromStored 单次读取上限（防全表载入内存） */
const CALIBRATION_READ_LIMIT = 5000;

export interface HallucinationVerdictInput {
  /** 被校验的陈述原文（落库截断到 STATEMENT_MAX_CHARS；摘要对其前缀取哈希） */
  statement: string;
  /** 本次校验使用的证据文本列表（指纹 = 排序后前 N 条拼接的 sha256） */
  evidenceTexts: string[];
  pValue: number;
  verdict: string;
  isAccepted: boolean;
  /** 缝来源："chat" | "dre" */
  seam: string;
}

export interface StoredVerdictRow {
  id: number;
  statement_digest: string;
  statement: string | null;
  p_value: number;
  verdict: string;
  is_accepted: number;
  evidence_fingerprint: string;
  seam: string | null;
  created_at: number;
}

/** statement_digest = sha256(statement.slice(0, 2000)) */
export function computeStatementDigest(statement: string): string {
  return createHash("sha256").update(statement.slice(0, STATEMENT_MAX_CHARS)).digest("hex");
}

/** evidence_fingerprint = sha256(排序后 evidence text 前 N 项以换行拼接)，与输入顺序无关 */
export function computeEvidenceFingerprint(evidenceTexts: string[]): string {
  const sorted = evidenceTexts
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter((t) => t.length > 0)
    .sort();
  return createHash("sha256")
    .update(sorted.slice(0, EVIDENCE_FINGERPRINT_MAX_ITEMS).join("\n"))
    .digest("hex");
}

/** 建表（幂等）。与 src/db/migrate.ts 纳管的 DDL 保持一致。 */
export function ensureHallucinationVerdictsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS hallucination_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      statement_digest TEXT NOT NULL,
      statement TEXT,
      p_value REAL NOT NULL,
      verdict TEXT NOT NULL,
      is_accepted INTEGER NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      seam TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_halluc_verdict_fingerprint ON hallucination_verdicts(evidence_fingerprint)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_halluc_verdict_created ON hallucination_verdicts(created_at DESC)`);
}

/**
 * 落库单条 verdict（吞错：任何失败仅 logger.debug，不向上抛 —— 调用方位于
 * 响应路径/推理降级链上，落库属可观测附属动作，不得阻塞主流程）。
 */
export function recordHallucinationVerdict(db: Database, input: HallucinationVerdictInput): void {
  try {
    ensureHallucinationVerdictsTable(db);
    db.run(
      `INSERT INTO hallucination_verdicts
         (statement_digest, statement, p_value, verdict, is_accepted, evidence_fingerprint, seam, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        computeStatementDigest(input.statement ?? ""),
        (input.statement ?? "").slice(0, STATEMENT_MAX_CHARS),
        Number.isFinite(input.pValue) ? input.pValue : 1,
        input.verdict ?? "accepted",
        input.isAccepted ? 1 : 0,
        computeEvidenceFingerprint(Array.isArray(input.evidenceTexts) ? input.evidenceTexts : []),
        input.seam ?? null,
        Math.floor(Date.now() / 1000),
      ],
    );
  } catch (err) {
    logger.debug("hallucination-verdicts: record failed (swallowed)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 读取落库 verdict（最新在前；吞错返回空数组）。 */
export function readHallucinationVerdicts(db: Database, limit = 1000): StoredVerdictRow[] {
  try {
    ensureHallucinationVerdictsTable(db);
    return db
      .query(
        `SELECT id, statement_digest, statement, p_value, verdict, is_accepted,
                evidence_fingerprint, seam, created_at
         FROM hallucination_verdicts ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as StoredVerdictRow[];
  } catch (err) {
    logger.debug("hallucination-verdicts: read failed (swallowed)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * 从落库 verdict 保守自动校准（半自动标注，非真值标注 —— 局限声明）。
 *
 * ## 标注策略（保守起步）
 *
 * 仅纳入"极化组"：evidence_fingerprint 相同（即同一证据基/同一事实库快照下校验）
 * 且组内同时存在 accepted 与非 accepted 判定的记录 —— 任务书所称"pValue 极端分化的
 * 对比"的可操作代理。组内 accepted → isFact=true，非 accepted → isFact=false。
 * 极化组外（单一结论组）不构成对比信息，一律排除。
 *
 * ## 局限（调用方与维护者须知）
 *
 *   - 未校准运行期 pValue 恒 1.0，判定由证据相似度（confidence 阈值）驱动 → 本策略
 *     的标签本质上是"证据相似度阈值"的自编码，存在循环性：校准学到的分布与打标
 *     信号同源，统计保证（FDR ≤ α）在此数据上不严格成立。
 *   - "证据相似度 ≥ 0.5 且用户显式纠正"的真值标注（spec 原案）需要用户反馈通道，
 *     当前无数据源，属后续迭代（HITL / 标注 UI）。
 *   - 因此本函数定位为数据积累期的保守起步：仅让 calibrate 有"真实形状"的输入，
 *     判定仍以 confidence 驱动为主。
 *
 * @returns 校准质量（detector.getCalibrationQuality()）；极化对 < minPairs 或读库
 *          失败时返回 null（跳过，logger.debug），不抛错。
 */
export function calibrateFromStored(
  db: Database,
  detector: ConformalHallucinationDetector,
  minPairs: number = MIN_CALIBRATION_PAIRS,
): CalibrationQuality | null {
  let rows: Array<{ statement: string | null; is_accepted: number; evidence_fingerprint: string }>;
  try {
    ensureHallucinationVerdictsTable(db);
    rows = db
      .query(
        `SELECT statement, is_accepted, evidence_fingerprint
         FROM hallucination_verdicts
         WHERE statement IS NOT NULL AND TRIM(statement) != ''
         ORDER BY id DESC LIMIT ?`,
      )
      .all(CALIBRATION_READ_LIMIT) as Array<{ statement: string | null; is_accepted: number; evidence_fingerprint: string }>;
  } catch (err) {
    logger.debug("calibrateFromStored: read failed, skip", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // 按证据指纹分组，仅保留极化组（同证据基下 accepted 与非 accepted 并存）
  const groups = new Map<string, Array<{ statement: string; isAccepted: boolean }>>();
  for (const r of rows) {
    const list = groups.get(r.evidence_fingerprint) ?? [];
    list.push({ statement: r.statement ?? "", isAccepted: r.is_accepted !== 0 });
    groups.set(r.evidence_fingerprint, list);
  }
  const pairs: CalibrationPair[] = [];
  for (const recs of groups.values()) {
    const hasAccepted = recs.some((r) => r.isAccepted);
    const hasAnomalous = recs.some((r) => !r.isAccepted);
    if (!hasAccepted || !hasAnomalous) continue;
    for (const r of recs) {
      pairs.push({ statement: r.statement, isFact: r.isAccepted });
    }
  }

  if (pairs.length < minPairs) {
    logger.debug("calibrateFromStored: insufficient polarized pairs, skip auto-calibration", {
      pairs: pairs.length,
      minPairs,
    });
    return null;
  }

  detector.calibrate(pairs);
  const quality = detector.getCalibrationQuality();
  logger.info("calibrateFromStored: auto-calibration applied", { pairs: pairs.length, n: quality.n });
  return quality;
}
