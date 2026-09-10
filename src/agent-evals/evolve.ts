/**
 * 评测 → 进化闭环（方向乙最终验证）。
 *
 * 从 train 分片评测结果构造任务轨迹 → selfInduce 确定性归纳（术语共现+成功率门槛）
 * → promoteInductionsToSkills 注册为 auto-induce-* 可调用技能（SkillRegistry + 磁盘持久化）。
 * 无 LLM 调用，纯逻辑可离线运行。
 */
import { createDefaultSelfEvolve } from "../self-evolve/index.js";
import { getSkillRegistry } from "../skills/skill-registry.js";
import { promoteInductionsToSkills } from "../self-evolve/skill-promotion.js";
import { craftFailureSkills } from "./skill-craft.js";
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
  /** 方法论技能（自检+溯源+路径规划）数量 */
  craftedCount: number;
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

  // 深化：从失败任务提炼「自检+溯源+路径规划」方法论技能（确定性，无 LLM）
  const registry = getSkillRegistry();
  const crafted = craftFailureSkills(
    results,
    tasks,
    (id) => registry.get(id) !== undefined,
    (skill) => {
      registry.register(skill);
      try {
        const path = require("node:path") as typeof import("node:path");
        const fs = require("node:fs") as typeof import("node:fs");
        const dir = "./axiom-memory/03-Resources/skills";
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${skill.id}.json`), JSON.stringify(skill, null, 2), "utf8");
      } catch {
        // 持久化失败不阻断（内存注册已生效）
      }
    },
  );

  return {
    created: [...created, ...crafted.map((s) => s.id)],
    inductionCount: inductions.length,
    traceCount: traces.length,
    craftedCount: crafted.length,
  };
}
