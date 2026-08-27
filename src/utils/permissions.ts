/**
 * Permission Control System
 * 
 * Permission levels for operations, with high-risk operation safeguards.
 */

export type PermissionLevel = "normal" | "admin" | "high-risk"

export interface PermissionCheck {
  allowed: boolean
  requiresConfirmation: boolean
  level: PermissionLevel
  reason?: string
}

const HIGH_RISK_PATTERNS = [
  { pattern: /rm\s+-rf\s+\//, description: "Full disk recursive delete" },
  { pattern: /mkfs/, description: "Filesystem format" },
  { pattern: /dd\s+if=\/dev/, description: "Raw device write" },
  { pattern: /fdisk/, description: "Disk partition manipulation" },
  { pattern: /chmod\s+777/, description: "Overly permissive file mode" },
  { pattern: /shutdown/, description: "System shutdown" },
  { pattern: /reboot/, description: "System reboot" },
  { pattern: /passwd/, description: "Password change" },
  { pattern: /useradd/, description: "User creation" },
  { pattern: /deluser|userdel/, description: "User deletion" },
  { pattern: /sudo\s+rm/, description: "Root-level deletion" },
  { pattern: /wget.*\.sh\s*\|/, description: "Piped shell execution from URL" },
  { pattern: /curl.*\|.*bash/, description: "Piped shell execution from URL" },
  { pattern: /drop\s+table/i, description: "Database table deletion" },
  { pattern: /truncate\s+table/i, description: "Database table truncation" },
  { pattern: /DELETE\s+FROM/i, description: "Database mass deletion" },
]

/**
 * Check if a command or operation is high-risk.
 */
export function checkCommandPermission(command: string): PermissionCheck {
  for (const item of HIGH_RISK_PATTERNS) {
    if (item.pattern.test(command)) {
      return {
        allowed: false,
        requiresConfirmation: true,
        level: "high-risk",
        reason: `High-risk operation detected: ${item.description}`,
      }
    }
  }
  return { allowed: true, requiresConfirmation: false, level: "normal" }
}

/**
 * Check file operation permissions.
 */
export function checkFilePermission(path: string, operation: "read" | "write" | "delete" | "execute"): PermissionCheck {
  const sensitivePaths = [
    "/etc", "/boot", "/sys", "/proc", "/dev",
    ".ssh", ".env", ".git/config",
    "/etc/shadow", "/etc/passwd", "/etc/sudoers",
  ]
  
  if (operation === "delete") {
    if (path === "/" || path.startsWith("/etc") || path.startsWith("/boot")) {
      return { allowed: false, requiresConfirmation: true, level: "high-risk", reason: "Deletion of system-critical path blocked" }
    }
  }
  
  if ((operation === "write" || operation === "delete") && sensitivePaths.some(p => path.includes(p))) {
    return { allowed: false, requiresConfirmation: true, level: "high-risk", reason: `Sensitive path: ${path} requires manual confirmation` }
  }
  
  return { allowed: true, requiresConfirmation: false, level: "normal" }
}

const pendingConfirmations = new Map<string, { command: string; timestamp: number; expiresAt: number }>()

/**
 * Request user confirmation for a high-risk operation.
 */
export function requestConfirmation(command: string): string {
  const id = crypto.randomUUID()
  pendingConfirmations.set(id, {
    command,
    timestamp: Date.now(),
    expiresAt: Date.now() + 300_000, // 5 minute expiry
  })
  return id
}

/**
 * Confirm a high-risk operation by ID.
 */
export function confirmOperation(id: string): { approved: boolean; command?: string } {
  const entry = pendingConfirmations.get(id)
  if (!entry) return { approved: false }
  if (Date.now() > entry.expiresAt) {
    pendingConfirmations.delete(id)
    return { approved: false }
  }
  pendingConfirmations.delete(id)
  return { approved: true, command: entry.command }
}

// ─── 自动接收模式 (Auto-Accept Mode) ───────────────────────────────────────
//
// 用户可在前端 UI 切换"权限自动接收/手动确认"。开启后，"normal" 级别
// 操作（普通文件读写、安全命令）会被自动放行，无需用户点击确认。
//
// 安全护栏：HIGH_RISK_PATTERNS 命中的操作（rm -rf /、mkfs、DROP TABLE
// 等）永远需要手动确认，autoAcceptMode 无法绕过。这由 checkCommandPermission
// 与 checkFilePermission 在判断前先做 high-risk 检测保证。
//
// 模式仅存在于内存（进程级单例），重启后恢复默认（手动确认）。

let autoAcceptMode = false;

/** 查询当前是否启用自动接收模式。 */
export function isAutoAcceptMode(): boolean {
  return autoAcceptMode;
}

/** 设置自动接收模式（开启/关闭）。返回设置后的新值。 */
export function setAutoAcceptMode(enabled: boolean): boolean {
  autoAcceptMode = !!enabled;
  return autoAcceptMode;
}

/**
 * 在 autoAcceptMode 开启时，"normal" 级别操作自动放行；
 * "high-risk" 永远返回 requiresConfirmation=true。
 *
 * 调用方典型用法：
 *   const check = checkCommandPermission(cmd);
 *   if (!check.allowed && !isAutoAcceptMode() && check.requiresConfirmation) {
 *     // 走手动确认流程
 *   }
 *   // 若 autoAcceptMode 开启且 check.level === 'normal'，直接放行
 */
export function shouldAutoAccept(check: PermissionCheck): boolean {
  return autoAcceptMode && check.level === "normal" && check.allowed;
}
