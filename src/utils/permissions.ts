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
  const id = Math.random().toString(36).slice(2, 10)
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
