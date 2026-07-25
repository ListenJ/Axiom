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
export function checkToolPermission(toolName: string, params: Record<string, unknown>): { allowed: boolean; confirmationId?: string; reason?: string } {
  if (toolName === "execute_command" || toolName === "shell" || toolName === "bash") {
    const command = String(params.command ?? params.script ?? "")
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

  if (toolName === "delete_file" || toolName === "remove" || toolName === "rm") {
    const path = String(params.path ?? params.file ?? "")
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

  return { allowed: true }
}

