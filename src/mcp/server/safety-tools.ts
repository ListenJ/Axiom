/**
 * S4 HITL 真值标注管道 — hallucination_feedback MCP 工具
 * （docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S4）
 *
 * P1-S5 校准债最后一环：verdict 持久化 + 保守自动校准已落（src/db/hallucination-verdicts.ts），
 * 人工真值无入口。本工具为 hallucination_verdicts 行写入人工真值 label
 * （1=事实 / 0=幻觉），calibrateFromStored 优先取有 label 的对（label 即真值）。
 *
 * 注册方式与同目录 *-tools.ts 一致：server.ts 调 registerSafetyTools(registry, db)，
 * 经 ToolRegistry.add 自动获得 HardFloor/权限守卫包裹（integration 层允许 import db）。
 */
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { ToolRegistry } from "../tool-registry.js";
import { setLabel } from "../../db/hallucination-verdicts.js";

/** 入参 zod raw shape（MCP inputSchema 与 handler 内 safeParse 共用同一份） */
const hallucinationFeedbackSchema = {
  verdictId: z.number().int().describe("hallucination_verdicts 行 id"),
  isFact: z.boolean().describe("人工真值：true=事实 / false=幻觉"),
  note: z.string().optional().describe("可选备注（仅审计日志，不落库）"),
};

export function registerSafetyTools(registry: ToolRegistry, db: Database): void {
  registry.add({
    name: "hallucination_feedback",
    description:
      "HITL 真值标注：为幻觉判定记录（hallucination_verdicts）写入人工真值标签" +
      "（label 1=事实 / 0=幻觉），校准管道优先采用；吞错不抛出",
    inputSchema: hallucinationFeedbackSchema,
    handler: async (args) => {
      const parsed = z.object(hallucinationFeedbackSchema).safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          success: false,
          error: `invalid input: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "rejected"}`,
        };
      }
      const { verdictId, isFact, note } = parsed.data;
      const result = setLabel(db, verdictId, isFact, note);
      if (!result) {
        return { success: false, id: verdictId, error: "setLabel not applied (verdict missing or db error)" };
      }
      return { success: true, id: result.id, label: result.label };
    },
  });
}
