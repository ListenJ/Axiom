/**
 * 幻觉判定持久化与校准数据积累 — S5（2026-08-29，docs/superpowers/specs/2026-08-29-p1-lift-design.md §S5）
 *
 * P0-C 校准债：双缝 verify（缝① chat / 缝② DRE）已运行但 verdict 未持久化，
 * calibrate（hallucination-detector）零数据 → 共形 p-value 判别力锁死。本模块：
 *
 *   1. `hallucination_verdicts` 表（migrate.ts 纳管同一 DDL；ensure 幂等；S4 增
 *      `label INTEGER` 列：0=幻觉 / 1=事实 / null=未标注，存量库幂等补列）
 *   2. recordHallucinationVerdict：两缝 verdict 落库（吞错，不阻塞响应/推理链）
 *   3. setLabel：HITL 人工真值标注落库（S4 hallucination_feedback 工具数据面）
 *   4. calibrateFromStored：优先取有 label 的对（label 即真值，S4 HITL 优先）；
 *      无 label 对仍走极化组保守策略（数据不足跳过）
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
  /** HITL 真值标签：1=事实 / 0=幻觉 / null=未标注 */
  label: number | null;
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
      label INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  ensureLabelColumn(db);
  db.run(`CREATE INDEX IF NOT EXISTS idx_halluc_verdict_fingerprint ON hallucination_verdicts(evidence_fingerprint)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_halluc_verdict_created ON hallucination_verdicts(created_at DESC)`);
}

/**
 * 幂等补列（S4）：存量库缺 `label` 列时 ALTER TABLE 补齐（CREATE TABLE IF NOT EXISTS
 * 不会改已有表结构）。新库建表已含 label，此处为无操作。
 */
function ensureLabelColumn(db: Database): void {
  const cols = db.query("PRAGMA table_info(hallucination_verdicts)").all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === "label")) return;
  db.run("ALTER TABLE hallucination_verdicts ADD COLUMN label INTEGER");
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

/** 读取落库 verdict（最新在前；吞错返回空数组）。opts.hasLabel 可按是否已标注过滤。 */
export function readHallucinationVerdicts(
  db: Database,
  limit = 1000,
  opts?: { hasLabel?: boolean },
): StoredVerdictRow[] {
  try {
    ensureHallucinationVerdictsTable(db);
    const labelFilter = opts?.hasLabel === true ? "WHERE label IS NOT NULL"
      : opts?.hasLabel === false ? "WHERE label IS NULL"
      : "";
    return db
      .query(
        `SELECT id, statement_digest, statement, p_value, verdict, is_accepted,
                evidence_fingerprint, seam, label, created_at
         FROM hallucination_verdicts ${labelFilter} ORDER BY id DESC LIMIT ?`,
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
 * HITL 真值标注落库（S4 hallucination_feedback 工具数据面）。
 *
 * label 语义：isFact=true → 1（事实）；isFact=false → 0（幻觉）。人工 label 是真值，
 * 优先级高于自动判定的 is_accepted（calibrateFromStored 以 label 为准）。
 * note 为可选备注：仅入审计日志，不落库（本迭代 label 单列，无备注列）。
 *
 * 吞错：行不存在 / 库不可用等任何失败仅 logger.debug 并返回 null，不向上抛。
 *
 * @returns 成功返回 { id, label }；失败返回 null。
 */
export function setLabel(db: Database, id: number, isFact: boolean, note?: string): { id: number; label: number } | null {
  try {
    ensureHallucinationVerdictsTable(db);
    const label = isFact ? 1 : 0;
    const changed = db.run("UPDATE hallucination_verdicts SET label = ? WHERE id = ?", [label, id]).changes;
    if (changed === 0) return null;
    if (note !== undefined && note !== "") {
      logger.info("hallucination-verdicts: HITL label set (audit)", { id, label, note });
    }
    return { id, label };
  } catch (err) {
    logger.debug("hallucination-verdicts: setLabel failed (swallowed)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 从落库 verdict 构建校准对并自动校准（S4 起 HITL 真值优先）。
 *
 * ## 标注策略（S4：HITL 优先 + 无 label 极化组保守兜底）
 *
 *   - **有 label 的对（优先）**：label 非空的行直接作为校准对，isFact = (label === 1)。
 *     label 即人工真值，无需极化组对比；label 与 is_accepted 矛盾时以 label 为准。
 *   - **无 label 的对（兜底，保留）**：仍走"极化组"保守策略 —— evidence_fingerprint
 *     相同（同一证据基/同一事实库快照下校验）且组内同时存在 accepted 与非 accepted
 *     判定的记录，组内 accepted → isFact=true，非 accepted → isFact=false。
 *     极化组外（单一结论组）不构成对比信息，一律排除。
 *
 * ## 局限（调用方与维护者须知）
 *
 *   - 无 label 极化对的标签本质上是"证据相似度阈值"的自编码，存在循环性：未校准
 *     运行期 pValue 恒 1.0，判定由 confidence 驱动 → 校准学到的分布与打标信号同源，
 *     统计保证（FDR ≤ α）在此类数据上不严格成立。有 label 对无此局限。
 *   - HITL 真值入口为 hallucination_feedback MCP 工具（src/mcp/server/safety-tools.ts），
 *     真值积累依赖人工标注量；标注不足时本函数仍以极化兜底维持"真实形状"的输入。
 *
 * @returns 校准质量（detector.getCalibrationQuality()）；对 < minPairs 或读库
 *          失败时返回 null（跳过，logger.debug），不抛错。
 */
export function calibrateFromStored(
  db: Database,
  detector: ConformalHallucinationDetector,
  minPairs: number = MIN_CALIBRATION_PAIRS,
): CalibrationQuality | null {
  let rows: Array<{ statement: string | null; is_accepted: number; evidence_fingerprint: string; label: number | null }>;
  try {
    ensureHallucinationVerdictsTable(db);
    rows = db
      .query(
        `SELECT statement, is_accepted, evidence_fingerprint, label
         FROM hallucination_verdicts
         WHERE statement IS NOT NULL AND TRIM(statement) != ''
         ORDER BY id DESC LIMIT ?`,
      )
      .all(CALIBRATION_READ_LIMIT) as Array<{ statement: string | null; is_accepted: number; evidence_fingerprint: string; label: number | null }>;
  } catch (err) {
    logger.debug("calibrateFromStored: read failed, skip", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const pairs: CalibrationPair[] = [];

  // 优先：有 label 的行直接定真值（无需极化组对比）
  const unlabeled: Array<{ statement: string; isAccepted: boolean; fingerprint: string }> = [];
  for (const r of rows) {
    if (r.label === null || r.label === undefined) {
      unlabeled.push({
        statement: r.statement ?? "",
        isAccepted: r.is_accepted !== 0,
        fingerprint: r.evidence_fingerprint,
      });
      continue;
    }
    pairs.push({ statement: r.statement ?? "", isFact: r.label === 1 });
  }

  // 兜底：无 label 行按证据指纹分组，仅保留极化组（同证据基下 accepted 与非 accepted 并存）
  const groups = new Map<string, Array<{ statement: string; isAccepted: boolean }>>();
  for (const r of unlabeled) {
    const list = groups.get(r.fingerprint) ?? [];
    list.push({ statement: r.statement, isAccepted: r.isAccepted });
    groups.set(r.fingerprint, list);
  }
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
