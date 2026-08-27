/**
 * 归纳模式 → 可调用 skill（auto-induce-*）
 *
 * 把 selfInduce 归纳出的高成功率模式提升为 SkillDefinition 并注册到
 * SkillRegistry（并持久化到 axiom-memory/03-Resources/skills），
 * 使模型可以通过 MCP skill_run 工具按需调用这些模式。
 * 确定性、无 LLM、依赖可注入（便于测试）。
 */
import path from "path";
import fs from "fs";
import { getSkillRegistry } from "../skills/skill-registry.js";
import { DEFAULT_SKILL_DIRS } from "../skills/types.js";
import type { SkillDefinition } from "../skills/types.js";
import type { Induction } from "./types.js";
import type { SkillQualityRecord } from "./skill-quality.js";
import { getDefaultQualityTracker } from "./skill-quality.js";

/** 提升依赖：注册 + 幂等检查 + 可选持久化（默认接 SkillRegistry + 磁盘） */
export interface InductionPromotionDeps {
  register(skill: SkillDefinition): void;
  has(id: string): boolean;
  persist?(skill: SkillDefinition): void;
  /** 技能质量记录查询（可选）：用于跳过 deprecated 技能并把质量状态写入描述 */
  quality?: {
    getSkillQuality(skillId: string): SkillQualityRecord | undefined;
  };
}

function slugify(pattern: string): string {
  const slug = pattern
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "pattern";
}

function defaultDeps(): InductionPromotionDeps {
  const registry = getSkillRegistry();
  return {
    register: (skill) => registry.register(skill),
    has: (id) => registry.get(id) !== undefined,
    quality: { getSkillQuality: (id) => getDefaultQualityTracker().getSkillQuality(id) },
    persist: (skill) => {
      const targetDir = DEFAULT_SKILL_DIRS[1] ?? "./axiom-memory/03-Resources/skills";
      const targetPath = path.join(targetDir, `${skill.id}.json`);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(skill, null, 2), "utf-8");
    },
  };
}

/**
 * 把归纳模式提升为可调用 skill，返回新创建的 skill id 列表。
 * 幂等：同 id 已存在则跳过；已 deprecated 的技能不再提升（保持注册幂等）。
 * 持久化失败不阻断（内存注册已生效）。
 */
export function promoteInductionsToSkills(
  inductions: Induction[],
  deps: InductionPromotionDeps = defaultDeps(),
): string[] {
  const created: string[] = [];
  for (const induction of inductions) {
    // 确定性 id：同 pattern 幂等（重复反思不会无限累积）
    const id = `auto-induce-${slugify(induction.pattern)}`;
    if (deps.has(id)) continue;
    const quality = deps.quality?.getSkillQuality(id);
    if (quality?.deprecated) continue;

    const skill: SkillDefinition = {
      id,
      name: `诱导模式: ${induction.pattern}`,
      description: formatDescription(induction.recommendation, quality),
      triggers: [induction.pattern],
      promptTemplate: [
        `这是一个从 ${induction.support} 次执行轨迹中归纳出的高成功率模式（成功率 ${(induction.successRate * 100).toFixed(0)}%）。`,
        "",
        induction.recommendation,
        "",
        "在相似任务中优先采用该模式。用户请求: {{input}}",
      ].join("\n"),
      requiredTools: [],
      outputFormat: "text",
      version: "1.0-auto",
      source: "hermes",
    };

    deps.register(skill);
    try {
      deps.persist?.(skill);
    } catch {
      // 持久化失败不阻断（内存注册已生效）
    }
    created.push(id);
  }
  return created;
}

/** 质量状态写入 skill 描述（无记录时不追加，保持既有行为）。 */
function formatDescription(recommendation: string, quality?: SkillQualityRecord): string {
  if (!quality) return recommendation;
  const stats = `quality: calls=${quality.calls} success=${quality.successes}${quality.deprecated ? " deprecated" : ""}`;
  return [recommendation, stats].join("\n");
}
