/**
 * OpenClaw Runtime — Public API
 *
 * This is the new architecture. Everything is Runtime First.
 *
 * Usage:
 *   import { initRuntime, eventBus, worldState, tickEngine, scheduler } from "./runtime/index.js";
 *
 *   // Initialize once at startup
 *   initRuntime();
 *
 *   // Start the runtime loop
 *   tickEngine.start(1000);
 */

// Kernel (Event Bus, World State, Tick Engine, Actor Runtime)
export {
  eventBus,
  worldState,
  tickEngine,
  actorRuntime,
  initRuntime,
  getRuntimeStatus,
} from "./kernel.js";
export type {
  RuntimeEvent,
  EventHandler,
  EventPriority,
  TickPhase,
  TickContext,
  Actor,
  ActorMessage,
  ActorState,
} from "./kernel.js";

// Atom Engine
export { atomStore, parseCodeToAtoms, parseMarkdownToAtoms } from "./atom-engine.js";
export type { Atom, AtomKind, AtomRelation, AtomConfidence } from "./atom-engine.js";

// Scheduler
export { scheduler } from "./scheduler.js";
export type { ScheduledTask, TaskStatus, TaskPriority } from "./scheduler.js";

// Deterministic Cognitive Pipeline
export { cognitivePipeline } from "./scheduler.js";
export type { PipelineStage, PipelineContext } from "./scheduler.js";

// Projection Layer
export { projectionRegistry, initProjections } from "./projection-layer.js";
export type { Projection } from "./projection-layer.js";

// Context Engine
export { contextEngine } from "./context-engine.js";
export type { RuntimeContext } from "./context-engine.js";
