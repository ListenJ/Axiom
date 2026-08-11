import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import {
  loadSkillsFromDirectories,
  saveSkillFile,
  createSkillFileBoilerplate,
  clearSkillCache,
} from "../../skills/skill-loader.js";

export function registerSkillTools(registry: ToolRegistry, skillDirs: string[]): void {
  registry.add({
    name: "skill_list",
    description: "列出所有已加载的 skills 和 prompt templates",
    exposure: ["external", "safe-external"],
    inputSchema: {
      includeBuiltin: z.boolean().optional().default(true).describe("是否包含内置 skills"),
      includeFile: z.boolean().optional().default(true).describe("是否包含从文件加载的 skills"),
    },
    handler: async (args) => {
      const loaded = loadSkillsFromDirectories({ skillDirs });
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
  });

  registry.add({
    name: "skill_reload",
    description: "重新从磁盘加载所有 skill 文件",
    inputSchema: {},
    handler: async () => {
      clearSkillCache();
      const loaded = loadSkillsFromDirectories({ skillDirs }, true);
      return {
        success: true,
        skillsLoaded: loaded.skills.size,
        templatesLoaded: loaded.templates.size,
        errors: loaded.errors,
      };
    },
  });

  registry.add({
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
  });

  registry.add({
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
      const result = await getSkillRegistry().executeById(
        String(args.skillId),
        (args.params as Record<string, string> | undefined) ?? {},
      );
      if (!result) {
        throw new Error(`Skill not found: ${args.skillId}`);
      }
      return {
        content: result.content,
        skillId: result.skillId,
        model: result.model,
        provider: result.provider,
        latencyMs: result.latencyMs,
        toolCalls: result.toolCalls ?? [],
      };
    },
  });
}
