import { z } from "zod";
import type { ToolDef, ToolRegistry } from "../tool-registry.js";
import { DEFAULT_SKILL_DIRS } from "../../skills/types.js";
import {
  loadSkillsFromDirectories,
  saveSkillFile,
  createSkillFileBoilerplate,
  clearSkillCache,
} from "../../skills/skill-loader.js";
import { getDefaultQualityTracker } from "../../self-evolve/skill-quality.js";

/**
 * 构建 skill 工具面（skill_list / skill_reload / skill_create / skill_run）。
 * 导出供 MCP 注册与原生 function-calling 共用，避免两处定义漂移。
 */
export function buildSkillToolSurfaces(skillDirs: string[] = [...DEFAULT_SKILL_DIRS]): ToolDef[] {
  const dirs = skillDirs;
  return [
    {
      name: "skill_list",
      description: "列出所有已加载的 skills 和 prompt templates",
      exposure: ["external", "safe-external"],
      inputSchema: {
        includeBuiltin: z.boolean().optional().default(true).describe("是否包含内置 skills"),
        includeFile: z.boolean().optional().default(true).describe("是否包含从文件加载的 skills"),
      },
      handler: async (args) => {
        const loaded = loadSkillsFromDirectories({ skillDirs: dirs });
        const includeBuiltin = args.includeBuiltin !== false;
        const includeFile = args.includeFile !== false;

        const skills = Array.from(loaded.skills.values())
          .filter((s) => {
            if (s.source === "builtin" && !includeBuiltin) return false;
            if (s.source === "file" && !includeFile) return false;
            return true;
          })
          .map((s) => ({
            id: s.id, name: s.name, description: s.description,
            triggers: s.triggers, outputFormat: s.outputFormat,
            version: s.version, source: s.source, filePath: s.filePath,
          }));

        const templates = Array.from(loaded.templates.values())
          .filter((t) => {
            if (t.source === "builtin" && !includeBuiltin) return false;
            if (t.source === "file" && !includeFile) return false;
            return true;
          })
          .map((t) => ({
            id: t.id, name: t.name, category: t.category,
            description: t.description, variables: t.variables,
            tags: t.tags, version: t.version, source: t.source, filePath: t.filePath,
          }));

        return { skills, templates, errors: loaded.errors };
      },
    },
    {
      name: "skill_reload",
      description: "重新从磁盘加载所有 skill 文件",
      inputSchema: {},
      handler: async () => {
        clearSkillCache();
        const loaded = loadSkillsFromDirectories({ skillDirs: dirs }, true);
        return {
          success: true,
          skillsLoaded: loaded.skills.size,
          templatesLoaded: loaded.templates.size,
          errors: loaded.errors,
        };
      },
    },
    {
      name: "skill_create",
      description: "创建新的 skill 文件",
      inputSchema: {
        filePath: z.string().describe("skill 文件路径（.json 或 .yaml）"),
        name: z.string().describe("skill 名称"),
        description: z.string().describe("skill 描述"),
        author: z.string().optional().describe("作者"),
      },
      handler: async (args) => {
        const boilerplate = createSkillFileBoilerplate({
          name: args.name as string,
          description: args.description as string,
          author: args.author as string | undefined,
        });
        saveSkillFile(args.filePath as string, boilerplate);
        return { success: true, filePath: args.filePath, boilerplate };
      },
    },
    {
      name: "skill_run",
      description:
        "按需执行指定 skill（模型可直接调用）：给出 skillId 与模板参数，返回执行结果。skillId 可用 skill_list 查询。",
      exposure: ["internal", "external"],
      inputSchema: {
        skillId: z.string().describe("目标 skill id"),
        params: z.record(z.string()).optional().describe("模板变量（如 input）"),
      },
      handler: async (args) => {
        const { getSkillRegistry } = await import("../../skills/skill-registry.js");
        const skillId = String(args.skillId);
        try {
          const result = await getSkillRegistry().executeById(
            skillId,
            (args.params as Record<string, string> | undefined) ?? {},
          );
          if (!result) {
            throw new Error(`Skill not found: ${skillId}`);
          }
          // 自进化技能（auto-induce-*）质量反馈：成功/失败计入质量记录
          if (skillId.startsWith("auto-induce-")) {
            getDefaultQualityTracker().recordSkillOutcome(skillId, true);
          }
          return {
            content: result.content,
            skillId: result.skillId,
            model: result.model,
            provider: result.provider,
            latencyMs: result.latencyMs,
            toolCalls: result.toolCalls ?? [],
          };
        } catch (err) {
          if (skillId.startsWith("auto-induce-")) {
            getDefaultQualityTracker().recordSkillOutcome(skillId, false);
          }
          throw err;
        }
      },
    },
  ];
}

/** 按名称执行 skill 工具（原生 function-calling 与 MCP 共用的分发入口） */
export async function runSkillTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = buildSkillToolSurfaces().find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown skill tool: ${name}`);
  return tool.handler(args);
}

/** MCP 注册入口：把 skill 工具面注册进 ToolRegistry */
export function registerSkillTools(registry: ToolRegistry, skillDirs: string[]): void {
  for (const tool of buildSkillToolSurfaces(skillDirs)) {
    registry.add(tool);
  }
}
