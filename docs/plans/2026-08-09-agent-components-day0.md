# Agent Component System Day0 Implementation Plan

**Goal:** Implement the Phase 1 component kernel, smart token budget, native agents, and Day0 status surfaces from `docs/superpowers/specs/2026-08-09-agent-components-day0-design.md`.

**Architecture:** Add a `src/components/` layer that owns contracts, lifecycle registry, token budget, and native agent components. Keep this layer free of imports from `agents/`, `services/`, or `pi-agent/` to avoid new circular pairs. A bootstrap adapter in `src/agents/component-bootstrap.ts` wires real `internalAgent`, `PromptPool`, and `PiCodeEngine` into the components. The orchestrator default route becomes native agents; external CLIs remain legacy adapters.

**Tech Stack:** TypeScript 5.3, Bun test, existing `RateDistortionCompressor`, existing MCP `ToolRegistry`, existing Trie HTTP router.

---

## Task 1: Component Contracts, Kernel, Token Budget

**Files:**
- Create: `src/components/contracts.ts`
- Create: `src/components/kernel.ts`
- Create: `src/components/token-budget.ts`
- Create: `tests/components/kernel.test.ts`
- Create: `tests/components/token-budget.test.ts`

**Step 1: Write failing tests**

`tests/components/kernel.test.ts` verifies dependency-ordered init, health aggregation, duplicate registration, and dispose.

```ts
const a: ComponentLifecycle = {
  id: "a", version: "1.0.0", kind: "tool",
  init: async () => { order.push("a"); },
  health: async () => ({ id: "a", ready: true, optional: false }),
  dispose: async () => { order.push("dispose:a"); },
};
const b: ComponentLifecycle = {
  id: "b", version: "1.0.0", kind: "tool", dependencies: ["a"],
  init: async () => { order.push("b"); },
  health: async () => ({ id: "b", ready: false, optional: true, reason: "pending" }),
  dispose: async () => {},
};
```

`tests/components/token-budget.test.ts` verifies mixed Chinese/English estimation, message trimming, no-op compression under budget, deterministic compression over budget, recent-message preservation, and report shape.

**Step 2: Run tests to confirm failure**

Run: `bun test tests/components/kernel.test.ts tests/components/token-budget.test.ts`
Expected: FAIL with module not found.

**Step 3: Implement minimal contracts and kernel**

`contracts.ts` defines `ComponentLifecycle`, `ComponentHealth`, `ComponentContext`, `AgentComponent`, `AgentTask`, `AgentResult`, `ComponentMessage`, `ComponentBudget`, `CompressedMessages`, `TokenBudgetReport`, and `TokenBudgetContract`.

`kernel.ts` implements `ComponentKernel` with `register/get/list/init/initAll/health/healthAll/dispose`, plus `getComponentKernel()` and `resetComponentKernel()`.

**Step 4: Implement TokenBudget**

`token-budget.ts` implements:
- `estimate(text)` using CJK / 1.5 + other / 4.
- `estimateMessages(messages)` with 4-token per-message overhead.
- `trimMessage(message, maxTokens)` with binary-search prefix fitting.
- `compress(messages, budget)` using layered policy:
  1. Under budget: return unchanged with mode `none`.
  2. Rate-distortion compression for older items when pressure is high.
  3. Drop low-relevance older messages first.
  4. Trim old messages, then trim/drop oldest recent messages only when necessary.
- `report()` returning the last compression report.
- `kind: "context"` and lifecycle methods so the singleton can be registered in the kernel.

**Step 5: Run tests to confirm pass**

Run: `bun test tests/components/kernel.test.ts tests/components/token-budget.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/components tests/components docs/operations-log.md
git commit -m "feat: component kernel and smart token budget"
git push internal211 master
```

---

## Task 2: Native Agents, Bootstrap, Orchestrator Default

**Files:**
- Create: `src/components/native-agents.ts`
- Create: `src/agents/component-bootstrap.ts`
- Modify: `src/agents/orchestrator.ts`
- Modify: `tests/orchestrator.test.ts`
- Create: `tests/components/native-agents.test.ts`
- Create: `tests/components/day0-boot.test.ts`

**Step 1: Write failing tests**

`tests/components/native-agents.test.ts` verifies:
- `NativeGeneralAgent` with fake executor returns success and id `native-general`.
- Without executor, execution returns a degraded failure with a clear error.
- `NativeCodeAgent` uses `NativeCodeToolchain` for code tasks and falls back to executor when the toolchain is unavailable.
- `registerNativeAgents` registers all three native agents in a kernel.

`tests/components/day0-boot.test.ts` calls `initializeComponentKernel()` and asserts `native-general`, `native-code`, `native-research`, and `token-budget` are ready without any external CLI.

Update `tests/orchestrator.test.ts` so default ids are `native-general`, `native-code`, `native-research`.

**Step 2: Run tests to confirm failure**

Run: `bun test tests/components/native-agents.test.ts tests/components/day0-boot.test.ts tests/orchestrator.test.ts`
Expected: FAIL because modules are missing and ids are old.

**Step 3: Implement native agents**

`native-agents.ts` defines:
- `NativeExecutor`, `NativePromptProvider`, `NativeCodeToolchain`, `NativeAgentOptions`.
- `BaseNativeAgent` with lifecycle, `healthCheck()`, and shared message/budget assembly.
- `NativeGeneralAgent`, `NativeCodeAgent`, `NativeResearchAgent`.
- `registerNativeAgents(kernel, options)`.

**Step 4: Implement bootstrap and orchestrator wiring**

`component-bootstrap.ts` wires:
- `executor` -> `internalAgent.executeWithRole`
- `promptFor` -> `getPromptPool().acquire`
- `codeToolchain` -> `piCodeEngine`
- `initializeComponentKernel()` -> registers `tokenBudget` and native agents, then `initAll()`.

`orchestrator.ts`:
- `roleMapping` now maps coding/research/architecture/decision/general to `native-*`.
- `getAgentOrchestrator()` registers the three native agents using `createNativeAgentOptions()`.
- Legacy `InternalAgent`, `CodeAgent`, `ResearchAgent` remain exported for compatibility but are no longer default.

**Step 5: Run tests to confirm pass**

Run: `bun test tests/components/native-agents.test.ts tests/components/day0-boot.test.ts tests/orchestrator.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/components src/agents tests docs/operations-log.md
git commit -m "feat: native day0 agents and orchestrator default path"
git push internal211 master
```

---

## Task 3: Routes, MCP, Main Startup

**Files:**
- Create: `src/routes/components.ts`
- Create: `src/mcp/server/native-tools.ts`
- Modify: `src/routes/index.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/main.ts`
- Create: `tests/components/routes.test.ts`

**Step 1: Write failing tests**

`tests/components/routes.test.ts` builds a mock `RouteContext`, registers a fake component in a fresh kernel, and asserts:
- `GET /components` returns component health.
- `GET /agents/native/status` returns the three native ids and 200.

**Step 2: Run test to confirm failure**

Run: `bun test tests/components/routes.test.ts`
Expected: FAIL with module not found.

**Step 3: Implement routes and MCP tool**

`routes/components.ts` adds `handleComponentsStatus` and `handleNativeAgentStatus`.

`routes/index.ts` imports both handlers, adds them to the linear handler array and `registerTrieRoutes`, and lists them in the default 404 API index.

`mcp/server/native-tools.ts` exports `registerNativeTools(registry)` and registers `native_toolchain_status`.

**Step 4: Wire startup**

`mcp/server.ts` calls `await initializeComponentKernel()` before `registerNativeTools(registry)`.

`main.ts` calls `await initializeComponentKernel()` during startup and registers a `component-kernel` shutdown hook that calls `dispose()`.

**Step 5: Verify**

Run:
```bash
bun test tests/components/routes.test.ts
bun run lint
bun run test:arch
bun test tests/components/kernel.test.ts tests/components/token-budget.test.ts tests/components/native-agents.test.ts tests/components/day0-boot.test.ts tests/orchestrator.test.ts
```
Expected: All pass.

**Step 6: Commit and push**

```bash
git add src/routes src/mcp src/main.ts tests docs/operations-log.md docs/plans
git commit -m "feat: component status routes, MCP tool, day0 startup"
git push internal211 master
```

---

## Acceptance Checklist

- [ ] New clone without external CLI starts with core components ready.
- [ ] `/components` exposes core health and marks adapters optional when absent.
- [ ] `/agents/native/status` exposes native-general, native-code, native-research.
- [ ] MCP exposes `native_toolchain_status`.
- [ ] Orchestrator maps coding/research/architecture/decision/general to native agents.
- [ ] TokenBudget compresses deterministically, preserves recent messages, and reports rate.
- [ ] Architecture tests pass with `src/components/` importing at most `context` and local modules.
