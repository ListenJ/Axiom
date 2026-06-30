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

// Actors
export { initActors } from "./actors.js";
export { initSpecializedActors } from "./specialized-actors.js";

// Constraint Solver
export { constraintSolver, initConstraints } from "./constraint-solver.js";
export type { Constraint, ConstraintViolation, SolveResult, ConstraintType } from "./constraint-solver.js";

// Capability Registry
export { capabilityRegistry, initCapabilities } from "./capability-registry.js";
export type { Capability, CapabilitySearchResult, CapabilityProvider } from "./capability-registry.js";

// Knowledge Network
export { knowledgeNetwork } from "./knowledge-network.js";
export type { KnowledgeEntity, EntityState, Evidence, TimelineEntry, EntityKind } from "./knowledge-network.js";

// Memory Engine
export { memoryEngine } from "./memory-engine.js";
export type { Observation, Episode, Pattern, Knowledge, Skill, Policy, MemoryStage } from "./memory-engine.js";

// Rule Engine
export { ruleEngine, initRules } from "./rule-engine.js";
export type { Rule, RuleType, RuleMatch, RuleExecutionResult } from "./rule-engine.js";

// Agent Executor
export { agentExecutor } from "./agent-executor.js";
export type { AgentTask, AgentObservation, AgentExecution, AgentReport, AgentState } from "./agent-executor.js";

// Verification Engine
export { verificationEngine } from "./verification-engine.js";
export type { VerificationReport, VerificationCheck, VerificationIssue, VerificationStage, VerificationVerdict } from "./verification-engine.js";

// Chat Actor
export { getChatActor } from "./chat-actor.js";
export type { ChatRequest, ChatResponse } from "./chat-actor.js";

// Mental Model
export { mentalModelManager, initMentalModels } from "./mental-model.js";
export type { MentalModel } from "./mental-model.js";

// Reasoning Graph
export { reasoningGraphBuilder } from "./reasoning-graph.js";
export type { ReasoningGraph, ReasoningNode, ReasoningEdge } from "./reasoning-graph.js";
