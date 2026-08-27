import type {
  ComponentBudget,
  ComponentContext,
  ComponentHealth,
  ComponentLifecycle,
  ComponentMessage,
  TokenBudgetContract,
  TokenBudgetReport,
} from "./contracts.js";
import { planAdaptiveCompaction } from "./adaptive-compaction.js";
import { tokenBudget as defaultTokenBudget } from "./token-budget.js";

export interface ContextAssemblyRequest {
  messages: ComponentMessage[];
  role: string;
  budget?: number | ComponentBudget;
  requestId?: string;
}

export interface ContextAssemblyResult {
  messages: ComponentMessage[];
  tokenBudgetReport: TokenBudgetReport;
}

export interface ContextAssemblerContract {
  assemble(request: ContextAssemblyRequest): Promise<ContextAssemblyResult>;
}

function zeroReport(itemCount: number): TokenBudgetReport {
  return {
    originalTokens: 0,
    compressedTokens: 0,
    rate: 0,
    mode: "none",
    itemCount,
    dropped: 0,
    truncated: 0,
    preservedRecent: 0,
  };
}

export class ContextAssembler
  implements ContextAssemblerContract, ComponentLifecycle
{
  readonly id = "context-assembler";
  readonly version = "1.0.0";
  readonly kind = "context" as const;
  readonly dependencies = ["token-budget"];

  constructor(
    private readonly tokenBudget: TokenBudgetContract = defaultTokenBudget,
  ) {}

  async init(_ctx: ComponentContext): Promise<void> {}

  async dispose(): Promise<void> {}

  async health(): Promise<ComponentHealth> {
    return {
      id: this.id,
      ready: true,
      optional: false,
      reason: "context assembly ready",
      metrics: { mode: "assembler" },
    };
  }

  async assemble(
    request: ContextAssemblyRequest,
  ): Promise<ContextAssemblyResult> {
    const rawBudget = request.budget ?? 128_000;
    const safeBudget = Math.min(
      1_000_000,
      Math.max(256, Math.floor(Number(rawBudget) || 128_000)),
    );
    try {
      const plan = planAdaptiveCompaction(
        request.messages.map((m) => ({ ...m })),
        {
          maxContextTokens: safeBudget,
          headTokens: Math.min(2000, safeBudget),
          tailMessages: 6,
        },
      );
      const messagesForCompress =
        plan.level === "none"
          ? request.messages
          : plan.active as ComponentMessage[];
      const compressed = await this.tokenBudget.compress(
        messagesForCompress,
        safeBudget,
      );
      const report =
        plan.level !== "none" && plan.archivedTokens > 0
          ? {
              ...compressed,
              mode: "compress" as const,
              originalTokens: plan.originalTokens,
              compressedTokens: compressed.compressedTokens,
              rate: plan.originalTokens > 0
                ? compressed.compressedTokens / plan.originalTokens
                : 0,
              dropped: (compressed.dropped ?? 0) + plan.archived.length,
            }
          : compressed;
      return {
        messages: compressed.messages,
        tokenBudgetReport: report,
      };
    } catch {
      return {
        messages: [...request.messages],
        tokenBudgetReport: zeroReport(request.messages.length),
      };
    }
  }
}

export const contextAssembler = new ContextAssembler();
