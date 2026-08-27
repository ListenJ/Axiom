export type ComponentKind =
  | "agent"
  | "tool"
  | "model"
  | "memory"
  | "context"
  | "skill"
  | "browser"
  | "adapter";

export interface ComponentHealth {
  id: string;
  ready: boolean;
  optional: boolean;
  reason?: string;
  metrics?: Record<string, number | string>;
}

export interface ComponentContext {
  cwd: string;
  startedAt: number;
}

export interface ComponentLifecycle {
  id: string;
  version: string;
  kind: ComponentKind;
  dependencies?: string[];
  init(ctx: ComponentContext): Promise<void>;
  health(): Promise<ComponentHealth>;
  dispose(): Promise<void>;
}

export interface ComponentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ComponentBudget {
  maxTokens: number;
  preserveRecent?: number;
}

export interface AgentTask {
  id: string;
  type: string;
  description: string;
  input: Record<string, unknown>;
  context?: Record<string, unknown>;
  priority?: number;
  timeout?: number;
  requireConfirmation?: boolean;
  dependsOn?: string[];
  budget?: number | ComponentBudget;
}

export interface AgentResult {
  taskId: string;
  agentId: string;
  success: boolean;
  data?: unknown;
  error?: string;
  duration: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionContext {
  signal?: AbortSignal;
  cwd?: string;
  traceId?: string;
}

export interface AgentComponent extends ComponentLifecycle {
  kind: "agent";
  capabilities: string[];
  execute(task: AgentTask, ctx?: ExecutionContext): Promise<AgentResult>;
}

export interface TokenBudgetReport {
  originalTokens: number;
  compressedTokens: number;
  rate: number;
  mode: "none" | "trim" | "drop" | "compress" | "mixed";
  itemCount: number;
  dropped: number;
  truncated: number;
  preservedRecent: number;
}

export interface CompressedMessages {
  messages: ComponentMessage[];
  mode: TokenBudgetReport["mode"];
  originalTokens: number;
  compressedTokens: number;
  rate: number;
  itemCount: number;
  dropped: number;
  truncated: number;
  preservedRecent: number;
}

export interface TokenBudgetContract {
  estimate(text: string): number;
  estimateMessages(messages: ComponentMessage[]): number;
  trimMessage(message: ComponentMessage, maxTokens: number): ComponentMessage;
  compress(
    messages: ComponentMessage[],
    budget: number | ComponentBudget,
    options?: { preserveRecent?: number; maxItems?: number },
  ): Promise<CompressedMessages>;
  report(): TokenBudgetReport;
}
