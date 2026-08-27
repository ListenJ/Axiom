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
import { monitorToolPayload } from "./risk-monitor.js";
import {
  TOOL_CLASSIFICATIONS,
  type ExecutionMode,
  type ToolClassification,
  type ToolRisk,
} from "./tool-classifications.js";

export { TOOL_CLASSIFICATIONS };
export type { ExecutionMode, ToolClassification, ToolRisk };

/** 模式配置 */
export interface ModeConfig {
  mode: ExecutionMode;
  allowDestructive: boolean;
  requireApproval: boolean;
  maxAutoRetries: number;
  allowedToolCategories: string[];
  blockedTools: string[];
}


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

  /**
   * 强制审批（风险监视升级专用）—— YOLO 模式也不豁免。
   *
   * 与 requestApproval 的唯一区别：不检查 yolo 快捷路径。
   * 当 risk-monitor 双层复核（边缘初筛 + 主模型复核）确认负载危险时，
   * 即使在 YOLO 模式下也必须经过人工确认（宪法第 4 条：安全模式 > 效率）。
   */
  async requestApprovalForced(toolName: string, args: unknown): Promise<boolean> {
    const classification = TOOL_CLASSIFICATIONS.find((t) => t.name === toolName);
    const risk: ApprovalRisk = classification?.risk ?? "unknown";

    logger.warn(`[ExecutionMode] FORCED approval (risk-monitor escalation) for ${toolName} (${risk})`, { args });

    try {
      const approved = await getApprovalBridge().request(toolName, args, { risk });
      logger.info(`[ExecutionMode] ${toolName} ${approved ? "approved" : "denied"} via bridge (forced)`);
      return approved;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[ExecutionMode] ${toolName} forced approval failed: ${reason}`);
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

  // ── 高危操作双层复核：边缘初筛 → 主模型复核 → 强制 HITL ──
  // 监视静态分级表感知不到的负载内容（如 terminal_exec 里的 rm -rf /usr）
  // 失败语义：初筛降级/复核否决 → 不影响下方原有审批流程
  const verdict = await monitorToolPayload(toolName, args);
  if (verdict === "require-approval") {
    logger.warn(`[ExecutionMode] Risk monitor escalated ${toolName} to mandatory approval`);
    const approved = await executionMode.requestApprovalForced(toolName, args);
    if (!approved) {
      throw new Error(`[ExecutionMode] Risk monitor: approval denied for ${toolName}`);
    }
  }

  if (executionMode.needsApproval(toolName)) {
    const approved = await executionMode.requestApproval(toolName, args);
    if (!approved) {
      throw new Error(`[ExecutionMode] User denied approval for ${toolName}`);
    }
  }

  return executeFn();
}
