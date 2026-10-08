/**
 * DRE 组合根注入装配 —— 收敛到 daemon（内核收敛 Step 2b）。
 *
 * `src/dre` 按架构约束不得 import 上层（router / memory / db），故 cloudCaller /
 * hallucinationGate / recordVerdict 只能由组合根注入。内核收敛后 daemon 是唯一
 * Kernel 拥有者，组合根装配随之落在这里。
 *
 * db 采用惰性取值（`getDb`）：注入项在 Kernel 构造时传入，但底层连接要等
 * `kernel.init()` 后才可得，故闭包延迟到调用期解析。
 */
import type { Database } from "bun:sqlite";
import type { DREConfig } from "../dre/engine.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/** 与 DREConfig 的注入缝一致（cloudCaller / hallucinationGate / recordVerdict） */
export type DreCompositionOverrides = Pick<
  Partial<DREConfig>,
  "cloudCaller" | "hallucinationGate" | "recordVerdict"
>;

/**
 * 按当前 env 构建组合根注入项。无 DEEPSEEK_API_KEY 时返回空对象（不注入云降级）。
 */
export async function buildDreCompositionOverrides(
  getDb: () => Database | null,
): Promise<DreCompositionOverrides> {
  if (!readString("DEEPSEEK_API_KEY", "")) return {};
  try {
    const { createDreCloudAdapter } = await import("../router/provider-caller.js");
    const { assessStatement, buildFactBaseFromEvidence } = await import("../memory/hallucination-detector.js");
    const { recordHallucinationVerdict } = await import("../db/hallucination-verdicts.js");
    return {
      cloudCaller: createDreCloudAdapter({
        baseUrl: readString("DEEPSEEK_BASE_URL", ""),
        apiKey: readString("DEEPSEEK_API_KEY", ""),
        model: readString("DEEPSEEK_MODEL", "deepseek-v4-flash"),
      }),
      hallucinationGate: (statement: string, evidence: unknown) => {
        const factBase = buildFactBaseFromEvidence(evidence);
        return factBase.length > 0 ? assessStatement(factBase, statement) : null;
      },
      recordVerdict: (rec) => {
        const db = getDb();
        if (!db) return;
        try {
          recordHallucinationVerdict(db, {
            statement: rec.statement,
            evidenceTexts: buildFactBaseFromEvidence(rec.evidence).map((f) => f.text),
            pValue: rec.pValue,
            verdict: rec.verdict as never,
            isAccepted: rec.isAccepted,
            seam: "dre",
          });
        } catch (err) {
          logger.debug("[daemon] dre verdict record skipped", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    };
  } catch (err) {
    logger.warn("[daemon] 组合根注入装配失败，DRE 以无云降级运行", { error: (err as Error).message });
    return {};
  }
}
