# ContextAssembler Implementation Plan

**Goal:** Wire unified context assembly and TokenBudget into chat and internalAgent paths.

**Architecture:** Add `src/context/token-estimator.ts` as the canonical estimator, add `src/components/context-assembler.ts` as a deep assembly component, and integrate it into `prepareChatContext`, `internalAgent`, `/chat`, and `/chat/stream`.

**Tech Stack:** TypeScript, Bun, existing TokenBudget, existing ReadOptimizer.

---

## Task 1: Token Estimator and ContextAssembler

**Files:**
- Create: `src/context/token-estimator.ts`
- Create: `src/components/context-assembler.ts`
- Create: `tests/context/token-estimator.test.ts`
- Create: `tests/components/context-assembler.test.ts`

**Step 1: Write failing tests**

`tests/context/token-estimator.test.ts` verifies mixed CJK/ASCII estimation and message overhead.

`tests/components/context-assembler.test.ts` verifies:
- budgeted messages stay unchanged when under budget;
- oversized messages are compressed;
- compression failure falls back to original messages;
- `tokenBudgetReport` has the expected shape.

**Step 2: Run tests to confirm failure**

Run: `bun test tests/context/token-estimator.test.ts tests/components/context-assembler.test.ts`
Expected: FAIL with module not found.

**Step 3: Implement**

`token-estimator.ts`:

```ts
export interface TokenMessageLike {
  content: string;
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function estimateMessageTokens(message: TokenMessageLike): number {
  return 4 + estimateTokens(message.content);
}
```

`context-assembler.ts` implements `ContextAssemblerContract` and `ComponentLifecycle`, calls `TokenBudget.compress`, clamps budgets to `[256, 1_000_000]`, and falls back on errors.

**Step 4: Run tests to confirm pass**

**Step 5: Commit**

---

## Task 2: `prepareChatContext` Integration

**Files:**
- Modify: `src/services/chat.ts`
- Modify: `tests/services-chat.test.ts`

**Step 1: Write failing test**

Add a budget case to `tests/services-chat.test.ts`:

```ts
const result = await prepareChatContext(
  [{ role: "user", content: "x".repeat(500) }],
  false,
  null,
  { budget: 64 },
);
expect(result.tokenBudgetReport).toBeDefined();
```

**Step 2: Run test to confirm failure**

**Step 3: Implement**

- `PreparedContext` gains `tokenBudgetReport` and `readStats`.
- `prepareChatContext` gains `options?: { budget?: number | ComponentBudget }`.
- After assembly, call `contextAssembler.assemble`.
- CodeGraph retrieval prefers `ReadOptimizer.read` when initialized, with existing `retrieveCodeMemory` fallback.

**Step 4: Run tests to confirm pass**

**Step 5: Commit**

---

## Task 3: `internalAgent` Budget

**Files:**
- Modify: `src/agents/internal-agent.ts`
- Create: `tests/internal-agent-budget.test.ts`

**Step 1: Write failing test**

Mock `src/router/model-router.js` so `executeWithRole` captures messages. Verify that passing `budget` sends compressed messages and omitting it sends originals.

**Step 2: Run test to confirm failure**

**Step 3: Implement**

- `InternalChatOptions` gains `budget?: number | ComponentBudget`.
- `chat`, `executeWithRole`, `stream`, and `streamDefault` compress before routing when budget is set.

**Step 4: Run tests to confirm pass**

**Step 5: Commit**

---

## Task 4: Routes and Kernel Registration

**Files:**
- Modify: `src/routes/chat.ts`
- Modify: `src/agents/component-bootstrap.ts`
- Modify: `tests/components/routes.test.ts`

**Step 1: Write failing tests**

Update `tests/components/routes.test.ts` to expect `context-assembler` in `/components`.

**Step 2: Run test to confirm failure**

**Step 3: Implement**

- `/chat` and `/agent-chat` accept `body.budget` and return `tokenBudget`.
- `/chat/stream` accepts `body.budget` and includes `tokenBudget` in the `start` event.
- `initializeComponentKernel` registers `contextAssembler`.

**Step 4: Run tests to confirm pass**

**Step 5: Commit**

---

## Verification

Run:

```bash
bun test tests/context/token-estimator.test.ts tests/components/context-assembler.test.ts tests/services-chat.test.ts tests/internal-agent-budget.test.ts tests/components/routes.test.ts
bun run lint
bun run test:arch
```

Expected: all pass, then push each commit to `internal211 master`.
