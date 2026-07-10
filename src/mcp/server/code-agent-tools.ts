import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import {
  executeCodeGenerate,
  executeCodeRefactor,
  executeCodeReview,
  executeCodeTest,
  checkOpenCode,
  listOpenCodeModels,
  OPENCODE_FREE_MODELS,
} from "../../agents/opencode-agent.js";

export function registerCodeAgentTools(registry: ToolRegistry): void {
  registry.add({
    name: "code_generate",
    description: "使用 AI 模型生成代码（自动注入 CodeGraph 上下文，支持免费模型）",
    inputSchema: {
      prompt: z.string().describe("代码生成需求描述"),
      language: z.string().optional().describe("编程语言"),
      context: z.string().optional().describe("现有代码上下文"),
      model: z.string().optional().describe("模型名称"),
    },
    handler: async (args) => {
      const result = await executeCodeGenerate({
        prompt: args.prompt as string,
        language: args.language as string | undefined,
        context: args.context as string | undefined,
        model: args.model as string | undefined,
      });
      return result;
    },
  });

  registry.add({
    name: "code_refactor",
    description: "使用 AI 模型重构代码（自动注入 CodeGraph 上下文）",
    inputSchema: {
      code: z.string().describe("要重构的代码"),
      description: z.string().describe("重构需求描述"),
      language: z.string().optional().describe("编程语言"),
    },
    handler: async (args) => {
      const result = await executeCodeRefactor({
        code: args.code as string,
        description: args.description as string,
        language: args.language as string | undefined,
      });
      return result;
    },
  });

  registry.add({
    name: "code_review",
    description: "使用 AI 模型审查代码（优先 GLM-5.1）",
    inputSchema: {
      code: z.string().describe("要审查的代码"),
      language: z.string().optional().describe("编程语言"),
      context: z.string().optional().describe("代码上下文"),
    },
    handler: async (args) => {
      const result = await executeCodeReview({
        code: args.code as string,
        language: args.language as string | undefined,
        context: args.context as string | undefined,
      });
      return result;
    },
  });

  registry.add({
    name: "code_test",
    description: "使用 AI 模型生成测试用例",
    inputSchema: {
      code: z.string().describe("要测试的代码"),
      language: z.string().optional().describe("编程语言"),
      framework: z.string().optional().describe("测试框架"),
    },
    handler: async (args) => {
      const result = await executeCodeTest({
        code: args.code as string,
        language: args.language as string | undefined,
        framework: args.framework as string | undefined,
      });
      return result;
    },
  });

  registry.add({
    name: "opencode_status",
    description: "检查 OpenCode Agent 状态和可用模型",
    inputSchema: {},
    handler: async () => {
      const available = await checkOpenCode();
      const models = available ? await listOpenCodeModels() : [];
      return { installed: available, freeModels: OPENCODE_FREE_MODELS, allModels: models.slice(0, 50) };
    },
  });
}
