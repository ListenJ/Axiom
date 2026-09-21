/**
 * Permission Control System
 * 
 * Permission levels for operations, with high-risk operation safeguards.
 */
import * as path from "node:path"
import { readString } from "./env.js"

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
 *
 * 判定内核已收敛到 decideCapability（S3 / I1）：本函数只是 PermissionCheck 形状的
 * 适配层，供 permission-middleware 与 /health 探测端点复用同一结论，
 * 不再独立维护第二份敏感路径清单。
 */
export function checkFilePermission(path: string, operation: "read" | "write" | "delete" | "execute"): PermissionCheck {
  const capability: Capability =
    operation === "delete" ? "fs.delete" : operation === "execute" ? "proc.exec" : operation === "write" ? "fs.write" : "fs.read";
  const decision = decideCapability({ capability, target: path });
  if (decision.allow) return { allowed: true, requiresConfirmation: false, level: "normal" };
  return {
    allowed: false,
    requiresConfirmation: true,
    level: "high-risk",
    reason: decision.reason ?? `Capability ${capability} denied for ${path}`,
  };
}

// ─── 能力模型（S3 提权阻断的判定内核）───────────────────────────────────────
//
// 口径：授权对象是「能力」，不是「工具名」。名字表是 G1 类缺陷的结构根因——
// 新增/改名工具会静默脱离守卫。能力由注册处声明（I1），由实际 I/O 点判定（I2）。

/** 能力词表：唯一权威。internal = 不触碰任何特权资源。
 *  词表刻意不含「读取凭据」：~/.axiom/axiom-secrets/ 与 .env 无可授权路径，
 *  无声明即不可得（I1），故无需为它保留一个可申请的档位。 */
export type Capability =
  | "internal"
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "fs.glob"
  | "net.outbound"
  | "proc.exec"
  | "cfg.write"
  | "db.write"
  | "mcp.external";

export interface ExecutionAnchor {
  readonly pattern: RegExp;
  readonly label: string;
}

const anchor = (pattern: RegExp, label: string): ExecutionAnchor => ({ pattern, label });

/**
 * 执行锚点清单 —— 单一来源（S-5）。
 *
 * 这些位置一旦被写入，就等于「下一次 shell / 服务 / CI / 登录」以更高权限执行我们
 * 刚写下的内容：这是提权链路的最后一跳，因此读可以谈，写一律拒。
 */
export const EXECUTION_ANCHORS: readonly ExecutionAnchor[] = [
  anchor(/(^|\/)\.git(\/|$)/, "git 元数据"),
  anchor(/(^|\/)\.git\/hooks(\/|$)/, "git hook 目录"),
  anchor(/(^|\/)\.gitconfig$|(^|\/)\.git\/config$/, "git 配置"),
  anchor(/(^|\/)\.(bashrc|zshrc|zshenv|shrc|bash_profile|bash_login|bash_aliases|bash_logout|zprofile|profile)$/, "shell rc"),
  anchor(/(^|\/)(crontab|cron\.(d|daily|hourly)|spool\/cron)/, "cron 计划任务"),
  anchor(/(^|\/)systemd(\/|$)|\.service$|(^|\/)rc\.local$/, "systemd / init 服务"),
  anchor(/(^|\/)sudoers(\.d)?(\/|$)/, "sudoers"),
  anchor(/(^|\/)\.ssh(\/|$)/, "ssh 目录与 authorized_keys"),
  anchor(/(^|\/)authorized_keys2?$|(^|\/)id_(rsa|ed25519|ecdsa)$/, "authorized_keys"),
  anchor(/(^|\/)\.axiom\/axiom-secrets(\/|$)/, "本地凭据目录"),
  anchor(/(^|\/)\.env(\.|$)/i, ".env 密钥文件"),
  anchor(/(^|\/)\.github\/workflows(\/|$)/, "CI 工作流"),
  anchor(/(^|\/)ld\.so\.preload$|(^|\/)ld\.so\.conf\.d(\/|$)/, "动态库预加载"),
  anchor(/(^|\/)data\/model-config\.json$/, "模型密钥配置"),
  anchor(/(^|\/)data\/[^/]+\.db(-\w+)?$/, "运行时数据库"),
];

/** 环境白名单：逗号分隔的精确主机名，net.outbound 默认拒绝内网与元数据地址。 */
export const NET_ALLOWLIST_ENV = "AXIOM_NET_ALLOWLIST";

export interface CapabilityCheck {
  capability: Capability;
  /** 文件系统路径 / URL / 命令行，随能力而变 */
  target: string;
  /** 调用主体（审计用；不影响放行，放行只由能力与目标决定） */
  principal?: string;
}

export interface CapabilityDecision {
  allow: boolean;
  reason?: string;
}

const LOOPBACK_OR_LINK_LOCAL = /^(?:127\.|0\.0\.0\.0$|169\.254\.|\[?::1\]?|localhost$)/i;
const PRIVATE_RANGES = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function anchorHit(target: string): string | null {
  const norm = target.replace(/\\/g, "/");
  for (const { pattern, label } of EXECUTION_ANCHORS) {
    if (pattern.test(norm)) return label;
  }
  return null;
}

/** 逐跳检查相对路径的每一个前缀，防止只在末段上做判定被目录构造绕过。 */
function anchorHitPerHop(relative: string): string | null {
  const segments = relative.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let i = 1; i <= segments.length; i++) {
    const hit = anchorHit(segments.slice(0, i).join("/"));
    if (hit) return hit;
  }
  return null;
}

function decideFilesystem(check: CapabilityCheck): CapabilityDecision {
  const base = process.cwd();
  const abs = path.resolve(base, check.target);
  const relative = path.relative(base, abs);
  // relative === "" 表示目标就是沙箱根本身（列目录的合法情形），不构成越界
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { allow: false, reason: `target '${check.target}' escapes sandbox root ${base}` };
  }
  const hop = anchorHitPerHop(relative);
  if (hop) return { allow: false, reason: `target '${check.target}' is an execution anchor (${hop})` };
  return { allow: true };
}

function decideOutbound(check: CapabilityCheck): CapabilityDecision {
  let url: URL;
  try {
    url = new URL(check.target);
  } catch {
    return { allow: false, reason: `unparseable URL: ${check.target.slice(0, 120)}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allow: false, reason: `scheme '${url.protocol}' not allowed for net.outbound` };
  }
  const host = url.hostname.toLowerCase();
  const allowlist = readString(NET_ALLOWLIST_ENV)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (LOOPBACK_OR_LINK_LOCAL.test(host) || PRIVATE_RANGES.test(host)) {
    // 回环 / 链路本地 / RFC1918：SSRF 打自家服务与内网元数据是最短的提权链路。
    // 只有显式登记的主机名可豁免；IP 字面量永不豁免。
    if (!allowlist.includes(host)) {
      return { allow: false, reason: `host '${host}' is loopback/link-local/private and not in ${NET_ALLOWLIST_ENV}` };
    }
  }
  return { allow: true };
}

/**
 * 唯一授权决策点（I1/I2 的判定内核）。
 *
 * 注意：本函数只做字符串/规则判定，不触碰文件系统。realpath、逐跳符号链接解析
 * 由调用方（src/utils/safe-fs.ts 在实际 I/O 点）完成后传入已规范化的目标。
 */
export function decideCapability(check: CapabilityCheck): CapabilityDecision {
  switch (check.capability) {
    case "internal":
      return { allow: true };
    case "fs.read":
    case "fs.write":
    case "fs.delete":
    case "fs.glob":
    case "cfg.write":
    case "db.write":
      return decideFilesystem(check);
    case "net.outbound":
    case "mcp.external":
      return decideOutbound(check);
    case "proc.exec": {
      const cmd = checkCommandPermission(check.target);
      return cmd.allowed
        ? { allow: true }
        : { allow: false, reason: cmd.reason ?? "high-risk command" };
    }
  }
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
