# Consciousness Module

> Self-reflection / cleanup / skill-promotion background agent for OpenClaw.
> Designed to be **strictly background** and **strictly orchestrating** — never
> re-implements memory cleanup, prompt engineering, or model routing.

## Purpose

Three jobs, one loop, no chat hot-path overhead:

1. **Observe** — passively record what the user is doing (intent patterns, vault writes)
2. **Reflect** — when triggered, ask the LLM for a 1-paragraph status + next goal
3. **Act** — promote recurring patterns to skills, distill/archive stale memory

## Files

| File | Purpose | Approx LOC |
|---|---|---|
| `types.ts` | All shared types: `SelfState`, `TriggerConfig`, `ReflectionOutcome`, `PatternCandidate` | 100 |
| `state-store.ts` | Blackboard-backed self-state (mood, focus, counters) | 80 |
| `activity-tracker.ts` | In-memory hot counters: idle, intent hits, sample inputs | 100 |
| `trigger.ts` | Pure decision: should we reflect now? (idle, schedule, token-budget, manual) | 60 |
| `skill-promoter.ts` | Pick frequent (intent, agent) → `PromptEngineer.generateSkillWithHermes` → `SkillRegistry.register` | 130 |
| `memory-curator.ts` | Distill stale conversations, dedupe atomics, flag orphans — delegates to existing `MemoryDistiller` + `MemoryArchiver` | 160 |
| `reflection-loop.ts` | The think/reflect/act cycle — one `router.executeWithRole("general-chat", …)` per cycle | 200 |
| `index.ts` | Public API: `getConsciousness()`, `observe()`, `triggerNow()`, `status()` | 150 |
| `*-shim.ts` (5 files) | Lazy accessors to break circular imports and keep first-call cost low | ~30 each |

## Trigger Conditions

```
┌────────────────────────────────────────────────────────────────────┐
│  Trigger source        │  Where it lives                  │  Where it's set up              │
├────────────────────────┼──────────────────────────────────┼─────────────────────────────────┤
│  idle time             │  ActivityTracker.getIdleMs()      │  index.ts tick("poll")          │
│  schedule (Bun.cron)   │  registerCronTick()               │  cron/scheduler.ts (one line)   │
│  token budget          │  StateStore.tokensSpentThisSession│  index.ts tick("poll")          │
│  manual / API          │  POST /consciousness/reflect      │  routes/consciousness.ts        │
│  quiet hours           │  isWithinQuietHours(start,end)    │  ConsciousnessOptions           │
└────────────────────────────────────────────────────────────────────┘
```

Default config (`types.ts`):
- `idleThresholdMs`: 15 min
- `tokenBudget`: 50 000 tokens
- `scheduleCron`: `0 */6 * * *` (every 6 hours)
- `enabled`: true

## Integration Points (no new abstractions)

| Concern | Existing subsystem | Exact call |
|---|---|---|
| Self-state | `SharedBlackboard` | `getGlobalBlackboard().write("consciousness:self_state", …)` |
| Recent activity | in-memory (no new storage) | `ActivityTracker` counters |
| LLM reasoning | `router.executeWithRole` | `router.executeWithRole("general-chat", messages, {temperature: 0.3})` |
| Skill draft | `PromptEngineer` | `engineer.generateSkillWithHermes(name, desc, triggers)` |
| Skill registration | `SkillRegistry` | `registry.register(skillDef)` |
| Skill persistence | filesystem + `loadSkillsFromDirectories` | write to `openclaw-memory/03-Resources/skills/auto-*.json` |
| Memory write | `VaultManager` | `vault.writeNote(path, content, {type: "consciousness-reflection"})` |
| Distill stale convos | `MemoryDistiller` | `distiller.distillConversation(path)` |
| Move to archive | `MemoryArchiver` | `archiver.archive()` |
| Atomic-note collisions | `SQLiteMemory` | `sqlite.listByCategory + deleteNote` |
| Token tracking | `getTokenTracker()` (passive, via router) | automatic |
| Cron tick | `Bun.cron` | `registerCronTick()` callback from `cron/scheduler.ts` |
| Chat-route observation | `routes/chat.ts` (1-line hook) | `getConsciousness().observe(input, intent)` |
| Vault-write observation | `VaultFileWatcher` (1-line hook) | `getConsciousness().observeVaultWrite()` |

## Conflict Avoidance

| Conflict risk | Mitigation |
|---|---|
| Intercepts chat requests | `observe()` is a sync O(1) counter bump. No async work in the hot path. |
| Overwrites user atomic notes | All curator insights write under `00-Meta/consciousness/...` (different PARA category from `03-Resources/atomic-notes/`) |
| Competes with `MemoryArchiver` | Curator **delegates to** `archiver.archive()` instead of moving files itself |
| Competes with `IntentRouter` | No `recognizeIntent` / `buildAgentMessages` is called; `observe()` receives the already-computed `IntentResult` |
| Interferes with `routes/index.ts` | All consciousness routes live in a separate file `routes/consciousness.ts`, mounted only when `Consciousness.enabled === true` |
| Competes with existing Scheduler | `Bun.cron` registration is via **callback** — `cron/scheduler.ts` calls `getConsciousness().registerCronTick((cron) => …)` in one line, no edits to the scheduler logic |
| Adds new dependencies | Zero. Only `path`/`fs` (already used by other vault modules) and existing internal modules |
| Live model API in tests | `Router.executeWithRole` is only called inside `ReflectionLoop.runOnce`, which is invoked from `tick()` / `triggerNow()`. Tests can skip reflection entirely by setting `enabled: false`. |
| Runs during user focus time | `quietHours: {startHour, endHour}` suppresses cycles |

## Lifecycle Hooks (minimal code change required)

### `src/main.ts` (3 lines after vault init)

```typescript
import { getConsciousness } from "./agents/consciousness/index.js";
// … after `vault = new VaultManager(...)`:
const consciousness = getConsciousness();
await consciousness.start({ enabled: process.env.CONSCIOUSNESS_ENABLED !== "false" });
registerShutdownHook({ name: "consciousness", handler: () => consciousness.stop(), priority: 60 });
```

### `src/cron/scheduler.ts` (1 line inside the cron-registration block)

```typescript
import { getConsciousness } from "../agents/consciousness/index.js";
getConsciousness().registerCronTick(async (cron) => {
  await getConsciousness().triggerNow(`schedule:${cron}`);
});
```

### `src/routes/chat.ts` (1 line after `recognizeIntent`)

```typescript
import { getConsciousness } from "../agents/consciousness/index.js";
// … in handleChat, after `const intent = recognizeIntent(messages)`:
getConsciousness().observe(userInput, intent);
```

### `src/memory/file-watcher.ts` (1 line in the `onEvent` callback)

```typescript
import { getConsciousness } from "../agents/consciousness/index.js";
fileWatcher.start((event, path) => {
  getConsciousness().observeVaultWrite();
  wsManager.broadcast({ ... });
});
```

## HTTP API (optional)

Mount the following in `src/routes/index.ts` only when `getConsciousness().status().enabled`:

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/consciousness/status` | — | `{ running, lastReflectionAt, lastOutcome, stateExists, config }` |
| POST | `/consciousness/reflect` | `{ reason?: string }` | force a reflection cycle, returns `ReflectionOutcome` |
| GET | `/consciousness/state` | — | raw `SelfState` from blackboard |
| DELETE | `/consciousness/state` | — | clear self-state (test/reset) |
| GET | `/consciousness/activity` | — | `ActivityTracker.stats()` |

## Public API

```typescript
import { getConsciousness } from "./agents/consciousness/index.js";

const c = getConsciousness();
await c.start({ enabled: true, idleThresholdMs: 15 * 60 * 1000 });

c.observe(userInput, intentResult);          // O(1) sync — call from chat route
c.observeVaultWrite();                       // O(1) sync — call from file watcher

const outcome = await c.triggerNow("manual:foo");  // async
const s = c.status();                         // sync — for /consciousness/status

await c.stop();
```

## What's NOT in scope

- Frontend UI (Tauri 2.0 + React) — leave for a follow-up; the HTTP API is sufficient
- Token-budget accounting for normal user requests (only reflection tokens are tracked here)
- Cross-process consciousness (only one OpenClaw process per machine for v1)
- Replacing `MemoryArchiver` / `MemoryDistiller` / `PromptEngineer` — those are the *implementations* this module orchestrates

## Future Work (deferred)

- Per-pattern LLM judge: ask the LLM to confirm a pattern is worth promoting, rather than just thresholding
- A `01-Projects/consciousness-roadmap.md` note generated at every cycle so the user can audit what changed
- Optional weekly "deep" cycle that calls `router.executeWithRole("research", …)` instead of `general-chat`
- WebSocket broadcast of cycle outcomes so the dashboard shows real-time "agent is reflecting" UI
