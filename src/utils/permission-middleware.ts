/**
 * Permission middleware for HTTP routes and tool execution.
 */
import { checkCommandPermission, checkFilePermission, requestConfirmation } from "./permissions.js"
import { logger } from "./logger.js"

/**
 * Middleware to check if a tool execution is permitted.
 * Blocks high-risk operations from agent execution.
 */
export function checkToolPermission(toolName: string, params: Record<string, unknown>): { allowed: boolean; confirmationId?: string; reason?: string } {
  if (toolName === "execute_command" || toolName === "shell" || toolName === "bash") {
    const command = String(params.command ?? params.script ?? "")
    const check = checkCommandPermission(command)
    if (!check.allowed) {
      logger.warn(`[Permission] Blocked ${toolName}: ${check.reason}`)
      const confirmationId = requestConfirmation(command)
      return { allowed: false, confirmationId, reason: check.reason }
    }
  }
  
  if (toolName === "delete_file" || toolName === "remove" || toolName === "rm") {
    const path = String(params.path ?? params.file ?? "")
    const check = checkFilePermission(path, "delete")
    if (!check.allowed) {
      logger.warn(`[Permission] Blocked ${toolName}: ${check.reason}`)
      const confirmationId = requestConfirmation(path)
      return { allowed: false, confirmationId, reason: check.reason }
    }
  }
  
  return { allowed: true }
}
