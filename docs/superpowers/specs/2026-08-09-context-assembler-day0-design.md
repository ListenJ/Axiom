# ContextAssembler Unified Context Assembly and TokenBudget Integration

> Status: Approved. Direction A1: a deep ContextAssembler module wired into chat and internalAgent; legacy token estimators stay for now.
> Goal: every LLM call path gets unified context budgeting, compression reports, and optional read statistics without changing no-budget behavior.

## 1. Summary

Today `/chat`, `/chat/stream`, and `internalAgent` use assembled messages directly without TokenBudget. Token estimation is duplicated across `ContextManager`, `RateDistortionCompressor`, `tools/types`, and `opencode-tools/types`. This design adds a deep `ContextAssembler` module that performs:

- unified context token estimation;
- smart compression when a budget is exceeded;
- optional ReadOptimizer read statistics;
- safe fallback to the original messages when compression fails.

Initial integration covers `prepareChatContext`, `internalAgent`, `/chat`, and `/chat/stream`.

## 2. Current Gaps

1. `prepareChatContext` assembles messages but never applies a budget.
2. `internalAgent.chat/executeWithRole/stream` accept no budget parameter.
3. Token estimation is duplicated in at least 5 places.
4. `/chat` and `/chat/stream` cannot expose token compression rates.
5. ReadOptimizer exists, but the chat path still calls `retrieveCodeMemory` directly.

## 3. Target Architecture

```
frontend / openai-compat / internal callers
                    |
                    v
        ContextAssembler.assemble()
                    |
        +-----------+--------------+
        |  TokenBudgetContract     |
        |  estimate / compress     |
        +-----------+--------------+
                    |
        ReadOptimizer.read() (optional)
                    |
                    v
        router / internalAgent
```

`ContextAssembler` stays focused on context assembly. It never calls the model directly and holds no session state.

## 4. Components and Contracts

### 4.1 `src/context/token-estimator.ts`

Single mixed Chinese/English estimator:

```ts
export function estimateTokens(text: string): number;
export function estimateMessageTokens(message: ComponentMessage): number;
```

Rules: CJK characters use 1 token per 1.5 chars, other characters use 1 token per 4 chars, and each message adds 4 tokens of overhead.

### 4.2 `src/components/context-assembler.ts`

```ts
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
```

Implementation rules:

- Use `128_000` as the default budget; clamp explicit budgets below `256` to `256`.
- Call `TokenBudget.compress`.
- On compression error, return the original messages plus a zero report; never throw.
- Implement `ComponentLifecycle` with id `context-assembler` and register it in the Component Kernel.

### 4.3 `src/services/chat.ts`

`PreparedContext` gains:

```ts
tokenBudgetReport?: TokenBudgetReport | null;
readStats?: ReadResponse | null;
```

`prepareChatContext` gains an optional fourth argument:

```ts
options?: { budget?: number | ComponentBudget };
```

After assembly, call `ContextAssembler.assemble`. CodeGraph retrieval prefers `ReadOptimizer.read`; when unavailable or failing, fall back to the existing `retrieveCodeMemory` path.

### 4.4 `src/agents/internal-agent.ts`

`InternalChatOptions` gains:

```ts
budget?: number | ComponentBudget;
```

`chat`, `executeWithRole`, `stream`, and `streamDefault` compress messages before entering the router when `budget` is provided. Without `budget`, behavior stays identical.

### 4.5 `src/routes/chat.ts`

- `/chat` and `/agent-chat` accept optional `body.budget` and include `tokenBudget` in the response.
- `/chat/stream` accepts optional `body.budget` and includes `tokenBudget` in the `start` event.

### 4.6 Component Kernel

`initializeComponentKernel` registers `context-assembler` after `token-budget`.

## 5. Data Flow

1. Caller sends `messages` and an optional `budget`.
2. `prepareChatContext` assembles intent, codegraph, and knowledge context.
3. `ContextAssembler.assemble` estimates and compresses.
4. `PreparedContext` returns compressed messages and `tokenBudgetReport`.
5. `executeChat` or `router.chatStream` uses compressed messages.
6. `/chat` and `/chat/stream` return the compression report to the caller.

## 6. Error Handling

- Compression failure: `ContextAssembler` catches and returns original messages.
- ReadOptimizer unavailable: fall back to the existing `retrieveCodeMemory` path.
- Invalid budget: clamp to `[256, 1_000_000]`; do not reject the request.
- No budget: keep current behavior exactly; no compression is triggered.

## 7. Test Strategy

- `tests/context/token-estimator.test.ts`: mixed Chinese/English estimation and message overhead.
- `tests/components/context-assembler.test.ts`: no-op under budget, compression over budget, failure fallback, and report shape.
- `tests/services-chat.test.ts`: add budget cases verifying `tokenBudgetReport` and compressed messages.
- `tests/internal-agent-budget.test.ts`: mock router and verify budgeted calls send compressed messages while unbudgeted calls send originals.
- `tests/components/routes.test.ts`: registration includes `context-assembler`.

## 8. Acceptance Criteria

- `prepareChatContext` returns `tokenBudgetReport`.
- `/chat` response includes `tokenBudget`.
- `/chat/stream` `start` event includes `tokenBudget`.
- `internalAgent` compresses when `budget` is provided and stays identical otherwise.
- Compression errors never interrupt chat.
- `bun run lint`, `bun run test:arch`, and related tests pass.

## 9. Scope Boundaries

- Do not batch-replace legacy estimators in `context-manager`, `tools/types`, or `opencode-tools/types`.
- Do not refactor Knowledge retrieval.
- Do not remove existing route compatibility.
- This phase only wires chat and internalAgent primary paths.
