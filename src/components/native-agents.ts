import type {
  AgentComponent,
  AgentResult,
  AgentTask,
  ComponentContext,
  ComponentHealth,
  ComponentMessage,
  CompressedMessages,
  ExecutionContext,
  TokenBudgetContract,
} from "./contracts.js";
import type { ComponentKernel } from "./kernel.js";

export interface NativeExecutionOptions {
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  excludeModels?: string[];
  trackAs?: string;
}

export interface NativeExecutionResult {
  content?: string | null;
  model?: string;
  provider?: string;
  latencyMs?: number;
  fallbackUsed?: boolean;
}

export type NativeExecutor = (
  role: string,
  messages: ComponentMessage[],
  options?: NativeExecutionOptions,
) => Promise<NativeExecutionResult>;

export type NativePromptProvider = (task: AgentTask) => string;

export interface NativeCodeToolchain {
  available(): Promise<boolean>;
  run(
    type: string,
    input: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
}

export interface NativeAgentOptions {
  executor?: NativeExecutor;
  promptFor?: NativePromptProvider;
  tokenBudget?: TokenBudgetContract;
  codeToolchain?: NativeCodeToolchain;
}

export abstract class BaseNativeAgent implements AgentComponent {
  readonly kind = "agent" as const;
  readonly version = "1.0.0";
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly capabilities: string[];
  dependencies?: string[];

  protected constructor(protected readonly options: NativeAgentOptions = {}) {}

  async init(_ctx: ComponentContext): Promise<void> {}

  async health(): Promise<ComponentHealth> {
    return {
      id: this.id,
      ready: true,
      optional: false,
      reason: "native component available",
      metrics: {
        modelBackend: this.options.executor ? "configured" : "degraded",
        externalCli: "false",
        mode: "native",
      },
    };
  }

  async dispose(): Promise<void> {}

  async healthCheck(): Promise<boolean> {
    return (await this.health()).ready;
  }

  async execute(
    task: AgentTask,
    _ctx?: ExecutionContext,
  ): Promise<AgentResult> {
    const start = Date.now();
    try {
      const messages = this.buildMessages(task);
      const compressed = await this.compressMessages(messages, task);
      const role = this.executionRole(task.type);
      const result = await this.options.executor?.(role, compressed.messages, {
        timeout: task.timeout,
        trackAs: this.id,
      });

      if (!result?.content) {
        return {
          taskId: task.id,
          agentId: this.id,
          success: false,
          error:
            "Model backend unavailable: no model provider or API key configured",
          duration: Date.now() - start,
          metadata: {
            native: true,
            role,
            tokenMode: compressed.mode,
            tokenRate: compressed.rate,
          },
        };
      }

      return {
        taskId: task.id,
        agentId: this.id,
        success: true,
        data: { message: result.content },
        duration: Date.now() - start,
        metadata: {
          native: true,
          role,
          engine: "internal",
          model: result.model,
          provider: result.provider,
          fallbackUsed: result.fallbackUsed ?? false,
          tokenMode: compressed.mode,
          tokenRate: compressed.rate,
        },
      };
    } catch (err) {
      return {
        taskId: task.id,
        agentId: this.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  }

  protected buildMessages(task: AgentTask): ComponentMessage[] {
    return [
      {
        role: "system",
        content: this.options.promptFor?.(task) ?? this.defaultSystemPrompt(),
      },
      { role: "user", content: this.userContent(task) },
    ];
  }

  protected userContent(task: AgentTask): string {
    const parts: string[] = [task.description];
    if (task.input && Object.keys(task.input).length > 0) {
      parts.push(JSON.stringify(task.input, null, 2));
    }
    if (task.context && Object.keys(task.context).length > 0) {
      parts.push(`Context:\n${JSON.stringify(task.context, null, 2)}`);
    }
    return parts.join("\n\n");
  }

  protected async compressMessages(
    messages: ComponentMessage[],
    task: AgentTask,
  ): Promise<CompressedMessages> {
    if (!this.options.tokenBudget) {
      return {
        messages,
        mode: "none",
        originalTokens: 0,
        compressedTokens: 0,
        rate: 1,
        itemCount: messages.length,
        dropped: 0,
        truncated: 0,
        preservedRecent: 0,
      };
    }
    return this.options.tokenBudget.compress(messages, task.budget ?? 64000);
  }

  protected abstract executionRole(type: string): string;

  protected abstract defaultSystemPrompt(): string;
}

export class NativeGeneralAgent extends BaseNativeAgent {
  readonly id = "native-general";
  readonly name = "Native General Agent";
  readonly description =
    "Day0 general task agent for chat, planning, decisions, and tool tasks";
  readonly capabilities = [
    "general",
    "general-chat",
    "general-tool",
    "planning",
    "decision",
  ];

  constructor(options: NativeAgentOptions = {}) {
    super(options);
  }

  protected executionRole(type: string): string {
    if (type === "decision" || type === "planning") return "decision";
    if (type === "general-tool") return "general-tool";
    return "general-chat";
  }

  protected defaultSystemPrompt(): string {
    return "You are the native general agent. Handle the task directly with available local context and tools.";
  }
}

export class NativeCodeAgent extends BaseNativeAgent {
  readonly id = "native-code";
  readonly name = "Native Code Agent";
  readonly description =
    "Day0 coding agent using the local Pi toolchain first and internal model routing as fallback";
  readonly capabilities = [
    "code-generation",
    "code-review",
    "refactoring",
    "testing",
  ];

  private readonly toolchainTypes = new Set([
    "code-generation",
    "code-review",
    "refactoring",
    "testing",
  ]);

  constructor(options: NativeAgentOptions = {}) {
    super(options);
  }

  async execute(
    task: AgentTask,
    ctx?: ExecutionContext,
  ): Promise<AgentResult> {
    const start = Date.now();
    const toolchainData = await this.runToolchain(task);
    if (toolchainData) {
      return {
        taskId: task.id,
        agentId: this.id,
        success: true,
        data: { engine: "pi", ...toolchainData },
        duration: Date.now() - start,
        metadata: { native: true, engine: "pi", type: task.type },
      };
    }
    return super.execute(task, ctx);
  }

  protected executionRole(type: string): string {
    return type === "code-review" ? "code-review" : "code-generation";
  }

  protected defaultSystemPrompt(): string {
    return "You are the native code agent. Generate, review, refactor, and test code with production engineering judgment.";
  }

  private async runToolchain(
    task: AgentTask,
  ): Promise<Record<string, unknown> | null> {
    const toolchain = this.options.codeToolchain;
    if (!toolchain || !this.toolchainTypes.has(task.type)) return null;

    const available = await toolchain.available().catch(() => false);
    if (!available) return null;

    const result = await toolchain
      .run(task.type, task.input)
      .catch(
        (): { success: false; error: string; data?: Record<string, unknown> } => ({
          success: false,
          error: "toolchain run failed",
        }),
      );
    return result.success ? (result.data ?? {}) : null;
  }
}

export class NativeResearchAgent extends BaseNativeAgent {
  readonly id = "native-research";
  readonly name = "Native Research Agent";
  readonly description =
    "Day0 research agent for analysis, deep research, and architecture synthesis";
  readonly capabilities = [
    "research",
    "deep-research",
    "analysis",
    "architecture",
  ];

  constructor(options: NativeAgentOptions = {}) {
    super(options);
  }

  protected executionRole(type: string): string {
    return type === "architecture" ? "architecture" : "research";
  }

  protected defaultSystemPrompt(): string {
    return "You are the native research agent. Produce structured, cited, evidence-first analysis.";
  }
}

export function registerNativeAgents(
  kernel: ComponentKernel,
  options: NativeAgentOptions = {},
): void {
  kernel.register(new NativeGeneralAgent(options));
  kernel.register(new NativeCodeAgent(options));
  kernel.register(new NativeResearchAgent(options));
}
