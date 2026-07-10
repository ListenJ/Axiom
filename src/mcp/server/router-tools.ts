import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { router } from "../../router/model-router.js";

export function registerRouterTools(registry: ToolRegistry): void {
  registry.add({
    name: "model_chat",
    description: "通过多平台路由器发送聊天请求",
    inputSchema: {
      taskType: z.enum(["general-chat", "code-generation", "complex-reasoning"]).describe("任务类型"),
      messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).describe("消息列表"),
    },
    handler: async (args) => {
      const messages = (args.messages as Array<{ role: string; content: string }>).map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      }));
      const result = await router.chat(args.taskType as string, messages);
      return { content: result.content || "" };
    },
  });
}
