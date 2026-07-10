import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { getQuickDiagnostics, getCodeActions, detectLanguage } from "../tools/code-analysis.js";

export function registerLspTools(registry: ToolRegistry): void {
  registry.add({
    name: "code_quick_diagnostics",
    description: "快速诊断单个文件（使用增量检查，更快）",
    inputSchema: {
      filePath: z.string().describe("文件路径"),
    },
    handler: async (args) => getQuickDiagnostics(args.filePath as string),
  });

  registry.add({
    name: "code_actions",
    description: "获取代码修复建议（Code Actions）",
    inputSchema: {
      filePath: z.string().describe("文件路径"),
    },
    handler: async (args) => getCodeActions(args.filePath as string),
  });

  registry.add({
    name: "code_detect_language",
    description: "检测文件编程语言",
    inputSchema: {
      filePath: z.string().describe("文件路径"),
    },
    handler: async (args) => ({
      success: true,
      language: detectLanguage(args.filePath as string),
      filePath: args.filePath,
    }),
  });
}
