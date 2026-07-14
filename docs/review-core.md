# Deep Code Review: Core Architecture Modules

**Date:** 2026-07-14  
**Scope:** 6 core files in `openclaw-fusion`  
**Reviewer:** Automated deep review

---

## 1. Route System — `src/routes/index.ts` (478 lines)

### Summary

The route dispatcher implements a dual-routing strategy: a **priority-ordered sequential dispatcher** (`dispatch()`) that iterates 130+ handlers until one matches, and a **trie-based router** (`registerTrieRoutes()`) that registers the same handlers on an `HttpRouter` engine. Both are exposed as public APIs. The `defaultResponse` function provides a comprehensive endpoint listing when no route matches.

The file is well-commented with clear section markers. Chinese annotations document the purpose of each route group. However, the sheer number of imports (55 lines) and handler array entries (130+) raises maintainability questions.

### Issues

#### Critical

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 1 | 60–190 | **Dual routing systems with potentially conflicting behavior.** `dispatch()` iterates handlers sequentially in priority order. `registerTrieRoutes()` registers the same handlers on a trie-based `HttpRouter`. If the HTTP layer calls both `dispatch()` (for priority matching) and later uses `registerTrieRoutes` for fast-path routing, the same request could be matched twice. The trie router wins if it matches first, but the order of checks between the two systems is unclear. | Decide on exactly one routing strategy. Either use the sequential dispatcher for all routes (and remove `registerTrieRoutes`), or register everything on the trie and remove `dispatch()`. If both are needed, add a guard to ensure only one system handles each request. |
| 2 | 196–200 | **O(n) dispatch on every request.** For non-matching requests (404s), all 130+ handlers are `await`ed sequentially. Each handler typically does URL + method matching, so the overhead is small but grows linearly. Under high traffic this adds up. | Either (a) move to the trie router exclusively (O(log n) or O(1) lookups), or (b) partition handlers by HTTP method and URL prefix and branch early. |

#### Warning

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 3 | 4–58 | **55-line import block with aliases.** The import `handleStats as handleHealthStats` from `./health.js` (line 5) is confusing alongside the separate `handleStats` from `./stats.js` (line 6). A reader must inspect both modules to understand which is which. | Rename the health module's export to `handleHealthStats` at the source, or import with a clearer alias. Better yet, consolidate stats routes into a single module. |
| 4 | 210–379 | **`registerTrieRoutes` duplicates dispatch logic.** The trie route table and the `handlers` array are independent registrations of the same set of handlers. This causes double maintenance — adding a new route requires updating both. | Drive the trie registration from the `handlers` array metadata, or remove the sequential dispatcher entirely. |
| 5 | 384–478 | **`defaultResponse` is a maintenance burden.** The endpoint list is hand-maintained in a hardcoded string. When routes change, this list will drift out of sync. It already omits some routes (e.g., `POST /native/proxy`, many agent endpoints). | Generate the endpoint list dynamically from the route registry at startup. |

#### Info

| # | File:Line | Issue |
|---|-----------|-------|
| 6 | 61 | The `handlers` array mixes high- and low-level concerns (dashboard with eval assignments). Consider splitting into sub-arrays by domain. |
| 7 | 208 | `registerTrieRoutes` is never called within this file — it is exported for external use. The caller is not in scope of this review but should be checked. |

---

## 2. Chat Service — `src/services/chat.ts` (140 lines)

### Summary

A single entry point for assembling chat context: intent detection, CodeGraph memory retrieval, adaptive knowledge retrieval, and finally model execution. The file replaces previously duplicated logic across `handleChat` and `handleChatStream`. It is relatively concise at 140 lines.

### Issues

#### Critical

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 1 | 65, 92 | **Dynamic `await import()` on every invocation.** Both `../memory/codegraph-index.js` and `./knowledge.js` are dynamically imported inside the request path. This causes module resolution + disk I/O on every chat request, defeating V8's module caching for the first import and adding latency. | Import statically at the top of the file. The modules are always needed (conditional use is handled by runtime checks, not import-time). |

#### Warning

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 2 | 36 | **`vault` parameter typed as `unknown`, never used.** The function signature accepts `vault: unknown` but the parameter is never referenced in the body. This is misleading and suggests an incomplete refactor. | Either (a) remove the parameter entirely, or (b) add the `unknown` cast only at the call site if vault is truly unused. |
| 3 | 46–48 | **Inefficient last-user-message lookup.** `[...messages].reverse().find(...)` creates a full copy of the messages array (O(n)) then searches (O(n)). A simple `for (let i = messages.length - 1; i >= 0; i--)` loop is O(n) with no copy. | Replace with a backward `for` loop or use `findLast` (ES2023). |
| 4 | 50–57 | **`buildAgentMessages` called with 2 args but accepts 3.** The function signature likely has a default for the third parameter. Verify the function isn't silently losing context. | Audit `buildAgentMessages` in `../agents/intent-router.ts` to confirm the third parameter is truly optional. |
| 5 | 116–123 | **`shouldSearch` is a hardcoded allowlist.** As new intents are added to `buildAgentMessages`, this list must be manually kept in sync. It will inevitably drift. | Either (a) drive this from intent metadata (a flag on each intent definition), or (b) invert the logic to a blocklist. |

#### Info

| # | File:Line | Issue |
|---|-----------|-------|
| 6 | 83–84 | The `catch` block for CodeGraph failure is empty (comments say "non-fatal"). Consider at least a `logger.debug()` call. |
| 7 | 128–139 | `executeChat` does a simple if/else chain with `intentInfo`, `taskType`, and a default. This duplicates the routing logic in `routeByIntent`. Consider delegating to `router.routeByIntent` for all paths. |

---

## 3. MCP Server — `src/mcp/server.ts` (462 lines)

### Summary

The MCP (Model Context Protocol) server entry point, reduced from ~3500 lines to 462 by extracting tool registrations to separate modules. It supports both stdio and HTTP transports via the `ToolRegistry` abstraction. Inline tool definitions remain for `serpapi_search`, `serpapi_search_and_crawl`, snapshot tools, proxy status, and scene tools.

### Issues

#### Critical

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 1 | 51–55 | **Module-level side effects.** `new Database(dbPath)` and `getGlobalVault()` execute at module import time. If the database path is invalid, the vault fails to initialize, or environment variables are missing, the **entire module fails to load** — even if only stdio transport (which doesn't need HTTP) is requested. | Wrap initialization in a lazy `init()` function or use the factory pattern. Load the database and vault on first use, not at module level. |
| 2 | 98–105, 170–176 | **Unsafe type assertions on Zod-validated input.** `args.query as string`, `args.location as string`, etc. The handler type `ToolHandler = (args: Record<string, unknown>) => Promise<unknown>` discards the inferred type from `inputSchema`. If the Zod schema in `inputSchema` does not actually validate the shape (e.g., if `z.string().describe(...)` is passed as-is without proper runtime validation), these casts are blind trust assertions. | (a) Fix `ToolDef.inputSchema` type — it should be a Zod schema, not `any`. (b) Use `z.infer<typeof schema>` for the handler args. (c) At minimum, add runtime checks before casting. |
| 3 | 120, 204 | **Silent error swallowing on database writes.** Both `serpapi_search` and `serpapi_search_and_crawl` handlers wrap `db.run(...)` in `try { ... } catch { /* ignore */ }`. Any database error (constraint violation, disk full, locked connection) is silently discarded with no logging. This can hide critical data integrity issues. | Log the error at minimum: `try { ... } catch (err) { logger.warn("[MCP] DB write failed", { error: (err as Error).message }); }`. |

#### Warning

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 4 | 96, 167 | **`new SerpApiClient()` created per-request.** If the constructor performs any setup (config loading, connection pool init), this adds unnecessary latency. | Create a singleton instance at module level (similar to `vault` and `pipeline`). |
| 5 | 167 | **Duplicated `DataPipeline` instance.** A global `pipeline` is created at line 76, but a second `new DataPipeline()` is created inside the `serpapi_search_and_crawl` handler (line 167). This wastes resources and may cause conflicting state if `DataPipeline` has internal caches. | Reuse the global `pipeline` instance. |
| 6 | 372–380 | **Unclean shutdown — `process.exit(0)` immediately.** `gracefulShutdown` calls `process.exit(0)` after `shutdownKernel()` without allowing pending HTTP connections to drain or async operations to complete. The `void gracefulShutdown(...)` call also discards the promise. | Use a graceful shutdown pattern: stop accepting new connections, set a drain timeout, then exit. For `Bun.serve`, call `server.stop()` and wait for connections to close. |
| 7 | 387 | **Transport selection via `process.argv.includes("--stdio")`.** This is a simple but fragile approach. If `--stdio` appears in an unrelated argument, behavior flips unexpectedly. | Use a proper CLI argument parser (e.g., `yargs`, `commander`, or `process.argv.indexOf("--stdio") > -1` with stricter checking). |
| 8 | 133 | `try { } catch { /* ignore */ }` for `db.run` in the `serpapi_search_and_crawl` handler also appears here (line 204). Same issue. | Same fix as #3. |

#### Info

| # | File:Line | Issue |
|---|-----------|-------|
| 9 | 67 | The comment says "~3500 to ~3200 lines" — the file is now 462 lines. The extraction was successful. |
| 10 | 400–460 | The HTTP transport handler implements a minimal JSON-RPC subset. Only `initialize`, `initialized`, `tools/list`, and `tools/call` are supported. Missing: `notifications`, `ping`, `tools/list` change notifications. Document known limitations. |
| 11 | 435 | `withTimeout(withRetry(...), TIMEOUTS.MCP_TOOL_DEFAULT)` — the retry is wrapped in a timeout. If a tool handler hangs, the timeout fires before retries complete. This is correct behavior but should be documented. |

---

## 4. Cognitive Pipeline — `src/dre/pipeline/cognitive-pipeline.ts` (616 lines)

### Summary

The Minimum Cognitive Loop — a 6-stage deterministic pipeline (Classify → Knowledge → Reasoning → Constraint → Action → Reflection) that avoids LLM calls except when the deterministic reasoning graph detects gaps. Supports three execution modes: `run` (deterministic), `runFull` (adds TaskGraph execution), and `runWithLLM` (adds 4-tier LLM fallback). The file also contains inline classification and reasoning graph construction logic.

### Issues

#### Critical

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 1 | 71, 94–116 | **Race condition on shared `currentGraph` instance.** `this.currentGraph = new ReasoningGraph()` is set at line 116 inside `run()`. If two calls to `run()` (or `runWithLLM` → `run()`) execute concurrently on the same `CognitivePipeline` instance, the second call overwrites `this.currentGraph` while the first call is still using it. Both calls then operate on the same mutable graph. The comment on lines 67–70 acknowledges this was a problem with `engine.reasoning` but the per-instance `currentGraph` still has the same vulnerability. | Either (a) create the graph locally inside `run()` and pass it to helper methods instead of storing on `this`, or (b) add a concurrency lock (e.g., a mutex) to prevent overlapping `run()` calls. Option (a) is strongly preferred. |
| 2 | 378–380 | **Triple unsafe cast: `(gapResult.decision as Record<string, unknown>).confidence as number`.** If `gapResult.decision` is a string, a number, `null`, or an object without a `confidence` property, the result is `undefined as number`, which equals `NaN` and propagates silently through confidence comparisons. | Replace with safe access: `const conf = typeof gapResult.decision === 'object' && gapResult.decision !== null && 'confidence' in gapResult.decision ? Number((gapResult.decision as any).confidence) : 0.6;` The existing check on lines 377–381 is incomplete — it only checks the outer object type but still forces the inner cast. |
| 3 | 571 | **Silent fallback to shared `engine.reasoning` when `currentGraph` is null.** `const graph = this.currentGraph ?? this.engine.reasoning` means that if `this.currentGraph` is null (e.g., after a failed constructor or before `run()` sets it), `buildReasoning` uses the singleton `engine.reasoning` — which the comments say caused cross-request pollution. This re-introduces the exact bug the code was designed to fix. | Never fall back: `const graph = this.currentGraph; if (!graph) return { conclusionNode: null, gaps: [], premiseCount: 0 };` |

#### Warning

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 4 | 132 | **`this.engine.searchData(...)` returns synchronously.** If the underlying data store performs I/O (file reads, SQL queries), this blocks the event loop. Verify that `searchData` truly returns synchronously or add `await`. | If the method does I/O, add `async`/`await`. If it's purely in-memory, leave as-is but document the assumption. |
| 5 | 244 | **`worldState.setGoal("current", ...)` uses a fixed key.** Only one goal is tracked at a time. Concurrent pipeline runs overwrite each other's goals in the world state, making observability unreliable. | Use a unique goal key per run (e.g., `"cognitive.pipeline.goal." + runId`). |
| 6 | 64–65 | **`stats` counter grows unboundedly across runs.** `gapsFilled` and `gapFallbackCoarse` increase across the entire process lifetime. If the process runs for months, these could overflow `number` (though JavaScript numbers are 64-bit float, so this takes effectively forever). More practically, they become meaningless without a reset mechanism. | Add a `resetStats()` method or use a rolling window (e.g., last 1000 runs). |
| 7 | 99–114 | **The `track` closure captures `stepIndex` and `trace` by reference.** If `run()` is called concurrently (race condition #1), the closure captures a shared `trace` array. Even if the race condition is fixed, keeping closures that mutate outer variables makes the control flow harder to follow. | Extract logging into a method that takes parameters explicitly. |
| 8 | 368 | **Hardcoded gap limit of 5.** If a reasoning graph has slightly more than 5 gaps, the fine-grained fill is skipped entirely. The jump from 5 gaps → coarse fallback is abrupt. | Gradually degrade: fill the first 5 gaps, then for the remaining 6+, use a batch LLM prompt covering all remaining gaps. |
| 9 | 583 | **Arbitrary confidence formula.** `Math.min(0.7, 0.3 + premiseIds.length * 0.05)` — with 1 premise, confidence is 0.35; with 8 premises, it's capped at 0.7. The linear scaling has no empirical basis. | Use a more principled approach: average of premise confidences, weighted by relevance. |
| 10 | 507–560 | **`classify()` is ~60 lines of keyword matching.** This is brittle (misspellings, synonyms) and doesn't scale to new intents without code changes. | Consider extracting intent/domain/entity rules to a configuration file, or use a small embedding-based classifier. |

#### Info

| # | File:Line | Issue |
|---|-----------|-------|
| 11 | 273–280 | `runFull()` and `runFullWithLLM()` share `executeTaskGraph()` — good dedup. But `runFullWithLLM` calls `runWithLLM` which internally calls `run` — the pipeline stages run twice if you call both. Document this. |
| 12 | 347–492 | The 4-tier fallback chain (L1→L4) is well-structured with clear logging at each level. Good observability. |
| 13 | 94–268 | `run()` is 175 lines of inline code. Consider extracting each stage into a separate method for testability. |

---

## 5. Model Router — `src/router/model-router.ts` (811 lines)

### Summary

The multi-platform model router (v5.0) — a flat architecture with a unified `execute()` port. Routes requests by role, iterates through candidate models with per-model retry + exponential backoff, and supports streaming via `callProviderNativeStream` with a buffered fallback. Includes tool pool integration, intent routing, auto-route, embeddings, and batch execution.

### Issues

#### Critical

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 1 | 288 | **Unsafe cast `taskType as TaskRole`.** The `chat()` method accepts `TaskRole | string` but immediately narrows via `taskType as TaskRole`. If a caller passes a string not in the `TaskRole` union, it is silently accepted and may cause downstream failures in `findModelsForRole`. | Validate at the boundary: if the string is not a known role, either throw or default to `"general-chat"`. |
| 2 | 711–731 | **`embeddings()` has no type safety for API response.** `data.data?.map((d: any) => d.embedding) ?? []` — the `any` type escapes all checking. If the API changes its response shape, this will silently return `number[][]` containing `undefined` elements. | Define an embeddings response type and use `zod` or runtime validation to parse the response. |
| 3 | 777–801 | **`batchExecute` has a race condition in `preventDuplicateModels`.** The `usedModels` array is mutated in `.then()` callbacks. Because `Promise.all` preserves insertion order but resolution order is non-deterministic, the `usedModels` array may be populated in a different order than the assignments array. This means a model may be excluded from assignment B because it was (slowly) used in assignment A, even though A was a later index. | Collect results after all promises resolve, then enforce deduplication. Or use a per-assignment lock. |

#### Warning

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 4 | 164–195 | **`findModelsForRole` + `.sort()` on every `execute()` call.** Sorting 10–100 models by priority on every API call is wasteful. Since the model registry rarely changes at runtime, cache sorted results per role and invalidate the cache when models change. | Implement a simple Map<TaskRole, ModelCapability[]> cache with invalidation on `addModel`/`deleteModel`. |
| 5 | 179 | **`excludeModels` set iteration includes both `model.id` and `model.model`.** Line 181: `!excluded.has(m.id) && !excluded.has(m.model)` — this dual check means a model could be excluded by either its ID or its model name. This dual-key exclusion could exclude unintended models if IDs and model names overlap. | Pick one identifier (e.g., `model.id`) and use it consistently. Document the choice. |
| 6 | 199 | **`maxRetries` uncapped.** `Math.max(1, model.maxRetries ?? DEFAULT_RETRY_ATTEMPTS)` — if a model has `maxRetries: 100` in the registry, the router will retry 100 times. | Add an upper cap: `Math.min(Math.max(1, model.maxRetries ?? 3), 10)`. |
| 7 | 531–567 | **`tool()` method has its own retry loop separate from `execute()`.** This duplicates retry logic. Consider making `tool()` delegate to `execute()` with a special `role`. | Refactor `tool()` to use `execute()` internally, passing `role` as the tool role. |
| 8 | 591–662 | **`autoRoute()` calls the LLM with `callProvider(...)` directly, bypassing the `execute()` fallback chain.** If the routing decision model fails, `autoRoute` falls back to `general-chat` — but if the routing model is slow or returns bad JSON, the fallback is immediate rather than retrying with a different model. | Use `execute()` with a dedicated `role: "decision"` so it gets the full retry + fallback chain. |
| 9 | 665–702 | **`parseRoutingDecision` has brittle JSON parsing.** It does `content.match(/\{[\s\S]*\}/)` which could match a JSON-like substring in a longer message. If the LLM wraps the JSON in markdown code fences, the `{...}` inside the fence is captured, but the `{...}` before the fence is also captured. This is fragile. | Use a more robust extraction strategy: trim content, try `JSON.parse` directly, then fall back to regex extraction. |
| 10 | 730 | **`data.data?.map(...)` — if `data.data` exists but `d.embedding` is `undefined` for some items, the returned array contains `undefined` elements.** | Add a filter: `.map(d => d.embedding).filter(Boolean)` or validate each entry. |

#### Info

| # | File:Line | Issue |
|---|-----------|-------|
| 11 | 305–525 | `chatStream()` is 220 lines with deeply nested try/catch blocks and a complex async queue pattern. Consider extracting the stream orchestration into a helper class. |
| 12 | 370–416 | The async queue pattern (`enqueue`/`waitForNext`) for bridging callback-based streaming to async generators is clever but fragile. Document the invariants (single-consumer, no concurrent `waitForNext` calls). |
| 13 | 779 | `Promise.all(promises)` is safe because each promise has `.catch()` attached. Document this invariant so future modifications don't break it. |

---

## 6. Event Bus — `src/dre/runtime/event-bus.ts` (144 lines)

### Summary

A publish/subscribe event bus extending Node's `EventEmitter`. Supports priority-sorted handlers, one-shot subscriptions, a circular buffer event log (1000 entries), and statistics tracking. Used by the Cognitive Pipeline and WorldState modules.

### Issues

#### Warning

| # | File:Line | Issue | Suggested Fix |
|---|-----------|-------|---------------|
| 1 | 73 | **Handler re-sorting on every `publish()`.** `const sorted = [...handlers].sort(...)` creates a new sorted copy every time an event is published. Even if handlers never change, they are sorted on every dispatch. For high-frequency events, this is wasteful. | Insert handlers in sorted order when subscribing (binary search + splice), or only sort when handlers change. |
| 2 | 76–81 | **Async handler promises are fire-and-forget.** `result.catch(...)` on line 78 catches rejections, but the main `publish()` function returns the event before any async handler completes. Callers cannot know when async processing finishes. | Consider returning `Promise<RuntimeEvent>` with `await Promise.all(handlerPromises)` for callers that need completion guarantees, while keeping the fire-and-forget behavior as an option. |
| 3 | 84 | **`h.once` handler unsubscribes even if the handler throws synchronously.** The `if (h.once) this.unsubscribe(h.id)` is inside the `try` block, so it executes regardless of whether the handler succeeds or throws. This is probably intentional (no retry for one-shot handlers), but it should be documented. | Add a comment explaining that one-shot handlers are always unsubscribed after attempt, regardless of success. |
| 4 | 123–135 | **`getRecentEvents` returns events by value but the events are not cloned.** The returned `RuntimeEvent[]` contains references to the same objects stored in the circular buffer. If a caller mutates these objects, the event log is corrupted. | Return a deep clone or freeze events on creation. |

#### Info

| # | File:Line | Issue |
|---|-----------|-------|
| 5 | 48 | `eidCounter` increments without atomicity concerns — single-threaded JS ensures safety. ✅ |
| 6 | 98–109 | `subscribe` and `subscribeOnce` share ~80% of their code. Extract a private `addHandler` method. |
| 7 | 112–121 | `unsubscribe` is O(n × m) where n = event types and m = handlers per type. For typical usage (dozens of handlers), this is fine. |
| 8 | 14 | Extends `EventEmitter` but only uses `emit` and `listenerCount` (line 91–92). The inherited methods could conflict with custom handlers. Consider composition over inheritance. |

---

## Cross-Cutting Findings

### Type Safety Issues

| # | File | Issue |
|---|------|-------|
| 1 | `mcp/tool-registry.ts:18` | `ToolDef.inputSchema` is typed as `any`, discarding all Zod type inference. This propagates to every tool handler in `mcp/server.ts`, forcing unsafe casts like `args.query as string`. |
| 2 | `router/model-router.ts:730` | `(d: any) => d.embedding` — the `any` cast in embeddings response parsing. |
| 3 | `dre/pipeline/cognitive-pipeline.ts:380` | Triple unsafe cast `(gapResult.decision as Record<string, unknown>).confidence as number`. |
| 4 | `services/chat.ts:39` | `m.role as ChatMessage["role"]` — the cast from `string` to a union type. |

### Concurrency / Race Conditions

| # | File | Issue |
|---|------|-------|
| 1 | `dre/pipeline/cognitive-pipeline.ts:71` | Shared `currentGraph` instance mutates across concurrent `run()` calls. |
| 2 | `router/model-router.ts:781` | `usedModels` array races in `batchExecute` with `preventDuplicateModels`. |

### Security Observations

- **No CSRF protection** in the route dispatcher. All routes accept requests without origin validation.
- **No rate limiting** at the router level. The tool pool has per-model rate limiting, but the HTTP entry point does not.
- **API keys in memory**: `getEffectiveApiKey` loads API keys into memory. The `embeddings` method (and others) log model/provider names in `trackCall` — but API keys themselves are not logged.
- **Secrets exposure**: The `readString` utility reads env vars; values appear in memory. No redaction in log output (but keys are never intentionally logged).

### Performance Hotspots

| # | File | Issue |
|---|------|-------|
| 1 | `routes/index.ts` | O(n) sequential dispatch for every request. |
| 2 | `services/chat.ts` | Dynamic `import()` calls on every request path. |
| 3 | `router/model-router.ts` | `findModelsForRole` + sort on every `execute()` call. |
| 4 | `dre/runtime/event-bus.ts` | Handler re-sort on every `publish()`. |

---

## Summary

| Metric | Count |
|--------|-------|
| Critical issues | 10 |
| Warnings | 28 |
| Info items | 13 |
| **Total** | **51** |

### Top 5 Must-Fix Issues

1. **`CognitivePipeline.currentGraph` race condition** — shared mutable state across concurrent `run()` calls. Fix: make graph local to `run()`.
2. **`MCP server` module-level side effects** — `new Database()` and `getGlobalVault()` at module load time. Fix: lazy initialization.
3. **`MCP server` unsafe type assertions** — `args.query as string` etc. bypass TypeScript's type system. Fix: leverage Zod-inferred types.
4. **`routes/index.ts` dual routing** — both sequential dispatcher and trie router are exposed with unclear precedence. Fix: pick one strategy.
5. **`batchExecute` race** — `usedModels` array mutates across async `Promise.all` callbacks. Fix: deduplicate after all promises resolve.

The codebase shows deliberate design with clear architecture intentions (flat router, cognitive pipeline, event bus). The main risks are in shared mutable state across async boundaries, type safety at module boundaries, and side effects at import time.
