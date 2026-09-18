/**
 * Permission middleware for HTTP routes and tool execution.
 */
import { checkCommandPermission, checkFilePermission, requestConfirmation, isAutoAcceptMode } from "./permissions.js"
import { logger } from "./logger.js"

/**
 * Middleware to check if a tool execution is permitted.
 * Blocks high-risk operations from agent execution.
 *
 * autoAcceptMode 影响：
 *   - 开启时，"normal" 级别操作直接放行（不创建 confirmationId）
 *   - "high-risk" 操作永远走手动确认流程，autoAcceptMode 无法绕过
 */
/**
 * 受控工具名表（审计 C-01：原仅 3 工具导致 terminal_exec 等直通）。
 * 扩展后覆盖 MCP 实际暴露的终端与文件工具，避免“总是 true”绕过。
 */
const COMMAND_TOOLS = new Set([
  "terminal_exec",
  "execute_command",
  "shell",
  "bash",
  "pty_terminal_input",
]);
const DELETE_TOOLS = new Set(["delete_file", "remove", "rm", "fs_delete"]);
const WRITE_TOOLS = new Set(["fs_write", "fs_move", "write_file", "move_file"]);

export function checkToolPermission(toolName: string, params: Record<string, unknown>): { allowed: boolean; confirmationId?: string; reason?: string } {
  // 命令类：支持 command/script/cmd/code 多键，统一走 permissions 硬底线
  if (COMMAND_TOOLS.has(toolName)) {
    const command = String(params.command ?? params.script ?? (params as any).cmd ?? (params as any).code ?? (params as any).args ?? "")
    const check = checkCommandPermission(command)
    if (!check.allowed) {
      // high-risk 永远走手动确认，无论 autoAcceptMode 是否开启
      logger.warn(`[Permission] Blocked ${toolName}: ${check.reason}`)
      const confirmationId = requestConfirmation(command)
      return { allowed: false, confirmationId, reason: check.reason }
    }
    // normal 级别命令：若 autoAcceptMode 开启，直接放行
    if (isAutoAcceptMode()) {
      return { allowed: true }
    }
  }

  if (DELETE_TOOLS.has(toolName)) {
    const path = String(params.path ?? params.file ?? (params as any).source ?? "")
    const check = checkFilePermission(path, "delete")
    if (!check.allowed) {
      // high-risk 路径删除永远走手动确认
      logger.warn(`[Permission] Blocked ${toolName}: ${check.reason}`)
      const confirmationId = requestConfirmation(path)
      return { allowed: false, confirmationId, reason: check.reason }
    }
    if (isAutoAcceptMode()) {
      return { allowed: true }
    }
  }

  if (WRITE_TOOLS.has(toolName)) {
    const path = String(params.path ?? params.file ?? (params as any).destination ?? "")
    // 写操作也需经敏感路径校验（与 delete 共用敏感列表）
    const check = checkFilePermission(path, "write")
    if (!check.allowed) {
      logger.warn(`[Permission] Blocked ${toolName}: ${check.reason}`)
      const confirmationId = requestConfirmation(path)
      return { allowed: false, confirmationId, reason: check.reason }
    }
    if (isAutoAcceptMode()) {
      return { allowed: true }
    }
  }

  // 非受控工具（memory_search、kg_* 等只读工具）默认放行；
  // 当前为“监控+硬底线”模式，非 RBAC 全量鉴权，见 docs/ARCHITECTURE.md §5.4 与本文件头注释。
  return { allowed: true }
}

