/**
 * DRE — Deterministic Reasoning Engine (确定性推理引擎)
 *
 * 核心原则: 确定性、可追溯、可回放、可审计、防幻觉
 *
 * 架构:
 * - VFS: 虚拟文件系统 (统一挂载知识库/项目/缓存)
 * - Storage: SQLite 范式存储 + 向量索引
 * - Pipeline: 三段甄别 (预筛 → 网络校验 → LLM 自推理)
 * - Consciousness: 意识流 (工作记忆/短期记忆/长期记忆/反思)
 * - KG: 知识图谱 (实体/关系/子图检索)
 * - Persona: 动态角色加载 (约束+心智模型+能力, 替代 AgentHarness)
 * - SystemResource: 通用资源预算 (替代 VRAM 硬件检测)
 *
 * 目标: 硬件无关, 可部署在 CPU/GPU/云端/移动端
 */

// 核心模块导出
export { VFS, type Inode, type IBackend, NodeType } from "./vfs.js";
/** @alias VFS — 简化存储适配器 (单后端 SqliteBackend) */
export { VFS as StorageAdapter } from "./vfs.js";
export { SqliteBackend } from "./storage/sqlite-backend.js";
export { KnowledgeStore, BehaviorKnowledge, HypothesisManager, ProcedureKnowledge, type KnowledgeNode, type KnowledgeRevision, type KGEdge, type KnowledgeParadigm, type Behavior, type Prediction, type Hypothesis, type Procedure, type ProcedureStep } from "./storage/knowledge-store.js";
export { ConsciousnessStream, WorkingMemory, EpisodicMemory, ReflectionQueue, type MemoryItem, type ReflectionResult, type ConsciousnessState } from "./consciousness/stream.js";
export { Pipeline, type KnowledgeItem, type RiskReport, type Evidence, type VerificationResult } from "./pipeline/pipeline.js";
export { KnowledgeGraph, type KGNode, type KGEdge as KGEdgeType } from "./kg/graph.js";

export { LLMClient, type LLMConfig, type LLMResponse, type ConstrainedGenerationOptions } from "./llm/client.js";
export { DREngine, type DREConfig } from "./engine.js";
export { Kernel, type KernelConfig, type KernelStatus } from "./kernel.js";
export { MentalModelPool, type MentalModel, type ModelPattern, type ModelRule, type Simulation, type SimulationStep } from "./mental-model/pool.js";
export { ReasoningGraph, type ReasoningNode, type ReasoningGap } from "./reasoning/graph.js";
export { ConstraintSolver, RESOURCE_CONSTRAINTS, AUDIT_CONSTRAINTS, type Constraint, type ConstraintCheckResult, type ConstraintViolation } from "./constraint/solver.js";
export { ActorSystem, createDefaultActorSystem, KnowledgeActorBehavior, ConstraintActorBehavior, MentalModelActorBehavior, ReasoningActorBehavior, type ActorMessage, type ActorBehavior } from "./actor/system.js";
export { CognitivePipeline, type CognitiveStep, type CognitiveLoopResult } from "./pipeline/cognitive-pipeline.js";
export { TaskGraph, type Task, type TaskStatus, type TaskGraphSnapshot, type TaskGraphStatus } from "./pipeline/task-graph.js";
export { eventBus, type RuntimeEvent, type EventHandler, type EventPriority } from "./runtime/event-bus.js";
export { worldState, type MentalIntent, type MentalGoal, type MentalBelief, type MentalHypothesis } from "./runtime/world-state.js";
export { atomStore, type Atom, type AtomKind, type AtomRelation, type AtomConfidence } from "./runtime/atom-engine.js";
export { knowledgeNetwork, type KnowledgeEntity, type EntityKind, type EntityState, type Evidence as KnowledgeEvidence, type Behavior as KnowledgeBehavior, type Prediction as KnowledgePrediction, type Hypothesis as KnowledgeHypothesis, type TimelineEntry, type EntityLink } from "./runtime/knowledge-network.js";
export { scheduler, type ScheduledTask, type TaskStatus as SchedulerTaskStatus, type TaskPriority } from "./runtime/scheduler.js";
export { ruleEngine, type Rule } from "./runtime/rule-engine.js";
export { capabilityRegistry, type Capability, type CapabilityProvider, type CapabilityContract } from "./runtime/capability-registry.js";
export { contextEngine } from "./runtime/context-engine.js";

// v3.0.0 新增模块
export { ResourceBudgetManager, getResourceBudgetManager, type SystemResource, type ResourceCheckResult } from "./system-resource.js";
export { PersonaLoader, PromptTemplateStore, createDefaultPromptStore, DEFAULT_PROMPT_TEMPLATES, SECURITY_PERSONA_CONFIG, CREATIVE_PERSONA_CONFIG, GENERAL_PERSONA_CONFIG } from "./persona/index.js";
export type { PersonaMode, PersonaConfig, LoadedPersona, PersonaContext, PersonaLoaderConfig, PromptTemplate, TemplateVariables } from "./persona/index.js";
export { ConfigLoader, type ConfigSource } from "./config.js";
export { DataUnifier, dataUnifier, type DataItem, type SearchOptions, type SearchResult } from "./runtime/data-unifier.js";
export { PRESETS, LLM_PRESETS } from "./presets.js";
export { DREError, DREValidationError, DREResourceError, DREPipelineError, DRELLMError, DREConsistencyError, DRETaskError, wrapDREError } from "./errors.js";

// 版本
export const DRE_VERSION = "3.1.0";
