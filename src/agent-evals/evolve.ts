/**
 * 评测 → 进化闭环（方向乙最终验证）。
 *
 * 从 train 分片评测结果构造任务轨迹 → selfInduce 确定性归纳（术语共现+成功率门槛）
 * → promoteInductionsToSkills 注册为 auto-induce-* 可调用技能（SkillRegistry + 磁盘持久化）。
 * 无 LLM 调用，纯逻辑可离线运行。
 */
import { createDefaultSelfEvolve } from "../self-evolve/index.js";
import { promoteInductionsToSkills } from "../self-evolve/skill-promotion.js";
import type { TaskTrace } from "../self-evolve/types.js";
import type { TaskResult } from "./metrics.js";
import type { AgentTask, TaskFamily } from "./tasks.js";

export interface EvolveResult {
  /** 新注册的技能 id 列表 */
  created: string[];
  /** 归纳出的模式数量 */
  inductionCount: number;
  /** 作为经验源的 train 轨迹数 */
  traceCount: number;
}

/**
 * 从评测结果归纳并注册技能。
 * @param results 评测结果（train 分片作为进化经验源）
 * @param tasks   全部任务定义（用于把 taskId 映射回 prompt）
 * @param family  可选：只进化指定任务族
 */
export function evolveFromResults(
  results: TaskResult[],
  tasks: AgentTask[],
  family?: TaskFamily,
): EvolveResult {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const traces: TaskTrace[] = results
    .filter((r) => r.split === "train" && (!family || r.family === family))
    .map((r) => ({
      id: r.taskId,
      task: taskById.get(r.taskId)?.prompt ?? r.taskId,
      success: r.passed,
    }));

  const engine = createDefaultSelfEvolve();
  const inductions = engine.selfInduce(traces, 10);
  const created = promoteInductionsToSkills(inductions);
  return { created, inductionCount: inductions.length, traceCount: traces.length };
}
