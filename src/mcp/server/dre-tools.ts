import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { Kernel, CognitivePipeline, TaskGraph, ConfigLoader, type KnowledgeItem, type PersonaMode, type AtomKind } from "../../dre/index.js";
import { getResourceBudgetManager } from "../../dre/system-resource.js";

let kernel: Kernel | null = null;

function getKernel(): Kernel {
  if (!kernel) {
    const config = new ConfigLoader().toKernelConfig();
    kernel = new Kernel({ ...config, tickInterval: 10000, autoTick: true });
    kernel.init().catch((err) => console.warn("[DRE] Kernel init failed", (err as Error).message));
  }
  return kernel;
}

export async function shutdownKernel(): Promise<void> {
  if (kernel) {
    await kernel.shutdown();
    kernel = null;
  }
}

export function getKernelInstance(): Kernel | null {
  return kernel;
}

export function registerDreTools(registry: ToolRegistry): void {
  registry.add({
    name: "dre_write_knowledge",
    description: "写入知识 (触发三段甄别: 预筛→网络校验→LLM自推理，需要本地 LLM 服务)",
    inputSchema: {
      title: z.string().describe("知识标题"),
      content: z.string().describe("知识内容"),
      domain: z.string().optional().default("general").describe("分类: math/cs/bio/..."),
      paradigm: z.enum(["fact", "rule", "procedure", "concept"]).optional().default("fact").describe("范式"),
      sourceType: z.enum(["manual", "web", "llm", "ocr", "kg"]).optional().default("manual").describe("来源类型"),
      sourceUri: z.string().optional().describe("来源 URI"),
    },
    handler: async (args) => {
      try {
        const dre = getKernel().getEngine();
        const item: KnowledgeItem = {
          id: `kb-${Date.now()}`,
          title: args.title as string,
          content: args.content as string,
          domain: (args.domain as string) || "general",
          paradigm: (args.paradigm as KnowledgeItem["paradigm"]) || "fact",
          sourceType: (args.sourceType as KnowledgeItem["sourceType"]) || "manual",
          sourceUri: args.sourceUri as string,
        };

        const result = await dre.writeKnowledge(item);
        return {
          accepted: result.accepted,
          nodeId: item.id,
          verification: result.verification ? {
            verdict: result.verification.verdict,
            confidence: result.verification.confidence,
            chain: result.verification.chain,
            evidenceRefs: result.verification.evidenceRefs,
          } : undefined,
        };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
          fallback: "memory_write",
          message: "DRE 引擎不可用 (需要本地 LLM 服务)。请使用 memory_write 将知识写入 Vault。",
        };
      }
    },
  });

  registry.add({
    name: "dre_read_knowledge",
    description: "读取知识条目",
    inputSchema: {
      nodeId: z.string().describe("知识条目 ID"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const node = dre.readKnowledge(args.nodeId as string);
      if (!node) {
        return { success: false, error: "Knowledge node not found" };
      }
      return {
        success: true,
        data: {
          nodeId: node.nodeId,
          title: node.title,
          content: node.content.slice(0, 5000),
          domain: node.domain,
          paradigm: node.paradigm,
          confidence: node.confidence,
          sourceType: node.sourceType,
          revision: node.revision,
          isVerified: node.isVerified,
        },
      };
    },
  });

  registry.add({
    name: "dre_search_knowledge",
    description: "搜索知识库",
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      domain: z.string().optional().describe("分类过滤"),
      paradigm: z.enum(["fact", "rule", "procedure", "concept"]).optional().describe("范式过滤"),
      minConfidence: z.number().optional().describe("最低置信度"),
      limit: z.number().optional().default(10).describe("返回数量"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const results = dre.searchData(args.query as string, {
        domain: args.domain as string,
        paradigm: args.paradigm as string,
        minConfidence: args.minConfidence as number,
        limit: args.limit as number,
      });
      return results.knowledgeNodes.map((r) => ({
        nodeId: r.nodeId,
        title: r.title,
        domain: r.domain,
        paradigm: r.paradigm,
        confidence: r.confidence,
        isVerified: r.isVerified,
      }));
    },
  });

  registry.add({
    name: "dre_subgraph",
    description: "知识图谱子图检索 (BFS)",
    inputSchema: {
      nodeId: z.string().describe("起始节点 ID"),
      depth: z.number().optional().default(2).describe("遍历深度"),
      maxNodes: z.number().optional().default(50).describe("最大节点数"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const nodes = dre.subgraph(args.nodeId as string, args.depth as number, args.maxNodes as number);
      return nodes.map((n) => ({
        nodeId: n.nodeId,
        title: n.title,
        domain: n.domain,
        confidence: n.confidence,
      }));
    },
  });

  registry.add({
    name: "dre_consciousness_step",
    description: "意识流处理步骤 (三级降级: 本地LLM → 云API → 规则推理)",
    inputSchema: {
      observation: z.string().describe("观察内容"),
      metadata: z.record(z.unknown()).optional().describe("元数据"),
    },
    handler: async (args) => {
      try {
        const dre = getKernel().getEngine();
        const result = await dre.consciousnessStep({
          observation: args.observation as string,
          metadata: args.metadata as Record<string, unknown>,
        });
        return {
          decision: result.decision,
          shouldReflect: result.shouldReflect,
          fallbackLevel: result.fallbackLevel || "local",
          reflection: result.reflection ? {
            issues: result.reflection.issues,
            lessons: result.reflection.lessons,
            rollback: result.reflection.rollback,
            checkpointTag: result.reflection.checkpointTag,
          } : undefined,
        };
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
          fallback: "memory_write",
          message: "DRE 引擎不可用 (所有降级路径均失败)。请使用 memory_write 将知识写入 Vault。",
        };
      }
    },
  });

  registry.add({
    name: "dre_status",
    description: "获取 DRE 引擎状态",
    inputSchema: {},
    handler: async () => {
      const dre = getKernel().getEngine();
      return dre.getStatus();
    },
  });

  registry.add({
    name: "resource_status",
    description: "获取系统资源预算状态 (可用内存、算力、是否可运行本地推理)",
    inputSchema: {},
    handler: async () => {
      const budget = getResourceBudgetManager();
      return budget.getStatus();
    },
  });

  // ===== Persona 工具 (v3.0.0 — 替代 AgentHarness) =====

  registry.add({
    name: "persona_switch",
    description: "切换 Persona 模式 (plan/code/retrieve/reflect/audit/creative/general)",
    inputSchema: {
      mode: z.enum(["plan", "code", "retrieve", "reflect", "audit", "creative", "research", "general"]).describe("Persona 模式"),
      reason: z.string().optional().describe("切换原因 (可选)"),
    },
    handler: async (args) => {
      const loaded = getKernel().getEngine().switchPersona(args.mode as PersonaMode, args.reason as string);
      return {
        mode: loaded.config.mode,
        name: loaded.config.name,
        allowWrite: loaded.config.allowWrite,
        temperature: loaded.config.temperature,
        loadedAt: loaded.loadedAt,
      };
    },
  });

  registry.add({
    name: "persona_status",
    description: "获取当前 Persona 状态和切换历史",
    inputSchema: {},
    handler: async () => {
      const persona = getKernel().getEngine().persona;
      return {
        ...persona.getContextSummary(),
        temperature: persona.getTemperature(),
        canWrite: persona.canWrite(),
        canUseTools: persona.canUseTools(),
        availableModes: persona.getAvailableModes(),
      };
    },
  });

  registry.add({
    name: "persona_list",
    description: "列出所有可用 Persona 模式",
    inputSchema: {},
    handler: async () => {
      return getKernel().getEngine().persona.getAvailableModes();
    },
  });

  registry.add({
    name: "cognitive_state",
    description: "获取统一认知状态 (Persona + 意识流 + 推理 + 约束 + 目标 + 信念 + 资源 + Atom数据)",
    inputSchema: {},
    handler: async () => {
      const engine = getKernel().getEngine();
      const state = engine.getCognitiveState();
      return {
        ...state,
        dataUnifier: engine.data.getAtomStats(),
      };
    },
  });

  // ===== 认知管道工具 (v3.1) =====

  registry.add({
    name: "cognitive_pipeline_run",
    description: "运行认知管道 (含 LLM 降级链: L1确定→L2本地LLM→L3云→L4规则)",
    inputSchema: {
      input: z.string().describe("输入文本 (问题/任务描述)"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const pipeline = new CognitivePipeline(dre);
      pipeline.setToolExecutor(async (toolName, args) => {
        const handlers = registry.buildHttpHandlers();
        const handler = handlers[toolName];
        if (!handler) throw new Error('Tool not found: ' + toolName);
        return handler(args);
      });
      return pipeline.runWithLLM(args.input as string);
    },
  });

  registry.add({
    name: "cognitive_pipeline_run_full",
    description: "运行认知管道 + TaskGraph 执行 (含 LLM 降级链)",
    inputSchema: {
      input: z.string().describe("输入文本 (问题/任务描述)"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const pipeline = new CognitivePipeline(dre);
      pipeline.setToolExecutor(async (toolName, args) => {
        const handlers = registry.buildHttpHandlers();
        const handler = handlers[toolName];
        if (!handler) throw new Error('Tool not found: ' + toolName);
        return handler(args);
      });
      return pipeline.runFullWithLLM(args.input as string);
    },
  });

  // ===== 统一数据入口工具 (v3.1 DataUnifier) =====

  registry.add({
    name: "data_write",
    description: "通过 DataUnifier 统一写入数据 (创建 Atom + 持久化到 KnowledgeStore)",
    inputSchema: {
      content: z.string().describe("数据内容"),
      kind: z.enum(["entity", "fact", "rule", "concept", "procedure", "observation", "insight"]).describe("数据类型"),
      domain: z.string().optional().describe("领域 (如 git, code, security)"),
      paradigm: z.string().optional().describe("范式 (fact, rule, procedure, concept)"),
      sourceType: z.string().optional().describe("来源类型 (manual, web, llm)"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const { atom } = dre.data.write({
        content: args.content as string,
        kind: args.kind as AtomKind,
        domain: args.domain as string,
        paradigm: args.paradigm as string,
        sourceType: args.sourceType as string,
      });
      return { atomId: atom.id, kind: atom.kind, content: atom.content.slice(0, 100) };
    },
  });

  registry.add({
    name: "data_search",
    description: "通过 DataUnifier 统一搜索 (Atom + KnowledgeStore)",
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      limit: z.number().optional().default(10).describe("返回条数上限"),
      kind: z.enum(["entity", "fact", "rule", "concept", "procedure", "observation", "insight"]).optional().describe("按数据类型过滤"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const result = dre.data.search(args.query as string, {
        limit: (args.limit as number) ?? 10,
      });
      return {
        atoms: result.atoms.map((a) => ({ id: a.id, kind: a.kind, content: a.content.slice(0, 120) })),
        knowledgeNodes: result.knowledgeNodes.map((n) => ({ id: n.nodeId, domain: n.domain, content: n.content.slice(0, 120) })),
      };
    },
  });

  registry.add({
    name: "data_stats",
    description: "获取 DataUnifier / AtomEngine 统计信息",
    inputSchema: {},
    handler: async () => {
      const dre = getKernel().getEngine();
      return {
        atomStats: dre.data.getAtomStats(),
      };
    },
  });

  registry.add({
    name: "data_persist",
    description: "手动持久化所有 Atom 到 SQLite",
    inputSchema: {},
    handler: async () => {
      getKernel().getEngine().data.persist();
      return { success: true, timestamp: Date.now() };
    },
  });

  // ===== 心智模型工具 (v2.9.0 认知增强) =====

  registry.add({
    name: "mental_model_list",
    description: "列出所有心智模型 (Git冲突/代码重构等领域模型)",
    inputSchema: {},
    handler: async () => {
      const dre = getKernel().getEngine();
      return dre.mentalModels.list().map((m) => ({
        id: m.id,
        name: m.name,
        domain: m.domain,
        description: m.description,
        concepts: m.concepts.length,
        transitions: m.transitions.length,
        currentState: m.currentState,
        usageCount: m.usageCount,
      }));
    },
  });

  registry.add({
    name: "mental_model_match",
    description: "在心智模型中匹配模式 (观察→概念链→状态路径)",
    inputSchema: {
      modelId: z.string().describe("心智模型 ID (如 git-conflict, code-refactor)"),
      observations: z.array(z.string()).describe("观察列表"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const result = dre.mentalModels.matchPattern(
        args.modelId as string,
        args.observations as string[]
      );
      if (!result) return { matched: false, message: "未匹配到模式" };
      return { matched: true, ...result };
    },
  });

  registry.add({
    name: "mental_model_predict",
    description: "基于心智模型预测下一步 (状态→触发→预测状态)",
    inputSchema: {
      modelId: z.string().describe("心智模型 ID"),
      observation: z.string().describe("当前观察"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const result = dre.mentalModels.predict(
        args.modelId as string,
        args.observation as string
      );
      if (!result) return { predicted: false, message: "无法预测" };
      return { predicted: true, ...result };
    },
  });

  // ===== 推理图工具 (v2.9.0 认知增强) =====

  registry.add({
    name: "reasoning_build",
    description: "构建推理图 (添加前提→推理→结论，自动检测空洞)",
    inputSchema: {
      premises: z.array(z.string()).describe("前提列表"),
      conclusion: z.string().optional().describe("结论"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      dre.reasoning.clear();

      const premiseNodes = (args.premises as string[]).map((p) =>
        dre.reasoning.addPremise(p)
      );

      let conclusionNode = null;
      if (args.conclusion) {
        conclusionNode = dre.reasoning.addConclusion(
          args.conclusion as string,
          premiseNodes.map((n) => n.id)
        );
      }

      const gaps = dre.reasoning.detectGaps();
      const stats = dre.reasoning.getStats();

      return {
        nodes: stats.totalNodes,
        edges: stats.totalEdges,
        gaps: gaps.length,
        gapDetails: gaps.map((g) => ({
          type: g.gapType,
          description: g.description,
          priority: g.priority,
          suggestedPrompt: g.suggestedPrompt,
        })),
      };
    },
  });

  registry.add({
    name: "reasoning_detect_gaps",
    description: "检测推理图中的空洞 (缺失的推理步骤/前提/证据)",
    inputSchema: {},
    handler: async () => {
      const dre = getKernel().getEngine();
      const gaps = dre.reasoning.detectGaps();
      return {
        totalGaps: gaps.length,
        gaps: gaps.map((g) => ({
          id: g.id,
          type: g.gapType,
          description: g.description,
          priority: g.priority,
          suggestedPrompt: g.suggestedPrompt,
        })),
      };
    },
  });

  registry.add({
    name: "reasoning_fill_gap",
    description: "用 LLM 结果填补推理图空洞",
    inputSchema: {
      gapId: z.string().describe("空洞 ID"),
      response: z.string().describe("LLM 回复内容"),
      confidence: z.number().optional().default(0.8).describe("置信度"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const node = dre.reasoning.fillGap(
        args.gapId as string,
        args.response as string,
        (args.confidence as number) || 0.8
      );
      if (!node) return { success: false, error: "空洞未找到" };

      const remainingGaps = dre.reasoning.detectGaps();
      return {
        success: true,
        filledNode: { id: node.id, type: node.type, content: node.content.slice(0, 200) },
        remainingGaps: remainingGaps.length,
      };
    },
  });

  registry.add({
    name: "reasoning_result",
    description: "获取推理结果 (结论、推理链、总置信度)",
    inputSchema: {},
    handler: async () => {
      const dre = getKernel().getEngine();
      return dre.reasoning.getResult();
    },
  });

  // ===== 过程性知识工具 (v2.9.1 认知增强) =====

  registry.add({
    name: "procedure_parse",
    description: "从知识节点中解析过程性知识 (步骤序列、条件分支、循环)",
    inputSchema: {
      nodeId: z.string().describe("知识节点 ID"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const node = dre.readKnowledge(args.nodeId as string);
      if (!node) return { success: false, error: "知识节点未找到" };
      const { ProcedureKnowledge } = await import("../../dre/index.js");
      const procedure = ProcedureKnowledge.parseFromContent(node);
      if (!procedure) return { success: false, error: "无法解析为过程性知识" };
      const validation = ProcedureKnowledge.validate(procedure);
      return { success: true, procedure, validation };
    },
  });

  // ===== 约束求解器工具 (v2.9.2 认知增强) =====

  registry.add({
    name: "constraint_check",
    description: "检查动作是否满足所有约束 (逻辑/物理/语义/策略/时间)",
    inputSchema: {
      action: z.string().describe("要检查的动作"),
      context: z.record(z.unknown()).optional().describe("额外上下文 (如 gpu_free_vram_mb, environment)"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      return dre.constraints.check(args.action as string, args.context as Record<string, unknown>);
    },
  });

  registry.add({
    name: "constraint_select_best",
    description: "从候选动作中选择满足约束的最佳动作",
    inputSchema: {
      candidates: z.array(z.string()).describe("候选动作列表"),
      context: z.record(z.unknown()).optional().describe("额外上下文"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      return dre.constraints.selectBest(args.candidates as string[], args.context as Record<string, unknown>);
    },
  });

  registry.add({
    name: "constraint_list",
    description: "列出所有约束 (可按维度过滤)",
    inputSchema: {
      dimension: z.enum(["logical", "physical", "field_match", "policy", "temporal"]).optional().describe("约束维度过滤"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const dimension = args.dimension as string | undefined;
      if (dimension) return dre.constraints.listByDimension(dimension as "logical" | "physical" | "field_match" | "policy" | "temporal");
      return dre.constraints.list();
    },
  });

  registry.add({
    name: "constraint_stats",
    description: "获取约束求解器统计信息",
    inputSchema: {},
    handler: async () => {
      const dre = getKernel().getEngine();
      return dre.constraints.getStats();
    },
  });

  // ===== Actor 系统工具 (v2.9.2 认知增强) =====

  registry.add({
    name: "actor_list",
    description: "列出所有 Actor (知识/约束/心智模型/推理)",
    inputSchema: {},
    handler: async () => {
      const dre = getKernel().getEngine();
      return dre.actors.list();
    },
  });

  registry.add({
    name: "actor_send",
    description: "向 Actor 发送消息 (触发主动响应)",
    inputSchema: {
      to: z.string().describe("目标 Actor ID (knowledge/constraint/mental-model/reasoning)"),
      topic: z.string().describe("消息主题 (query/check/match/build)"),
      payload: z.record(z.unknown()).optional().describe("消息负载"),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      await dre.actors.send("user", args.to as string, "request", args.topic as string, args.payload || {});
      return { sent: true, to: args.to, topic: args.topic };
    },
  });

  // ===== 认知闭环 (CognitivePipeline) 工具 =====

  registry.add({
    name: "cognitive_loop",
    description: "执行完整认知闭环 (Observation→State→Knowledge→Reasoning→Constraint→Action→Reflection), 零LLM确定性管道, 可追踪每一步的中间结果",
    inputSchema: {
      input: z.string().describe("用户输入或观察文本"),
    },
    tags: ["cognitive", "reasoning", "deterministic"],
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const pipeline = new CognitivePipeline(dre);
      pipeline.setToolExecutor(async (toolName, args) => {
        const handlers = registry.buildHttpHandlers();
        const handler = handlers[toolName];
        if (!handler) throw new Error('Tool not found: ' + toolName);
        return handler(args);
      });
      return pipeline.run(args.input as string);
    },
  });

  registry.add({
    name: "cognitive_loop_full",
    description: "认知闭环 + TaskGraph 执行 (包含认知推理+动作执行+回滚), 基于 runFull()",
    inputSchema: {
      input: z.string().describe("用户输入或任务描述"),
    },
    tags: ["cognitive", "reasoning", "execution", "deterministic"],
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const pipeline = new CognitivePipeline(dre);
      pipeline.setToolExecutor(async (toolName, args) => {
        const handlers = registry.buildHttpHandlers();
        const handler = handlers[toolName];
        if (!handler) throw new Error('Tool not found: ' + toolName);
        return handler(args);
      });
      return pipeline.runFull(args.input as string);
    },
  });

  registry.add({
    name: "task_graph_execute",
    description: "创建并执行任务图 (TaskGraph): 任务并行/依赖解析/失败回滚, 支持 Checkpoint/Resume",
    inputSchema: {
      tasks: z.array(z.object({
        id: z.string(),
        description: z.string(),
        dependsOn: z.array(z.string()).optional(),
        action: z.string().describe("发送到 Actor 的动作名"),
        payload: z.record(z.unknown()).optional(),
        hasRollback: z.boolean().optional().describe("是否注册回滚 (默认 false)"),
      })).min(1),
    },
    handler: async (args) => {
      const dre = getKernel().getEngine();
      const graph = new TaskGraph();

      for (const taskDef of (args.tasks as Array<Record<string, unknown>>)) {
        const id = taskDef.id as string;
        const desc = taskDef.description as string;
        const deps = taskDef.dependsOn as string[] | undefined;
        const action = taskDef.action as string;
        const payload = taskDef.payload as Record<string, unknown> | undefined;
        const hasRollback = taskDef.hasRollback as boolean | undefined;

        graph.addTask(id, desc, async () => {
          await dre.actors.send("user", "knowledge", "request", action, payload ?? {});
          return { dispatched: true, action };
        }, {
          dependsOn: deps,
          rollback: hasRollback ? async () => {
            await dre.actors.send("user", "knowledge", "notify", `rollback:${action}`, payload ?? {});
          } : undefined,
        });
      }

      await graph.executeAll();
      const checkpointId = await graph.checkpoint(dre.knowledgeStore);

      return {
        status: graph.getStatus(),
        tasksCompleted: graph.getAllTasks().filter((t) => t.status === "completed").length,
        tasksFailed: graph.getAllTasks().filter((t) => t.status === "failed").length,
        checkpointId,
      };
    },
  });
}
