/**
 * DRE Agent Harness
 *
 * 借鉴 Anthropic Claude Agent SDK / OpenAI Codex 的 harness 设计
 *
 * Agent 类型:
 * - PlannerAgent: 确定性规划器
 * - CoderAgent: Codex 风格沙箱执行
 * - RetrieverAgent: 检索 Agent
 * - ReflectorAgent: 反思 Agent
 */

import type { LLMClient } from "../llm/client.js";
import { logger } from "../../utils/logger.js";

/** 工具定义 */
export interface Tool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/** Agent 响应 */
export interface AgentResponse {
  answer: string;
  steps: number;
  history: Array<{ role: string; content: string }>;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: string }>;
}

/** LLM 聊天响应 */
interface ChatResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

/**
 * Agent 基类
 */
export class AgentHarness {
  protected llm: LLMClient;
  protected tools: Map<string, Tool>;
  protected maxSteps: number;
  protected maxTokensPerStep: number;
  protected history: Array<{ role: string; content: string }> = [];

  constructor(
    llm: LLMClient,
    tools: Tool[],
    options?: {
      maxSteps?: number;
      maxTokensPerStep?: number;
    }
  ) {
    this.llm = llm;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.maxSteps = options?.maxSteps ?? 50;
    this.maxTokensPerStep = options?.maxTokensPerStep ?? 1024;
  }

  /**
   * 系统提示 (子类覆盖)
   */
  protected systemPrompt(): string {
    return "You are a helpful assistant.";
  }

  /**
   * 执行一步
   */
  async step(userInput: string): Promise<AgentResponse> {
    this.history.push({ role: "user", content: userInput });

    for (let step = 0; step < this.maxSteps; step++) {
      // 调用 LLM
      const response = await this.callLLM();

      this.history.push({ role: "assistant", content: response.content });

      // 处理工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolResults: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];

        for (const tc of response.toolCalls) {
          const tool = this.tools.get(tc.name);
          if (tool) {
            try {
              const result = await tool.handler(tc.args);
              this.history.push({ role: "tool", content: result });
              toolResults.push({ name: tc.name, args: tc.args, result });
            } catch (err) {
              const error = `Tool error: ${(err as Error).message}`;
              this.history.push({ role: "tool", content: error });
              toolResults.push({ name: tc.name, args: tc.args, result: error });
            }
          }
        }

        // 继续下一轮
        continue;
      }

      // 没有工具调用，返回结果
      return {
        answer: response.content,
        steps: step + 1,
        history: [...this.history],
      };
    }

    return {
      answer: "[MAX_STEPS]",
      steps: this.maxSteps,
      history: [...this.history],
    };
  }

  /**
   * 调用 LLM
   */
  protected async callLLM(): Promise<ChatResponse> {
    const system = this.systemPrompt();
    const messages = [
      { role: "system", content: system },
      ...this.history,
    ];

    const toolsSchema = Array.from(this.tools.values()).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));

    const response = await this.llm.generate(
      messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
      {
        system,
        maxTokens: this.maxTokensPerStep,
        stop: ["</tool>", "</answer>"],
      }
    );

    // 解析工具调用
    const toolCalls = this.parseToolCalls(response.content);

    return {
      content: response.content,
      toolCalls,
    };
  }

  /**
   * 解析工具调用
   */
  protected parseToolCalls(content: string): ChatResponse["toolCalls"] {
    const toolCalls: NonNullable<ChatResponse["toolCalls"]> = [];

    // 简单的 JSON 解析
    const toolRegex = /<tool_call>(.*?)<\/tool>/gs;
    let match;

    while ((match = toolRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]) as {
          name: string;
          arguments: Record<string, unknown>;
        };
        toolCalls.push({
          id: `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: parsed.name,
          args: parsed.arguments,
        });
      } catch (err) {
        logger.debug("[Agent] Tool call parse error", { error: (err as Error).message });
      }
    }

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  /**
   * 清空历史
   */
  clearHistory(): void {
    this.history = [];
  }
}

/**
 * 规划 Agent
 *
 * 确定性规划器：输出 JSON 格式的执行计划
 */
export class PlannerAgent extends AgentHarness {
  protected systemPrompt(): string {
    return `你是一个确定性规划器。

【硬性约束】
- 必须输出 JSON: {"plan": [{"step": 1, "action": "...", "tool": "...", "args": {...}, "expected_hash": "..."}]}
- 每个 step 必须有 expected_hash 用于校验
- 不允许跳过验证步骤
- 温度=0，保证确定性

可用工具:
${Array.from(this.tools.values()).map((t) => `- ${t.name}: ${t.description}`).join("\n")}`;
  }
}

/**
 * 编码 Agent
 *
 * Codex 风格：沙箱执行 + 测试反馈
 */
export class CoderAgent extends AgentHarness {
  protected systemPrompt(): string {
    return `你是一个代码生成器。

【硬性约束】
- 输出必须是 diff 格式
- 每次修改后必须运行测试
- 测试失败必须修复，最多 3 次重试
- 严禁删除已有测试用例
- 温度=0，保证确定性

可用工具:
${Array.from(this.tools.values()).map((t) => `- ${t.name}: ${t.description}`).join("\n")}`;
  }
}

/**
 * 检索 Agent
 *
 * 知识库检索 + 证据聚合
 */
export class RetrieverAgent extends AgentHarness {
  protected systemPrompt(): string {
    return `你是一个知识检索器。

【硬性约束】
- 必须引用本地知识库 node_id
- 必须评估证据可信度
- 必须标注来源
- 严禁编造 node_id
- 温度=0，保证确定性

可用工具:
${Array.from(this.tools.values()).map((t) => `- ${t.name}: ${t.description}`).join("\n")}`;
  }
}

/**
 * 反思 Agent
 *
 * 自监督 + 经验教训生成
 */
export class ReflectorAgent extends AgentHarness {
  protected systemPrompt(): string {
    return `你是反思 Agent。

【硬性约束】
- 复盘最近 N 步推理链
- 检测：逻辑断点/证据缺失/幻觉
- 输出 JSON: {"issues": [...], "lessons": [...], "rollback": boolean, "checkpoint_tag": "..."}
- 温度=0，保证确定性

可用工具:
${Array.from(this.tools.values()).map((t) => `- ${t.name}: ${t.description}`).join("\n")}`;
  }
}
