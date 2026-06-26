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
 * - Harness: Agent 编排 (Planner/Coder/Retriever/Reflector)
 *
 * 目标硬件: Intel/AMD PC + NVIDIA RTX 3050 Ti Laptop (4GB VRAM)
 * 模型策略: Qwen3-1.7B Q4_K_M 主推理 + Qwen3-0.6B 甄别 + KV Cache Q8
 */

// 核心模块导出
export { VFS, type Inode, type IBackend, NodeType } from "./vfs.js";
export { SqliteBackend } from "./storage/sqlite-backend.js";
export { KnowledgeStore, type KnowledgeNode, type KnowledgeRevision, type KGEdge } from "./storage/knowledge-store.js";
export { ConsciousnessStream, WorkingMemory, EpisodicMemory, ReflectionQueue, type MemoryItem } from "./consciousness/stream.js";
export { Pipeline, type KnowledgeItem, type RiskReport, type Evidence, type VerificationResult } from "./pipeline/pipeline.js";
export { KnowledgeGraph, type KGNode, type KGEdge as KGEdgeType } from "./kg/graph.js";
export { AgentHarness, PlannerAgent, CoderAgent, ReflectorAgent, type Tool, type AgentResponse } from "./harness/agent.js";
export { LLMClient, type LLMConfig, type LLMResponse, type ConstrainedGenerationOptions } from "./llm/client.js";
export { DREngine, type DREConfig } from "./engine.js";

// 版本
export const DRE_VERSION = "1.0.0";
