/**
 * 心智模块 MCP 工具 — mind_synapse_*
 *
 * 将神经突触心智模块（创建/激活/扩散/建议/校验/追溯）暴露为 MCP 工具。
 *
 * 内核收敛（ADR-012）：突触引擎属**核心内部**，由唯一内核拥有者（DRE daemon）持有；
 * 本模块只保留工具**规格**，运行模式二选一：
 *   - daemon：`engineProvider` 注入其唯一 synapse 引擎（本地执行）；
 *   - MCP：`forward` 把 `{name,args}` 转发到 daemon（薄转发）。
 * 故本文件对 `src/dre/synapse` 仅作 **type-only** 引用（运行时不耦合）。
 */
import { z } from "zod";
import type { ToolRegistry, ToolDef } from "../tool-registry.js";
import type { SynapseEngine, SynapseNodeType } from "../../dre/synapse/index.js";
import { logger } from "../../utils/logger.js";

/** 注入式引擎源：daemon 用它把自己的唯一 synapse 引擎交给处理器 */
let injectedEngine: (() => SynapseEngine) | null = null;
export function setMindEngineProvider(p: (() => SynapseEngine) | null): void {
  injectedEngine = p;
}
function getEngine(): SynapseEngine {
  if (!injectedEngine) {
    throw new Error("mind-tools: 引擎未装配（daemon 应注入 engineProvider；MCP 应走 forward）");
  }
  return injectedEngine();
}

export interface MindToolRegistrationOptions {
  /** 本地执行：把唯一 synapse 引擎交给处理器（daemon 用） */
  engineProvider?: () => SynapseEngine;
  /** 远程转发：把 {name,args} 交给唯一内核拥有者（MCP 进程用） */
  forward?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const nodeType = z.enum(["concept", "skill", "memory", "scene", "goal"]);

export function registerMindTools(registry: ToolRegistry, opts?: MindToolRegistrationOptions): void {
  // 保留字面量注册形态（供 D10 能力声明抽取器识别）；再按运行模式注册。
  const collector = {
    specs: [] as ToolDef[],
    add(t: ToolDef) {
      this.specs.push(t);
      return this;
    },
  };
  if (opts?.engineProvider) injectedEngine = opts.engineProvider;

  collector.add({
    name: "mind_synapse_create",
    capability: ["db.write"],
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

  collector.add({
    name: "mind_synapse_activate",
    capability: ["db.write"],
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

  collector.add({
    name: "mind_synapse_spread",
    capability: ["db.write"],
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

  collector.add({
    name: "mind_synapse_suggest",
    // 建议本身是排序，但每次命中会落一条 suggest trace（src/dre/synapse/engine.ts:225）
    capability: ["db.write"],
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

  collector.add({
    name: "mind_synapse_verify",
    capability: ["internal"],
    description: "校验突触数据完整性（重算哈希比对 + 验证链完整性），返回可追溯结论",
    inputSchema: { synapseId: z.string().describe("突触 id") },
    handler: async (args: Record<string, unknown>) => {
      const verdict = getEngine().verify(args.synapseId as string);
      return { valid: verdict.valid, reason: verdict.reason };
    },
  });

  collector.add({
    name: "mind_synapse_trace",
    capability: ["internal"],
    description: "追溯突触的完整验证链（创建/激活/扩散/衰减/建议记录）",
    inputSchema: { synapseId: z.string().describe("突触 id") },
    handler: async (args: Record<string, unknown>) => {
      const traces = getEngine().trace(args.synapseId as string);
      return { traces };
    },
  });

  collector.add({
    name: "mind_suggest",
    // 无 recordScene 时也必须 db.write：advisor.suggest → suggestNextSteps 落 suggest trace
    capability: ["db.write"],
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

  for (const spec of collector.specs) {
    registry.add(
      opts?.forward
        ? { ...spec, handler: (args: Record<string, unknown>) => opts.forward!(spec.name, args) }
        : spec,
    );
  }

  logger.info("[MindTools] registered mind_synapse_* tools (" + (opts?.forward ? "forward→daemon" : "local engine") + ")");
}
