/**
 * 心智模块 MCP 工具 — mind_synapse_*
 *
 * 将神经突触心智模块（创建/激活/扩散/建议/校验/追溯）暴露为 MCP 工具，
 * 供外部 Agent、skill、插件通过工具注册表调用（微内核插件化）。
 */
import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { createSynapseEngine, type SynapseEngine, type SynapseNodeType } from "../../dre/synapse/index.js";
import { readString } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

const SYNAPSE_DB = readString("AXIOM_SYNAPSE_DB", "./data/synapse.db");

let engine: SynapseEngine | null = null;

function getEngine(): SynapseEngine {
  if (!engine) engine = createSynapseEngine(SYNAPSE_DB);
  return engine;
}

/** 测试/进程级重置 */
export function resetMindEngine(): void {
  engine = null;
}

const nodeType = z.enum(["concept", "skill", "memory", "scene", "goal"]);

export function registerMindTools(registry: ToolRegistry): void {
  registry.add({
    name: "mind_synapse_create",
    description: "创建神经突触（源节点 → 目标节点的加权关联），带可校验哈希",
    inputSchema: {
      sourceId: z.string().describe("源节点 id（概念/技能/记忆/场景/目标）"),
      targetId: z.string().describe("目标节点 id"),
      sourceType: nodeType.optional().default("concept").describe("源节点类型"),
      targetType: nodeType.optional().default("skill").describe("目标节点类型"),
      weight: z.number().min(0).max(1).optional().default(0.5).describe("基础强度 0-1"),
    },
    handler: async (args: Record<string, unknown>) => {
      const s = getEngine().createSynapse(args.sourceId as string, args.targetId as string, {
        sourceType: args.sourceType as SynapseNodeType | undefined,
        targetType: args.targetType as SynapseNodeType | undefined,
        weight: args.weight as number | undefined,
      });
      return { id: s.id, sourceId: s.sourceId, targetId: s.targetId, weight: s.weight, verifyHash: s.verifyHash };
    },
  });

  registry.add({
    name: "mind_synapse_activate",
    description: "激活某节点的全部出边突触（Hebbian 增强 + 全局轻微衰减）",
    inputSchema: {
      sourceId: z.string().describe("源节点 id"),
      event: z.string().default("manual").describe("触发事件描述"),
    },
    handler: async (args: Record<string, unknown>) => {
      const enhanced = getEngine().activate(args.sourceId as string, (args.event as string | undefined) ?? "manual");
      return { enhanced: enhanced.map((s) => ({ id: s.id, targetId: s.targetId, weight: s.weight, activationCount: s.activationCount })) };
    },
  });

  registry.add({
    name: "mind_synapse_spread",
    description: "扩散激活：从种子节点沿突触 BFS，强度随跳数衰减（扩散/独立思考）",
    inputSchema: {
      seedIds: z.array(z.string()).min(1).describe("种子节点 id 列表"),
      event: z.string().default("spread").describe("触发事件"),
      maxHops: z.number().int().min(1).max(5).optional().default(3).describe("最大跳数"),
    },
    handler: async (args: Record<string, unknown>) => {
      const result = getEngine().spreadActivation(args.seedIds as string[], (args.event as string | undefined) ?? "spread", { maxHops: args.maxHops as number | undefined });
      return { activated: result.activated, totalActivation: result.totalActivation };
    },
  });

  registry.add({
    name: "mind_synapse_suggest",
    description: "基于场景+目标给出确定性下一步建议（可追溯 via 路径与理由）",
    inputSchema: {
      scene: z.string().describe("当前场景描述"),
      goal: z.string().describe("任务目标描述"),
      limit: z.number().int().min(1).max(20).optional().default(5).describe("返回条数"),
    },
    handler: async (args: Record<string, unknown>) => {
      const suggestions = await getEngine().suggestNextSteps(args.scene as string, args.goal as string, { limit: args.limit as number | undefined });
      return { suggestions };
    },
  });

  registry.add({
    name: "mind_synapse_verify",
    description: "校验突触数据完整性（重算哈希比对 + 验证链完整性），返回可追溯结论",
    inputSchema: { synapseId: z.string().describe("突触 id") },
    handler: async (args: Record<string, unknown>) => {
      const verdict = getEngine().verify(args.synapseId as string);
      return { valid: verdict.valid, reason: verdict.reason };
    },
  });

  registry.add({
    name: "mind_synapse_trace",
    description: "追溯突触的完整验证链（创建/激活/扩散/衰减/建议记录）",
    inputSchema: { synapseId: z.string().describe("突触 id") },
    handler: async (args: Record<string, unknown>) => {
      const traces = getEngine().trace(args.synapseId as string);
      return { traces };
    },
  });

  registry.add({
    name: "mind_suggest",
    description: "心智模块×自进化：基于场景+目标给出下一步建议（突触扩散激活，可追溯 via 路径），支持把场景/目标写入突触后建议",
    inputSchema: {
      scene: z.string().describe("当前场景描述"),
      goal: z.string().describe("任务目标描述"),
      limit: z.number().int().min(1).max(20).optional().default(5).describe("返回条数"),
      recordScene: z.boolean().optional().default(false).describe("true 时把场景关键词写入突触（用于后续自我进化）"),
    },
    handler: async (args: Record<string, unknown>) => {
      const { createMindAdvisor } = await import("../../self-evolve/mind-suggest.js");
      const eng = getEngine();
      if (args.recordScene) {
        const { tokenize } = await import("../../self-evolve/engine.js");
        for (const t of tokenize(args.scene as string).slice(0, 8)) {
          if (t.length >= 2) eng.createSynapse("scene:" + t, "scene:current", { sourceType: "scene", targetType: "scene", weight: 0.5 });
        }
      }
      const advisor = createMindAdvisor({ synapse: eng });
      const result = await advisor.suggest(args.scene as string, args.goal as string, { limit: args.limit as number | undefined });
      return { suggestions: result.suggestions, lessons: result.lessons };
    },
  });

  logger.info("[MindTools] registered mind_synapse_* tools (db=" + SYNAPSE_DB + ")");
}
