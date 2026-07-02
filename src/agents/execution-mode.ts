/**
 * Execution Mode System — 执行模式控制 (受 CodeWhale 启发)
 *
 * 三种模式：
 * - Plan 🔍: 只读调查，禁止任何修改操作
 * - Agent 🤖: 默认模式，破坏性操作需审批
 * - YOLO ⚡: 自动批准，在受信任工作区中全自动化
 *
 * 权威层级（宪法）：
 * 1. 用户显式意图 > 历史指令
 * 2. 实时工具输出 > 假设
 * 3. 验证 > 信心
 * 4. 安全模式 > 效率
 *
 * Phase P0-1: requestApproval() now delegates to ApprovalBridge (a real
 * WebSocket-driven HITL handshake) instead of auto-approving. YOLO mode
 * still skips the bridge entirely. See src/utils/approval-bridge.ts.
 */

import { logger } from "../utils/logger.js";
import { getApprovalBridge, type ApprovalRisk } from "../utils/approval-bridge.js";

/** 执行模式 */
export type ExecutionMode = "plan" | "agent" | "yolo";

/** 工具风险等级 */
export type ToolRisk = "safe" | "caution" | "destructive";

/** 工具分类 */
export interface ToolClassification {
  name: string;
  risk: ToolRisk;
  category: string;
  description: string;
}

/** 模式配置 */
export interface ModeConfig {
  mode: ExecutionMode;
  allowDestructive: boolean;
  requireApproval: boolean;
  maxAutoRetries: number;
  allowedToolCategories: string[];
  blockedTools: string[];
}

// ========== 工具风险分类表 ==========

export const TOOL_CLASSIFICATIONS: ToolClassification[] = [
  // ===== 安全工具（只读） =====
  // 文件系统
  { name: "fs_read", risk: "safe", category: "filesystem", description: "读取文件内容" },
  { name: "fs_list", risk: "safe", category: "filesystem", description: "列出目录内容" },
  { name: "fs_search", risk: "safe", category: "filesystem", description: "搜索文件" },
  // Git
  { name: "git_status", risk: "safe", category: "git", description: "查看 git 状态" },
  { name: "git_diff", risk: "safe", category: "git", description: "查看代码差异" },
  { name: "git_log", risk: "safe", category: "git", description: "查看提交历史" },
  { name: "git_branch", risk: "safe", category: "git", description: "查看分支列表" },
  { name: "git_blame", risk: "safe", category: "git", description: "查看行级作者" },
  // 终端
  { name: "terminal_info", risk: "safe", category: "terminal", description: "获取系统信息" },
  { name: "terminal_list", risk: "safe", category: "terminal", description: "列出进程" },
  // 代码分析
  { name: "code_symbols", risk: "safe", category: "code-analysis", description: "查找符号定义" },
  { name: "code_references", risk: "safe", category: "code-analysis", description: "查找引用" },
  { name: "code_diagnostics", risk: "safe", category: "code-analysis", description: "获取诊断信息" },
  { name: "code_outline", risk: "safe", category: "code-analysis", description: "获取文件大纲" },
  { name: "code_analyze", risk: "safe", category: "code-analysis", description: "分析代码" },
  { name: "code_quick_diagnostics", risk: "safe", category: "code-analysis", description: "快速诊断单个文件" },
  { name: "code_actions", risk: "safe", category: "code-analysis", description: "获取代码修复建议" },
  { name: "code_detect_language", risk: "safe", category: "code-analysis", description: "检测编程语言" },
  // 记忆库
  { name: "memory_search", risk: "safe", category: "memory", description: "搜索记忆" },
  { name: "memory_read", risk: "safe", category: "memory", description: "读取记忆" },
  { name: "memory_browse", risk: "safe", category: "memory", description: "浏览记忆" },
  { name: "memory_stats", risk: "safe", category: "memory", description: "记忆统计" },
  { name: "memory_network", risk: "safe", category: "memory", description: "获取记忆关联网络" },
  // Web
  { name: "web_fetch", risk: "safe", category: "web", description: "获取网页内容" },
  { name: "web_search", risk: "safe", category: "web", description: "搜索网络" },
  { name: "search_engines_list", risk: "safe", category: "web", description: "列出搜索引擎" },
  { name: "serpapi_search", risk: "safe", category: "web", description: "SerpAPI 搜索" },
  { name: "serpapi_search_and_crawl", risk: "safe", category: "web", description: "SerpAPI 搜索+爬取" },
  { name: "minimax_web_search", risk: "safe", category: "web", description: "MiniMax 网络搜索" },
  { name: "minimax_image_understand", risk: "safe", category: "web", description: "MiniMax 图像识别" },
  { name: "minimax_health", risk: "safe", category: "web", description: "MiniMax 健康检查" },
  // 监控
  { name: "token_stats", risk: "safe", category: "monitoring", description: "Token 使用统计" },
  { name: "token_stats_by_model", risk: "safe", category: "monitoring", description: "按模型统计" },
  { name: "token_stats_by_role", risk: "safe", category: "monitoring", description: "按角色统计" },
  { name: "token_daily_stats", risk: "safe", category: "monitoring", description: "按天统计" },
  { name: "proxy_status", risk: "safe", category: "monitoring", description: "代理状态" },
  { name: "vram_status", risk: "safe", category: "monitoring", description: "GPU VRAM 预算状态" },
  // 技能
  { name: "skill_list", risk: "safe", category: "skills", description: "列出技能" },
  // 数据库
  { name: "db_query", risk: "safe", category: "database", description: "SQLite 只读查询" },
  { name: "list_free_models", risk: "safe", category: "database", description: "列出免费模型" },
  // 模式管理
  { name: "get_mode", risk: "safe", category: "mode", description: "获取当前执行模式" },
  { name: "list_mode_tools", risk: "safe", category: "mode", description: "列出模式允许的工具" },
  // 快照
  { name: "snapshot_list", risk: "safe", category: "snapshot", description: "列出快照" },
  { name: "snapshot_diff", risk: "safe", category: "snapshot", description: "查看快照差异" },
  { name: "snapshot_status", risk: "safe", category: "snapshot", description: "快照系统状态" },
  // 竞技场
  { name: "arena_search_models", risk: "safe", category: "arena", description: "搜索竞技场模型" },
  { name: "arena_get_model_scores", risk: "safe", category: "arena", description: "获取模型分数" },
  { name: "arena_benchmark_ranking", risk: "safe", category: "arena", description: "基准排名" },
  { name: "arena_composite_ranking", risk: "safe", category: "arena", description: "综合排名" },
  { name: "arena_role_recommendation", risk: "safe", category: "arena", description: "角色推荐" },
  { name: "arena_stats", risk: "safe", category: "arena", description: "竞技场统计" },
  { name: "arena_sources", risk: "safe", category: "arena", description: "列出数据源" },
  // Prompt 池
  { name: "prompt_pool_metrics", risk: "safe", category: "prompt", description: "缓存监控指标" },
  { name: "prompt_pool_status", risk: "safe", category: "prompt", description: "连接池状态" },
  { name: "prompt_pool_roles", risk: "safe", category: "prompt", description: "列出角色配置" },
  // 编排器
  { name: "orchestrator_list_agents", risk: "safe", category: "orchestrator", description: "列出注册 Agent" },
  { name: "orchestrator_health_check", risk: "safe", category: "orchestrator", description: "Agent 健康检查" },
  { name: "orchestrator_status", risk: "safe", category: "orchestrator", description: "编排器状态" },
  // Agent
  { name: "opencode_status", risk: "safe", category: "agent", description: "OpenCode 状态" },
  { name: "hermes_status", risk: "safe", category: "agent", description: "Hermes 状态" },
  { name: "project_research", risk: "safe", category: "agent", description: "深度研究" },
  // GitHub（只读）
  { name: "github_health", risk: "safe", category: "github", description: "GitHub API 健康检查" },
  { name: "github_list_repos", risk: "safe", category: "github", description: "列出仓库" },
  { name: "github_get_repo", risk: "safe", category: "github", description: "获取仓库详情" },
  { name: "github_list_issues", risk: "safe", category: "github", description: "列出 Issues" },
  { name: "github_get_issue", risk: "safe", category: "github", description: "获取 Issue 详情" },
  { name: "github_list_prs", risk: "safe", category: "github", description: "列出 PRs" },
  { name: "github_get_pr_files", risk: "safe", category: "github", description: "获取 PR 文件" },
  { name: "github_get_file_contents", risk: "safe", category: "github", description: "获取文件内容" },
  { name: "github_list_directory", risk: "safe", category: "github", description: "列出目录" },
  { name: "github_search_code", risk: "safe", category: "github", description: "搜索代码" },
  { name: "github_list_releases", risk: "safe", category: "github", description: "列出 Releases" },
  { name: "github_list_workflows", risk: "safe", category: "github", description: "列出 Actions" },
  { name: "github_list_workflow_runs", risk: "safe", category: "github", description: "列出 Action 运行记录" },
  { name: "github_get_workflow_run", risk: "safe", category: "github", description: "获取 Action 运行详情" },
  // KG（只读）
  { name: "kg_stats", risk: "safe", category: "kg", description: "知识图谱统计" },
  { name: "kg_entities", risk: "safe", category: "kg", description: "查询实体" },
  { name: "kg_entity_detail", risk: "safe", category: "kg", description: "实体详情" },
  { name: "kg_traverse", risk: "safe", category: "kg", description: "图谱遍历" },
  { name: "kg_search", risk: "safe", category: "kg", description: "语义搜索" },
  { name: "kg_graph", risk: "safe", category: "kg", description: "可视化数据" },
  { name: "kg_search_nodes", risk: "safe", category: "kg", description: "搜索节点" },
  { name: "kg_subgraph", risk: "safe", category: "kg", description: "子图检索" },
  { name: "kg_shortest_path", risk: "safe", category: "kg", description: "最短路径" },
  { name: "kg_detect_communities", risk: "safe", category: "kg", description: "社区检测" },
  { name: "kg_echarts_data", risk: "safe", category: "kg", description: "ECharts 数据" },
  { name: "kg_d3_data", risk: "safe", category: "kg", description: "D3 数据" },
  { name: "kg_nl_query", risk: "safe", category: "kg", description: "自然语言查询" },
  { name: "kg_enhanced_stats", risk: "safe", category: "kg", description: "增强统计" },
  // DRE（只读）
  { name: "dre_read_knowledge", risk: "safe", category: "dre", description: "读取知识" },
  { name: "dre_search_knowledge", risk: "safe", category: "dre", description: "搜索知识" },
  { name: "dre_subgraph", risk: "safe", category: "dre", description: "DRE 子图" },
  { name: "dre_status", risk: "safe", category: "dre", description: "DRE 状态" },
  // KAL
  { name: "kal_query", risk: "safe", category: "kal", description: "统一知识查询" },
  { name: "kal_references", risk: "safe", category: "kal", description: "跨存储引用" },
  // DIP（只读）
  { name: "dip_query_ast", risk: "safe", category: "dip", description: "AST 查询" },
  // 场景路由
  { name: "scene_suggest_tools", risk: "safe", category: "scene", description: "推荐工具子集" },
  { name: "scene_list", risk: "safe", category: "scene", description: "列出场景" },
  // 心智模型 (v2.9.0)
  { name: "mental_model_list", risk: "safe", category: "mental-model", description: "列出心智模型" },
  { name: "mental_model_match", risk: "safe", category: "mental-model", description: "模式匹配" },
  { name: "mental_model_predict", risk: "safe", category: "mental-model", description: "预测下一步" },
  // 推理图 (v2.9.0)
  { name: "reasoning_build", risk: "safe", category: "reasoning", description: "构建推理图" },
  { name: "reasoning_detect_gaps", risk: "safe", category: "reasoning", description: "检测推理空洞" },
  { name: "reasoning_result", risk: "safe", category: "reasoning", description: "获取推理结果" },
  // 过程性知识 (v2.9.1)
  { name: "procedure_parse", risk: "safe", category: "procedure", description: "解析过程性知识" },
  // 约束求解器 (v2.9.2)
  { name: "constraint_check", risk: "safe", category: "constraint", description: "约束检查" },
  { name: "constraint_select_best", risk: "safe", category: "constraint", description: "选择最佳动作" },
  { name: "constraint_list", risk: "safe", category: "constraint", description: "列出约束" },
  { name: "constraint_stats", risk: "safe", category: "constraint", description: "约束统计" },
  // Actor 系统 (v2.9.2)
  { name: "actor_list", risk: "safe", category: "actor", description: "列出 Actor" },
  { name: "actor_send", risk: "safe", category: "actor", description: "发送 Actor 消息" },
  // 认知闭环 (v2.9.2)
  { name: "cognitive_loop", risk: "safe", category: "cognitive_runtime", description: "执行完整认知闭环" },
  { name: "task_graph_execute", risk: "safe", category: "cognitive_runtime", description: "任务图执行" },

  // ===== 谨慎工具（可能影响状态） =====
  // 文件系统
  { name: "fs_write", risk: "caution", category: "filesystem", description: "写入文件" },
  { name: "fs_move", risk: "caution", category: "filesystem", description: "移动文件" },
  // 终端
  { name: "terminal_exec", risk: "caution", category: "terminal", description: "执行命令" },
  // 代码
  { name: "code_generate", risk: "caution", category: "code", description: "AI 代码生成" },
  { name: "code_refactor", risk: "caution", category: "code", description: "AI 代码重构" },
  { name: "code_review", risk: "caution", category: "code", description: "AI 代码审查" },
  { name: "code_test", risk: "caution", category: "code", description: "AI 测试生成" },
  { name: "code_index", risk: "caution", category: "code", description: "索引项目代码" },
  // 记忆
  { name: "memory_write", risk: "caution", category: "memory", description: "写入记忆" },
  { name: "memory_atomic", risk: "caution", category: "memory", description: "创建原子笔记" },
  // 技能
  { name: "skill_create", risk: "caution", category: "skills", description: "创建技能" },
  { name: "skill_reload", risk: "caution", category: "skills", description: "重载技能" },
  // 模型
  { name: "model_chat", risk: "caution", category: "model", description: "发送聊天请求" },
  // 快照
  { name: "snapshot_create", risk: "caution", category: "snapshot", description: "创建快照" },
  { name: "snapshot_revert", risk: "caution", category: "snapshot", description: "恢复快照" },
  // Prompt 池
  { name: "prompt_pool_acquire", risk: "caution", category: "prompt", description: "获取缓存提示词" },
  { name: "prompt_pool_warmup", risk: "caution", category: "prompt", description: "预热缓存" },
  { name: "prompt_pool_evict", risk: "caution", category: "prompt", description: "执行淘汰" },
  // 编排器
  { name: "orchestrator_execute_task", risk: "caution", category: "orchestrator", description: "执行 Agent 任务" },
  { name: "orchestrator_execute_plan", risk: "caution", category: "orchestrator", description: "执行编排计划" },
  // GitHub（写操作）
  { name: "github_create_repo", risk: "caution", category: "github", description: "创建仓库" },
  { name: "github_fork_repo", risk: "caution", category: "github", description: "Fork 仓库" },
  { name: "github_create_issue", risk: "caution", category: "github", description: "创建 Issue" },
  { name: "github_add_issue_comment", risk: "caution", category: "github", description: "添加 Issue 评论" },
  { name: "github_create_pr", risk: "caution", category: "github", description: "创建 PR" },
  { name: "github_review_pr", risk: "caution", category: "github", description: "审查 PR" },
  { name: "github_create_release", risk: "caution", category: "github", description: "创建 Release" },
  { name: "github_trigger_workflow", risk: "caution", category: "github", description: "触发 Actions 工作流" },
  // KG（写操作）
  { name: "kg_add_node", risk: "caution", category: "kg", description: "添加节点" },
  { name: "kg_add_edge", risk: "caution", category: "kg", description: "添加边" },
  { name: "kg_build", risk: "caution", category: "kg", description: "触发图谱构建" },
  // DRE（写操作）
  { name: "dre_write_knowledge", risk: "caution", category: "dre", description: "写入知识" },
  { name: "dre_consciousness_step", risk: "caution", category: "dre", description: "意识流步骤" },
  // DIP（写操作）
  { name: "dip_ingest_document", risk: "caution", category: "dip", description: "文档→KG 管道" },
  // 推理图（写操作）
  { name: "reasoning_fill_gap", risk: "caution", category: "reasoning", description: "填补推理空洞" },
  // 竞技场
  { name: "arena_collect", risk: "caution", category: "arena", description: "采集榜单数据" },
  // 模式
  { name: "set_mode", risk: "caution", category: "mode", description: "切换执行模式" },
  { name: "revert_mode", risk: "caution", category: "mode", description: "回退模式" },

  // ===== 破坏性工具（高风险） =====
  { name: "fs_delete", risk: "destructive", category: "filesystem", description: "删除文件（不可逆）" },
];

// ========== 模式配置表 ==========

export const MODE_CONFIGS: Record<ExecutionMode, ModeConfig> = {
  plan: {
    mode: "plan",
    allowDestructive: false,
    requireApproval: false,
    maxAutoRetries: 0,
    allowedToolCategories: [
      "filesystem", "git", "terminal", "code-analysis", "memory", "web",
      "monitoring", "skills", "database", "snapshot", "arena", "orchestrator",
      "github", "kg", "dre", "kal", "dip", "scene", "model", "prompt", "mode", "agent",
      "mental-model", "reasoning", "procedure", "constraint", "actor",
    ],
    blockedTools: ["fs_write", "fs_delete", "fs_move", "terminal_exec", "code_generate", "code_refactor", "code_review", "code_test", "code_index", "memory_write", "memory_atomic", "skill_create", "skill_reload", "model_chat", "snapshot_create", "snapshot_revert", "prompt_pool_acquire", "prompt_pool_warmup", "prompt_pool_evict", "orchestrator_execute_task", "orchestrator_execute_plan", "github_create_repo", "github_fork_repo", "github_create_issue", "github_add_issue_comment", "github_create_pr", "github_review_pr", "github_create_release", "github_trigger_workflow", "kg_add_node", "kg_add_edge", "kg_build", "dre_write_knowledge", "dre_consciousness_step", "dip_ingest_document", "arena_collect", "set_mode", "revert_mode", "reasoning_fill_gap"],
  },
  agent: {
    mode: "agent",
    allowDestructive: true,
    requireApproval: true,
    maxAutoRetries: 2,
    allowedToolCategories: [
      "filesystem", "git", "terminal", "code-analysis", "memory", "web",
      "monitoring", "skills", "code", "database", "snapshot", "arena",
      "orchestrator", "github", "kg", "dre", "kal", "dip", "scene", "model", "prompt", "mode", "agent",
      "mental-model", "reasoning", "procedure", "constraint", "actor",
    ],
    blockedTools: [],
  },
  yolo: {
    mode: "yolo",
    allowDestructive: true,
    requireApproval: false,
    maxAutoRetries: 3,
    allowedToolCategories: [
      "filesystem", "git", "terminal", "code-analysis", "memory", "web",
      "monitoring", "skills", "code", "database", "snapshot", "arena",
      "orchestrator", "github", "kg", "dre", "kal", "dip", "scene", "model", "prompt", "mode", "agent",
      "mental-model", "reasoning", "procedure", "constraint", "actor",
    ],
    blockedTools: [],
  },
};

// ========== 模式管理器 ==========

class ExecutionModeManager {
  private currentMode: ExecutionMode = "agent";
  private modeHistory: ExecutionMode[] = ["agent"];

  /** 获取当前模式 */
  getMode(): ExecutionMode {
    return this.currentMode;
  }

  /** 获取当前模式配置 */
  getConfig(): ModeConfig {
    return MODE_CONFIGS[this.currentMode];
  }

  /** 切换模式 */
  setMode(mode: ExecutionMode): void {
    if (this.currentMode !== mode) {
      this.modeHistory.push(mode);
      this.currentMode = mode;
      logger.info(`[ExecutionMode] Switched to ${mode.toUpperCase()} mode`, {
        previous: this.modeHistory[this.modeHistory.length - 2],
        destructive: MODE_CONFIGS[mode].allowDestructive,
        approval: MODE_CONFIGS[mode].requireApproval,
      });
    }
  }

  /** 回退到上一个模式 */
  revertMode(): ExecutionMode {
    if (this.modeHistory.length > 1) {
      this.modeHistory.pop();
      this.currentMode = this.modeHistory[this.modeHistory.length - 1];
      logger.info(`[ExecutionMode] Reverted to ${this.currentMode.toUpperCase()} mode`);
    }
    return this.currentMode;
  }

  /** 检查工具是否允许在当前模式下执行 */
  canExecute(toolName: string): { allowed: boolean; reason?: string } {
    const classification = TOOL_CLASSIFICATIONS.find((t) => t.name === toolName);
    const config = this.getConfig();

    // 明确禁止的工具
    if (config.blockedTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `工具 "${toolName}" 在 ${this.currentMode.toUpperCase()} 模式下被禁止。切换到 Agent 或 YOLO 模式以使用此工具。`,
      };
    }

    // 未分类的工具，在 Plan 模式下禁止
    if (!classification && this.currentMode === "plan") {
      return {
        allowed: false,
        reason: `未知工具 "${toolName}" 在 Plan 模式下被禁止。`,
      };
    }

    // 风险等级检查
    if (classification) {
      if (classification.risk === "destructive" && !config.allowDestructive) {
        return {
          allowed: false,
          reason: `破坏性工具 "${toolName}" 在当前模式下不允许。`,
        };
      }
    }

    return { allowed: true };
  }

  /** 检查是否需要审批 */
  needsApproval(toolName: string): boolean {
    const config = this.getConfig();
    if (!config.requireApproval) return false;

    const classification = TOOL_CLASSIFICATIONS.find((t) => t.name === toolName);
    if (!classification) return false;

    // Agent 模式下，caution 和 destructive 工具需要审批
    return classification.risk === "caution" || classification.risk === "destructive";
  }

  /**
   * 请求审批（返回 Promise，等待用户确认）
   *
   * YOLO 模式：直接放行，跳过任何等待。
   * Agent 模式：委托 ApprovalBridge，等待 WebSocket 客户端确认；超时自动拒绝。
   * Plan 模式：根本不会走到这里（needsApproval 在 plan 模式下永远返回 false）。
   */
  async requestApproval(toolName: string, args: unknown): Promise<boolean> {
    const classification = TOOL_CLASSIFICATIONS.find((t) => t.name === toolName);
    const risk: ApprovalRisk = classification?.risk ?? "unknown";

    logger.warn(`[ExecutionMode] Approval required for ${toolName} (${risk})`, { args });

    if (this.currentMode === "yolo") {
      logger.info(`[ExecutionMode] YOLO mode — auto-approving ${toolName}`);
      return true;
    }

    try {
      const approved = await getApprovalBridge().request(toolName, args, { risk });
      logger.info(`[ExecutionMode] ${toolName} ${approved ? "approved" : "denied"} via bridge`);
      return approved;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[ExecutionMode] ${toolName} approval failed: ${reason}`);
      return false;
    }
  }

  /** 获取模式历史 */
  getModeHistory(): ExecutionMode[] {
    return [...this.modeHistory];
  }

  /** 获取当前模式下的允许工具列表 */
  getAllowedTools(): ToolClassification[] {
    const config = this.getConfig();
    return TOOL_CLASSIFICATIONS.filter((t) => {
      if (config.blockedTools.includes(t.name)) return false;
      if (!config.allowDestructive && t.risk === "destructive") return false;
      return true;
    });
  }

  // Phase P1-5: getConstitutionPrompt() + getModeConstraints() deleted.
  // The constitution now lives entirely in `src/agents/constitution.ts`
  // (buildConstitution / formatConstitution / getConstitutionForMode),
  // keyed by ExecutionMode. task-orchestrator imports from there.
}

export const executionMode = new ExecutionModeManager();

/** 快捷切换函数 */
export function setPlanMode(): void { executionMode.setMode("plan"); }
export function setAgentMode(): void { executionMode.setMode("agent"); }
export function setYoloMode(): void { executionMode.setMode("yolo"); }

/** 获取当前模式 */
export function getCurrentMode(): ExecutionMode {
  return executionMode.getMode();
}

/** 包装工具执行，自动检查模式 */
export async function executeWithModeGuard<T>(
  toolName: string,
  args: unknown,
  executeFn: () => Promise<T>
): Promise<T> {
  const check = executionMode.canExecute(toolName);
  if (!check.allowed) {
    throw new Error(`[ExecutionMode] Blocked: ${check.reason}`);
  }

  if (executionMode.needsApproval(toolName)) {
    const approved = await executionMode.requestApproval(toolName, args);
    if (!approved) {
      throw new Error(`[ExecutionMode] User denied approval for ${toolName}`);
    }
  }

  return executeFn();
}
