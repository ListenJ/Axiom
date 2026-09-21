/**
 * Scene Router — 场景驱动的工具调用系统
 * 
 * 无需 LLM，根据输入文本快速匹配场景并调用 MCP 工具。
 * 用于高频、确定性任务，降低延迟和 Token 消耗。
 */

import { ToolRegistry } from "./tool-registry.js";
import type { Capability } from "../utils/permissions.js";

/** 场景匹配函数 */
type SceneMatcher = (input: string) => boolean;

/** 场景定义 */
export interface Scene {
  id: string;
  name: string;
  description: string;
  /** 匹配规则：关键词列表或自定义匹配函数 */
  match: string[] | SceneMatcher;
  /** 该场景需要调用的工具列表 */
  tools: string[];
  /** 工具参数映射（从输入提取参数） */
  paramMap?: Record<string, string>;
  /** 是否并行执行工具 */
  parallel?: boolean;
  /** 优先级（数字越大越优先） */
  priority?: number;
}

/** 场景执行结果 */
export interface SceneResult {
  sceneId: string;
  sceneName: string;
  executed: Array<{
    tool: string;
    success: boolean;
    result: unknown;
    error?: string;
  }>;
  duration: number;
}

/** 场景路由器 */
/**
 * 无副作用能力集：场景自动执行的放行白名单。
 *
 * 安全修复（审计 A/`/mcp/scene` RCE）延续：`execute()` 会按关键词自动选工具并执行，
 * 中间没有任何人工确认环节，因此具备副作用的工具不得因"名字不在表里"而被放行。
 * 旧实现是一张 `RISKY_SCENE_TOOLS` 工具名表（terminal_exec / fs_write / fs_delete / fs_move），
 * 改名或经 adaptTool 包装即静默脱离（L4/L9 同型）；现按**注册处声明的 capability** 判定，
 * 与 `defaultToolGuard`、`safe-fs` 同一份词表。词表新增档位默认视为有副作用（fail-closed）。
 */
const SIDE_EFFECT_FREE_CAPABILITIES: ReadonlySet<Capability> = new Set(["internal", "fs.read", "fs.glob"]);

export interface SceneRouterOptions {
  /**
   * 是否允许场景自动执行有副作用的工具（fs.write / fs.delete / cfg.write / db.write /
   * proc.exec / net.outbound / mcp.external）。
   * 默认 **false**（fail-closed）。仅在明确需要且已另行加确认流程时才开启。
   */
  allowRiskyTools?: boolean;
}

export class SceneRouter {
  private scenes: Scene[] = [];
  private registry: ToolRegistry;
  private allowRiskyTools: boolean;

  constructor(registry: ToolRegistry, opts?: SceneRouterOptions) {
    this.registry = registry;
    this.allowRiskyTools = opts?.allowRiskyTools ?? false;
  }

  /**
   * 拒绝有副作用工具的自动执行。返回一条「已拒绝」的执行记录，或 null 表示放行。
   */
  private refuseIfRisky(toolName: string): SceneResult["executed"][number] | null {
    if (this.allowRiskyTools) return null;
    const capability = this.registry.getCapabilities(toolName);
    const refused = () => ({
      tool: toolName,
      success: false,
      result: null,
      error:
        `Refused: "${toolName}" declares side-effect capability (${capability.join(", ")}); ` +
        `scene auto-execution is disabled by default. Set allowRiskyTools=true only behind an explicit confirmation flow.`,
    });
    // 未注册或未声明能力 ⇒ 无从判定，按 I1 fail-closed 拒绝（无声明即不可得）
    if (capability.length === 0) {
      return {
        tool: toolName,
        success: false,
        result: null,
        error: `Refused: "${toolName}" has no declared capability; scene auto-execution requires a declaration (S3 / I1).`,
      };
    }
    return capability.some((c) => !SIDE_EFFECT_FREE_CAPABILITIES.has(c)) ? refused() : null;
  }

  /** 注册场景 */
  addScene(scene: Scene): this {
    this.scenes.push({ priority: 0, parallel: false, ...scene });
    // 按优先级排序（高优先级在前）
    this.scenes.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return this;
  }

  /** 批量注册场景 */
  addScenes(scenes: Scene[]): this {
    for (const scene of scenes) this.addScene(scene);
    return this;
  }

  /** 匹配场景 */
  match(input: string): Scene | null {
    const normalized = input.toLowerCase();
    
    for (const scene of this.scenes) {
      if (Array.isArray(scene.match)) {
        // 关键词匹配
        if (scene.match.some(kw => normalized.includes(kw.toLowerCase()))) {
          return scene;
        }
      } else {
        // 自定义匹配函数
        if (scene.match(input)) {
          return scene;
        }
      }
    }
    return null;
  }

  /**
   * 把 handler 的返回值归一为执行记录。
   *
   * `buildHttpHandlers` 的拒绝（守卫抛错）以 `{success:false,error:true,message}` 呈现而不抛出，
   * 因此"未执行"必须在这里被读出来：否则场景结果会把被拒的一步记成成功（R2-E）。
   */
  private stepOf(toolName: string, result: unknown): SceneResult["executed"][number] {
    const shape = (result ?? {}) as { success?: unknown; error?: unknown; message?: unknown };
    const refused = shape.success === false || shape.error === true;
    if (!refused) return { tool: toolName, success: true, result };
    return {
      tool: toolName,
      success: false,
      result,
      error: typeof shape.message === "string" ? shape.message : `${toolName} refused`,
    };
  }

  /** 执行场景 */
  async execute(input: string, context?: Record<string, unknown>): Promise<SceneResult> {
    const start = performance.now();
    const scene = this.match(input);
    
    if (!scene) {
      return {
        sceneId: "none",
        sceneName: "未匹配",
        executed: [],
        duration: Math.round(performance.now() - start),
      };
    }

    const handlers = this.registry.buildHttpHandlers();
    const executed: SceneResult["executed"] = [];

    if (scene.parallel) {
      // 并行执行
      const results = await Promise.all(
        scene.tools.map(async (toolName) => {
          const handler = handlers[toolName];
          if (!handler) {
            return { tool: toolName, success: false, result: null, error: `Tool ${toolName} not found` };
          }
          const refused = this.refuseIfRisky(toolName);
          if (refused) return refused;
          try {
            const params = this.buildParams(input, toolName, scene, context);
            const result = await handler(params);
            return this.stepOf(toolName, result);
          } catch (e: unknown) {
            return { tool: toolName, success: false, result: null, error: e instanceof Error ? e.message : String(e) };
          }
        })
      );
      executed.push(...results);
    } else {
      // 串行执行
      for (const toolName of scene.tools) {
        const handler = handlers[toolName];
        if (!handler) {
          executed.push({ tool: toolName, success: false, result: null, error: `Tool ${toolName} not found` });
          continue;
        }
        const refused = this.refuseIfRisky(toolName);
        if (refused) {
          executed.push(refused);
          continue;
        }
        try {
          const params = this.buildParams(input, toolName, scene, context);
          const result = await handler(params);
          executed.push(this.stepOf(toolName, result));
        } catch (e: unknown) {
          executed.push({ tool: toolName, success: false, result: null, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    return {
      sceneId: scene.id,
      sceneName: scene.name,
      executed,
      duration: Math.round(performance.now() - start),
    };
  }

  /** 构建工具参数 */
  private buildParams(
    input: string,
    toolName: string,
    scene: Scene,
    context?: Record<string, unknown>
  ): Record<string, unknown> {
    // 安全修复（审计 A）：**不再整体展开** `context`。
    // 原实现 `{ input, ...(context || {}) }` 让调用方可以注入**任意参数名** ——
    // 例如给 terminal 场景的 terminal_exec 注入 `command`，从而实现远程命令执行。
    // 现在只有场景作者在 `scene.paramMap` 里**显式声明**的映射
    // （工具参数名 → context 键名）才会被注入。
    const params: Record<string, unknown> = { input };
    if (context && scene.paramMap) {
      for (const [paramName, contextKey] of Object.entries(scene.paramMap)) {
        if (Object.prototype.hasOwnProperty.call(context, contextKey)) {
          params[paramName] = context[contextKey];
        }
      }
    }
    void toolName;

    // 从输入提取常见参数
    const fileMatch = input.match(/[\w\-/]+\.(ts|js|py|json|md|txt|yml|yaml)/);
    if (fileMatch) {
      params.filePath = fileMatch[0];
    }

    const urlMatch = input.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      params.url = urlMatch[0];
    }

    return params;
  }

  /** 列出所有场景 */
  listScenes(): Array<{ id: string; name: string; description: string; tools: string[] }> {
    return this.scenes.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tools: s.tools,
    }));
  }

  /** 获取单个场景详情 */
  getScene(id: string): Scene | null {
    return this.scenes.find(s => s.id === id) || null;
  }
}

/** 预定义场景库 */
export const DEFAULT_SCENES: Scene[] = [
  {
    id: "git_ops",
    name: "Git 操作",
    description: "查看 git 状态、diff、log、branch",
    match: ["git", "提交", "分支", "diff", "status", "log", "blame"],
    tools: ["git_status", "git_diff", "git_log", "git_branch"],
    parallel: true,
    priority: 10,
  },
  {
    id: "file_read",
    name: "文件读取",
    description: "读取文件内容",
    match: ["读取", "查看", "read", "show", "content", "cat"],
    tools: ["fs_read"],
    priority: 5,
  },
  {
    id: "file_write",
    name: "文件写入",
    description: "写入或修改文件",
    match: ["写入", "修改", "write", "edit", "update", "create"],
    tools: ["fs_write"],
    priority: 5,
  },
  {
    id: "code_analysis",
    name: "代码分析",
    description: "分析代码结构、符号、诊断",
    match: ["分析", "符号", "诊断", "analyze", "symbol", "diagnostic", "outline"],
    tools: ["code_symbols", "code_diagnostics", "code_outline", "code_analyze"],
    parallel: true,
    priority: 8,
  },
  {
    id: "terminal",
    name: "终端命令",
    description: "执行终端命令",
    match: ["执行", "运行", "execute", "run", "command", "cmd", "npm", "bun"],
    tools: ["terminal_exec"],
    priority: 7,
  },
  {
    id: "search",
    name: "搜索",
    description: "Web 搜索或文件搜索",
    match: ["搜索", "查找", "search", "find", "google", "查询"],
    tools: ["web_search", "fs_search"],
    parallel: true,
    priority: 6,
  },
  {
    id: "memory",
    name: "记忆库",
    description: "Vault 记忆库操作",
    match: ["记忆", "vault", "笔记", "note", "知识", "knowledge"],
    tools: ["memory_search", "memory_stats"],
    priority: 4,
  },
  // === 新增场景 ===
  {
    id: "knowledge_query",
    name: "知识查询",
    description: "统一知识查询 (跨 Vault/KG/DRE)",
    match: ["统一查询", "知识图谱查询", "kal", "跨库查询"],
    tools: ["kal_query", "kal_references"],
    priority: 9,
  },
  {
    id: "kg_ops",
    name: "知识图谱操作",
    description: "KG 节点/边管理、子图检索、社区检测 (caution: kg_add_node/kg_add_edge 在 plan 模式被阻断)",
    match: ["图谱", "节点", "边", "子图", "社区", "可视化"],
    tools: ["kg_add_node", "kg_add_edge", "kg_search_nodes", "kg_subgraph", "kg_shortest_path", "kg_detect_communities", "kg_echarts_data", "kg_d3_data", "kg_stats"],
    parallel: true,
    priority: 6,
  },
  {
    id: "dre_ops",
    name: "DRE 推理引擎",
    description: "确定性推理、知识写入、意识流 (caution: dre_write_knowledge 在 plan 模式被阻断)",
    match: ["推理", "确定性", "意识流", "dre", "甄别"],
    tools: ["dre_write_knowledge", "dre_read_knowledge", "dre_search_knowledge", "dre_consciousness_step", "dre_status"],
    priority: 6,
  },
  {
    id: "github_ops",
    name: "GitHub 操作",
    description: "仓库、Issue、PR、Actions 管理",
    match: ["github", "仓库", "issue", "pr", "pull request", "action", "release"],
    tools: ["github_list_repos", "github_get_repo", "github_list_issues", "github_create_issue", "github_list_prs", "github_create_pr", "github_health"],
    parallel: true,
    priority: 7,
  },
  {
    id: "code_generate",
    name: "代码生成",
    description: "AI 代码生成、重构、审查",
    match: ["生成代码", "重构", "审查", "code generate", "refactor", "review"],
    tools: ["code_generate", "code_refactor", "code_review"],
    priority: 7,
  },
  {
    id: "document_ingest",
    name: "文档处理",
    description: "文档→KG管道 (DIP)",
    match: ["文档处理", "ingest", "解析文档", "dip"],
    tools: ["dip_ingest_document", "dip_query_ast"],
    priority: 5,
  },
  {
    id: "arena",
    name: "竞技场榜单",
    description: "模型评分查询、排名、推荐",
    match: ["榜单", "排名", "评分", "arena", "benchmark", "elo"],
    tools: ["arena_search_models", "arena_get_model_scores", "arena_benchmark_ranking", "arena_composite_ranking", "arena_role_recommendation", "arena_stats"],
    parallel: true,
    priority: 5,
  },
  {
    id: "prompt_pool",
    name: "Prompt 缓存池",
    description: "提示词池化管理",
    match: ["prompt", "提示词", "缓存池", "连接池"],
    tools: ["prompt_pool_acquire", "prompt_pool_metrics", "prompt_pool_status"],
    priority: 4,
  },
  {
    id: "snapshot",
    name: "快照管理",
    description: "工作区快照创建、恢复、对比",
    match: ["快照", "snapshot", "备份", "恢复"],
    tools: ["snapshot_create", "snapshot_revert", "snapshot_list", "snapshot_diff", "snapshot_status"],
    priority: 5,
  },
  // === v2.9.2 认知增强场景 ===
  {
    id: "constraint_ops",
    name: "约束求解",
    description: "多维约束检查、最佳动作选择",
    match: ["约束", "constraint", "检查约束", "满足约束"],
    tools: ["constraint_check", "constraint_select_best", "constraint_list", "constraint_stats"],
    priority: 6,
  },
  {
    id: "mental_model_ops",
    name: "心智模型",
    description: "模式匹配、状态预测",
    match: ["心智", "mental model", "模式匹配", "预测下一步"],
    tools: ["mental_model_list", "mental_model_match", "mental_model_predict"],
    priority: 6,
  },
  {
    id: "reasoning_ops",
    name: "推理图",
    description: "构建推理链、空洞检测、LLM 精确填补",
    match: ["推理图", "reasoning", "空洞检测", "推理链"],
    tools: ["reasoning_build", "reasoning_detect_gaps", "reasoning_fill_gap", "reasoning_result"],
    priority: 6,
  },
  {
    id: "actor_ops",
    name: "Actor 系统",
    description: "Actor 消息发送和状态查询",
    match: ["actor", "发送消息", "actor_send"],
    tools: ["actor_list", "actor_send"],
    priority: 5,
  },
  {
    id: "procedure_ops",
    name: "过程性知识",
    description: "解析步骤序列、条件分支",
    match: ["过程", "procedure", "步骤", "流程解析"],
    tools: ["procedure_parse"],
    priority: 5,
  },
  {
    id: "cognitive_loop",
    name: "认知闭环",
    description: "执行完整认知闭环 (Observation→State→Knowledge→Reasoning→Constraint→Action→Reflection), 零LLM确定性管道",
    match: ["认知闭环", "cognitive loop", "管道决策", "思维链", "推理流水线"],
    tools: ["cognitive_loop"],
    priority: 8,
  },
  {
    id: "task_graph",
    name: "任务图执行",
    description: "创建执行任务图: 并行任务/依赖解析/失败回滚/Checkpoint",
    match: ["任务图", "task graph", "并行任务", "执行计划", "checkpoint"],
    tools: ["task_graph_execute"],
    priority: 8,
  },
];
