import type {
  ComponentBudget,
  ComponentContext,
  ComponentHealth,
  ComponentLifecycle,
  ComponentMessage,
  TokenBudgetContract,
  TokenBudgetReport,
} from "./contracts.js";
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
      const compressed = await this.tokenBudget.compress(
        request.messages,
        safeBudget,
      );
      return {
        messages: compressed.messages,
        tokenBudgetReport: compressed,
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
