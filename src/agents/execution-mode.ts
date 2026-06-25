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
  // 安全工具（只读）
  { name: "fs_read", risk: "safe", category: "filesystem", description: "读取文件内容" },
  { name: "fs_list", risk: "safe", category: "filesystem", description: "列出目录内容" },
  { name: "fs_search", risk: "safe", category: "filesystem", description: "搜索文件" },
  { name: "fs_exists", risk: "safe", category: "filesystem", description: "检查文件是否存在" },
  { name: "git_status", risk: "safe", category: "git", description: "查看 git 状态" },
  { name: "git_diff", risk: "safe", category: "git", description: "查看代码差异" },
  { name: "git_log", risk: "safe", category: "git", description: "查看提交历史" },
  { name: "git_branch", risk: "safe", category: "git", description: "查看分支列表" },
  { name: "git_blame", risk: "safe", category: "git", description: "查看行级作者" },
  { name: "git_show", risk: "safe", category: "git", description: "查看提交详情" },
  { name: "terminal_info", risk: "safe", category: "terminal", description: "获取系统信息" },
  { name: "terminal_list", risk: "safe", category: "terminal", description: "列出进程" },
  { name: "code_symbols", risk: "safe", category: "code-analysis", description: "查找符号定义" },
  { name: "code_references", risk: "safe", category: "code-analysis", description: "查找引用" },
  { name: "code_diagnostics", risk: "safe", category: "code-analysis", description: "获取诊断信息" },
  { name: "code_outline", risk: "safe", category: "code-analysis", description: "获取文件大纲" },
  { name: "code_analyze", risk: "safe", category: "code-analysis", description: "分析代码" },
  { name: "memory_search", risk: "safe", category: "memory", description: "搜索记忆" },
  { name: "memory_read", risk: "safe", category: "memory", description: "读取记忆" },
  { name: "memory_browse", risk: "safe", category: "memory", description: "浏览记忆网络" },
  { name: "memory_stats", risk: "safe", category: "memory", description: "记忆统计" },
  { name: "web_fetch", risk: "safe", category: "web", description: "获取网页内容" },
  { name: "web_search", risk: "safe", category: "web", description: "搜索网络" },
  { name: "token_stats", risk: "safe", category: "monitoring", description: "查看 token 统计" },
  { name: "skill_list", risk: "safe", category: "skills", description: "列出技能" },

  // 谨慎工具（可能影响状态）
  { name: "fs_write", risk: "caution", category: "filesystem", description: "写入文件（覆盖风险）" },
  { name: "fs_move", risk: "caution", category: "filesystem", description: "移动文件" },
  { name: "terminal_exec", risk: "caution", category: "terminal", description: "执行命令（可能破坏环境）" },
  { name: "code_generate", risk: "caution", category: "code", description: "生成代码（写入文件）" },
  { name: "code_refactor", risk: "caution", category: "code", description: "重构代码（修改文件）" },
  { name: "code_review", risk: "caution", category: "code", description: "代码审查（可能触发修改）" },
  { name: "memory_write", risk: "caution", category: "memory", description: "写入记忆" },
  { name: "skill_create", risk: "caution", category: "skills", description: "创建技能" },
  { name: "skill_reload", risk: "caution", category: "skills", description: "重载技能" },

  // 破坏性工具（高风险）
  { name: "fs_delete", risk: "destructive", category: "filesystem", description: "删除文件（不可逆）" },
  { name: "terminal_kill", risk: "destructive", category: "terminal", description: "终止进程" },
];

// ========== 模式配置表 ==========

export const MODE_CONFIGS: Record<ExecutionMode, ModeConfig> = {
  plan: {
    mode: "plan",
    allowDestructive: false,
    requireApproval: false,
    maxAutoRetries: 0,
    allowedToolCategories: ["filesystem", "git", "terminal", "code-analysis", "memory", "web", "monitoring", "skills"],
    blockedTools: ["fs_write", "fs_delete", "fs_move", "terminal_exec", "terminal_kill", "code_generate", "code_refactor", "code_review", "memory_write", "skill_create", "skill_reload"],
  },
  agent: {
    mode: "agent",
    allowDestructive: true,
    requireApproval: true,
    maxAutoRetries: 2,
    allowedToolCategories: ["filesystem", "git", "terminal", "code-analysis", "memory", "web", "monitoring", "skills", "code"],
    blockedTools: [],
  },
  yolo: {
    mode: "yolo",
    allowDestructive: true,
    requireApproval: false,
    maxAutoRetries: 3,
    allowedToolCategories: ["filesystem", "git", "terminal", "code-analysis", "memory", "web", "monitoring", "skills", "code"],
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
