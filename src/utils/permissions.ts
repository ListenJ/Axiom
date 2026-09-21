/**
 * Permission Control System
 * 
 * Permission levels for operations, with high-risk operation safeguards.
 */
import * as path from "node:path"
import { commandDanger } from "./command-safety.js"
import { readString } from "./env.js"

export type PermissionLevel = "normal" | "admin" | "high-risk"

export interface PermissionCheck {
  allowed: boolean
  requiresConfirmation: boolean
  level: PermissionLevel
  reason?: string
}

/**
 * 高危命令判定 —— 本函数只是 PermissionCheck 形状的适配层，判据在
 * `command-safety.ts` 的 `COMMAND_DANGER_RULES`（R3-B 单源：这里曾另立一份
 * `HIGH_RISK_PATTERNS`，不去混淆、缺提权/账号类，于是同一条命令在派发前与执行点
 * 可得相反结论）。
 */
export function checkCommandPermission(command: string): PermissionCheck {
  const danger = commandDanger(command)
  if (danger) {
    return {
      allowed: false,
      requiresConfirmation: true,
      level: "high-risk",
      reason: `High-risk operation detected: ${danger}`,
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

// ─── 能力 → 参数负载取法（判定与复核的唯一一份表）───────────────────────────
//
// 这张表原本存在两份：permission-middleware 按**工具名**查表挑字段
// （command/script/cmd/code/args），risk-monitor 按**能力**挑字段
// （command/script/cmd）。两份清单不一致，且按名字的那份未登记即不检查 ——
// G1 类缺陷的成因就是"多一份清单"。现在判定（本文件）与复核（risk-monitor）
// 读同一个 CAPABILITY_PAYLOAD，新增字段只需改这一处。

export type CapabilityPayloadKind = "command" | "path" | "url";
/** 裁决类别：`decideCapability` 的分派读这里，"取哪个负载"与"怎么判"不维护两张表 */
export type CapabilityJudgment = "filesystem" | "outbound" | "command";

export interface CapabilityPayloadSpec {
  readonly kind: CapabilityPayloadKind;
  readonly judgment: CapabilityJudgment;
  readonly fields: readonly string[];
  /**
   * 字段名**加速器**：按名取到的负载做完整裁决（越界 + 锚点）。
   * 它不是闸门 —— 未列出的同形态字段由 `shapeAdjudicable` 那条路补上，
   * 所以把 `path` 改名成 `vault_path` 只会降级为"锚点裁决"，不会脱离判定。
   */
  readonly acceleratorFields: readonly string[];
  /**
   * 该能力的负载可否由**值形态**认出。路径与 URL 有可判别语法 ⇒ 可以；
   * 命令与散文不可区分（`snapshot_create` 的 `message` 里出现 "passwd" 就是命令行形状），
   * 故 `proc.exec` 不走形态识别，改由注册处声明目标字段（`declaredTargetRequired`）。
   */
  readonly shapeAdjudicable: boolean;
  /** 派发前是否裁决（`mcp.external` 例外：远端参数形状未知，非 URL 负载交给出网规则只会误判） */
  readonly preDispatch: boolean;
  /** 注册处必须声明"哪个入参承载本能力的目标"，或显式声明 "fixed" */
  readonly declaredTargetRequired: boolean;
}

/** 路径类目标字段名加速器（原 `defaultToolGuard` 里那张 30 键名正则并入此处：全仓只有一份） */
const PATH_ACCELERATORS: readonly string[] = [
  "path", "file", "filePath", "file_path", "directory", "dir", "dirPath", "dir_path",
  "projectPath", "repoPath", "repo_path", "absPath", "abs_path", "newPath", "new_path",
  "oldPath", "old_path", "srcPath", "src_path", "destPath", "dest_path", "destination",
  "dest", "target", "source", "from", "to", "outputPath", "output_path", "folder", "cwd",
];

const payloadSpec = (
  kind: CapabilityPayloadKind,
  judgment: CapabilityJudgment,
  fields: readonly string[],
  options: Partial<Pick<CapabilityPayloadSpec, "acceleratorFields" | "shapeAdjudicable" | "preDispatch" | "declaredTargetRequired">> = {},
): CapabilityPayloadSpec => ({
  kind,
  judgment,
  fields,
  acceleratorFields: options.acceleratorFields ?? [],
  shapeAdjudicable: options.shapeAdjudicable ?? false,
  preDispatch: options.preDispatch ?? true,
  declaredTargetRequired: options.declaredTargetRequired ?? false,
});

/** 路径类能力：加速器字段做完整裁决，其余路径形态取值做锚点裁决 */
const fileSpec = (fields: readonly string[]): CapabilityPayloadSpec =>
  payloadSpec("path", "filesystem", fields, { acceleratorFields: PATH_ACCELERATORS, shapeAdjudicable: true });

/**
 * `internal` 刻意不在表内：纯计算/状态查询没有外部副作用，不进入判定与初筛。
 */
export const CAPABILITY_PAYLOAD: Readonly<Partial<Record<Capability, CapabilityPayloadSpec>>> = {
  // 命令与散文不可区分 ⇒ 不做形态识别，改由注册处声明目标字段（无声明即不可注册）
  "proc.exec": payloadSpec("command", "command", ["command", "script", "cmd", "code", "args"], {
    declaredTargetRequired: true,
  }),
  // SQL 文本按路径裁决没有意义（语句解析未实现，见 §2.7.5）⇒ 只保留路径类入参的完整裁决
  "db.write": payloadSpec("command", "filesystem", ["sql", "query", "statement"], {
    acceleratorFields: PATH_ACCELERATORS,
  }),
  "fs.read": fileSpec(["path", "file", "filePath", "directory", "dir", "projectPath", "repoPath"]),
  "fs.write": fileSpec(["path", "file", "filePath", "destination", "dest", "target", "directory", "dir"]),
  "fs.delete": fileSpec(["path", "file", "filePath", "directory", "dir"]),
  "fs.glob": fileSpec(["pattern", "path", "projectPath", "dir"]),
  "cfg.write": fileSpec(["path", "key", "filePath"]),
  "net.outbound": payloadSpec("url", "outbound", ["url", "href", "target", "endpoint"], {
    shapeAdjudicable: true,
  }),
  // 外部 MCP 工具参数形状由远端决定：复核层整体序列化送筛（risk-monitor），派发前不裁决
  "mcp.external": payloadSpec("path", "outbound", ["url", "command", "path", "file"]),
};

/** 注册处对"目标在哪个入参"的声明；"fixed" = 目标由实现固定，入参里没有可裁决对象。 */
export type PayloadFieldDeclaration = readonly string[] | "fixed";
export type PayloadFields = Readonly<Partial<Record<Capability, PayloadFieldDeclaration>>>;

/** 只有短、单行、不含空白的字符串才可能是"目标"；正文与散文不参评。 */
function looksAdjudicableValue(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 512 && !/[\r\n]/.test(v) && !/\s/.test(v);
}

/** 值形态识别：带方案的 URL 字面量。 */
export function looksUrlLike(value: string): boolean {
  if (!looksAdjudicableValue(value)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

/**
 * 值形态识别：一个字符串"看起来就是"文件路径目标。
 * 刻意保守 —— 含空白（标题/正文/多行内容）一律不算；误判的代价是把正常调用推进审批。
 */
export function looksPathLike(value: string): boolean {
  if (!looksAdjudicableValue(value) || looksUrlLike(value)) return false;
  const v = value.trim().replace(/\\/g, "/");
  if (v === "~" || v.startsWith("~/") || v.startsWith("/") || v.startsWith("./") || v.startsWith("../")) return true;
  if (/^\.[\w.-]+$/.test(v)) return true; // 点开头隐藏名：.env / .bashrc / .gitconfig
  if (v.includes("/")) return true; // 分段相对路径：src/a.ts / owner/repo
  return /\.[A-Za-z0-9]{1,8}$/.test(v); // 带扩展名的相对文件名：notes.txt
}

export interface CapabilityPayloadCandidate {
  readonly kind: CapabilityPayloadKind;
  readonly payload: string;
  readonly field: string;
  /** true = 字段名在声明/加速器清单里（完整裁决）；false = 值形态认出（只裁与上下文无关的规则） */
  readonly declared: boolean;
}
/** 某次调用里指定能力的全部可裁决负载：声明字段优先，值形态补齐改名后的同类字段。 */
export function payloadCandidatesForCapability(
  capability: Capability,
  args: unknown,
  declaredFields?: PayloadFieldDeclaration,
): CapabilityPayloadCandidate[] {
  const spec = CAPABILITY_PAYLOAD[capability];
  if (!spec || typeof args !== "object" || args === null) return [];
  if (declaredFields === "fixed") return []; // 目标由实现固定，入参里没有可裁决对象
  const record = args as Record<string, unknown>;
  const out: CapabilityPayloadCandidate[] = [];
  const takenFields = new Set<string>();
  const seenValue = new Set<string>();
  const push = (field: string, value: unknown, declared: boolean): void => {
    if (typeof value !== "string") return;
    const payload = value.trim();
    if (!payload) return;
    const key = field + "\u0000" + payload;
    if (seenValue.has(key)) return;
    seenValue.add(key);
    takenFields.add(field);
    out.push({ kind: spec.kind, payload, field, declared });
  };
  for (const field of declaredFields ?? []) push(field, record[field], true);
  for (const field of spec.fields) push(field, record[field], true);
  for (const field of spec.acceleratorFields) push(field, record[field], true);
  if (spec.shapeAdjudicable) {
    // 字段名不在任何清单里：由值形态认领（后续只裁与上下文无关的规则）
    const matches = spec.kind === "url" ? looksUrlLike : looksPathLike;
    for (const [field, value] of Object.entries(record)) {
      if (takenFields.has(field) || typeof value !== "string") continue;
      if (matches(value)) push(field, value, false);
    }
  }
  return out;
}

/** 取某一次调用里指定能力的第一条负载；没有可裁决字段则返回 null（不猜测）。 */
export function payloadForCapability(
  capability: Capability,
  args: unknown,
  declaredFields?: PayloadFieldDeclaration,
): { kind: CapabilityPayloadKind; payload: string } | null {
  const first = payloadCandidatesForCapability(capability, args, declaredFields)[0];
  return first ? { kind: first.kind, payload: first.payload } : null;
}

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

/**
 * 执行锚点命中（**不依赖沙箱根**的那一半判定）。
 *
 * 派发前初筛只能用它：一条叫 `vault_path` 的入参指向 `/home/x/.axiom/vault` 时，
 * 是否越界取决于该工具真正的落点，只有实际 I/O 点（safe-fs）知道；
 * 而"字符串里出现锚点"与上下文无关，改名脱离不了它。
 */
export function executionAnchorHit(target: string): string | null {
  return anchorHitPerHop(target);
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
  const spec = CAPABILITY_PAYLOAD[check.capability];
  if (!spec) {
    // 表外档位（含被绕过类型检查传进来的串）一律拒绝：裁决规则不存在即不可得
    return check.capability === "internal"
      ? { allow: true }
      : { allow: false, reason: `unknown capability '${check.capability}': no adjudication rule` };
  }
  switch (spec.judgment) {
    case "filesystem":
      return decideFilesystem(check);
    case "outbound":
      return decideOutbound(check);
    case "command": {
      const cmd = checkCommandPermission(check.target);
      return cmd.allowed ? { allow: true } : { allow: false, reason: cmd.reason ?? "high-risk command" };
    }
  }
}

export interface CallPayloadAdjudication {
  readonly capabilities: readonly Capability[];
  readonly args: unknown;
  /** 调用主体（审计用） */
  readonly principal?: string;
  /** 注册处声明的"目标在哪个入参"；未声明时走字段加速器 + 值形态识别 */
  readonly payloadFields?: PayloadFields;
}

/**
 * 派发前对一次调用的全部候选负载做裁决：任一候选被拒即整体拒绝（fail-closed）。
 * 守卫层（`src/mcp/tool-registry.ts`）与权限中间件读这一份口径，不各自维护第二份。
 *
 * 两条刻意的不对称：
 * - 命令类负载不靠形态猜测（散文与命令行不可区分），只认注册处声明与常见命令字段；
 * - 形态识别出的**路径**只裁锚点，不裁越界 —— 合法落点可以在 cwd 之外（vault / axiom home），
 *   是否越界由实际 I/O 点判定（I2）。
 */
export function adjudicateCallPayloads(check: CallPayloadAdjudication): CapabilityDecision {
  for (const capability of check.capabilities) {
    const spec = CAPABILITY_PAYLOAD[capability];
    if (!spec || !spec.preDispatch) continue;
    const candidates = payloadCandidatesForCapability(capability, check.args, check.payloadFields?.[capability]);
    for (const candidate of candidates) {
      const decision =
        candidate.declared || spec.judgment !== "filesystem"
          ? decideCapability({ capability, target: candidate.payload, principal: check.principal })
          : anchorOnlyDecision(candidate.payload);
      if (decision.allow) continue;
      return {
        allow: false,
        reason: capability + ": " + (decision.reason ?? "denied") + " (field=" + candidate.field + ")",
      };
    }
  }
  return { allow: true };
}

function anchorOnlyDecision(target: string): CapabilityDecision {
  const hit = executionAnchorHit(target);
  return hit
    ? { allow: false, reason: "target '" + target + "' is an execution anchor (" + hit + ")" }
    : { allow: true };
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
// 安全护栏：`COMMAND_DANGER_RULES`（command-safety.ts 单源）命中的操作（rm -rf /、mkfs、
// DROP TABLE 等）永远需要手动确认，autoAcceptMode 无法绕过。这由 checkCommandPermission
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
