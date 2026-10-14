/**
 * 特权调用复核器 —— 能力驱动的灰区初筛 + 确定性链路复核
 *
 * 定位：由 `src/mcp/tool-registry.ts` 的注册守卫在执行前调用（S3 / P2）。
 * 监视对象为正则硬底线（permissions.ts 的 `decideCapability`）覆盖不到的**灰区**
 * 负载内容：静态判定能看出"这是一次 fs.write"，看不出"这条命令是 rm -rf /usr"。
 *
 * 两层，职责不同且互不依赖（层间独立性）：
 *   1. `screenToolCall`：概率层。边缘小模型初筛 → 主模型复核 → 升级审批。
 *      只负责"建议是否要人来把关"，不授予任何能力；可用 EDGE_RISK_MONITOR=0
 *      关掉，关掉后确定性层仍然强制。
 *   2. `reviewSequence`：确定性层。跨调用序列复核（I4），纯本地计数，不调模型，
 *      因此不受任何概率层开关影响，也**没有回环/地址豁免**（键只有主体）。
 *
 * 关键设计：判定输入是**能力**（`Capability`）而不是工具名。
 * 旧实现用一张"工具名 → 是否筛查"的常量表查表，未登记的名字一律放行 ——
 * 审计 G1 证实真正暴露的 `write` 工具名根本不在表里，复核对它恒为 pass。
 * 现在只要声明了 `proc.exec` / `fs.write` 等能力，改名、包装、MCP 子进程工具
 * （`mcp_${server}_${tool}`）都同样进入复核（封堵 L4 / L5 / L9）。
 *
 * 回退语义（概率层）：
 *   - 初筛失败/降级 → 放行（不打断 agent，确定性层不受影响）
 *   - 复核失败 + 初筛 high → 升级审批（fail-closed）
 *   - 复核失败 + 初筛 medium → 放行（fail-open）
 *
 * 所有升级判定写 auditLogger（security.alert 事件）。
 */

import { z } from "zod";
import { isEdgeEnabled, extractJson } from "../local-llm/edge-client.js";
import { screenPayloadWithEdge, type EdgeRisk, type PayloadKind } from "../local-llm/risk-screen.js";
import { auditLogger } from "../utils/audit-logger.js";
import { UNATTRIBUTED_PRINCIPAL } from "../utils/call-context.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import {
  CAPABILITY_PAYLOAD as PERMISSION_CAPABILITY_PAYLOAD,
  HIGH_RISK_CAPABILITIES,
  payloadForCapability,
  type Capability,
  type PayloadFields,
} from "../utils/permissions.js";

/** 复核结论 */
export type RiskVerdict = "pass" | "require-approval";

/**
 * 审计 C-4（2026-08-24）：初筛降级/失败导致的旁路此前完全不可观测。
 * 计数器 + 审计事件让"本次判定来自降级"可见；EDGE_RISK_FAIL_CLOSED=1
 * 时升级为强制审批（默认保持 fail-open 以不阻断离线环境）。
 */
let degradedBypassCount = 0;
export function getDegradedBypassCount(): number {
  return degradedBypassCount;
}
export function resetDegradedBypassCount(): void {
  degradedBypassCount = 0;
}

function isFailClosedEnabled(): boolean {
  // 显式开启「所有降级场景一律 fail-closed」（默认 0，见下方说明）
  return readString("EDGE_RISK_FAIL_CLOSED", "0") === "1";
}

/**
 * 初筛降级时**必须强制审批**的能力集（静态判定，不依赖已降级的初筛）。
 *
 * 修复（审计 A 的配套项）：初筛依赖外部模型/网络；离线或网络失败时它会被标记为
 * `degraded`，此时 `edge.risk === "low"` **并不代表真的低风险**，而是"根本没测出来"。
 * 原实现对这种情况默认直接放行（fail-open）—— 实测后果是 `/mcp/scene` 触发的
 * `terminal_exec` 调用被一路放行，且日志里明晃晃写着 `failClosed:false`。
 *
 * 处置：保留"离线环境不整体阻断"的可用性取舍（不把默认翻成全局 fail-closed），
 * 但对具备**执行 / 写入 / 删除 / 外发 / 改配置 / 改库**能力的调用改为降级时恒需审批
 * —— 这些正是一旦误放行就不可逆的操作。
 *
 * R1 变更：这里原本是 11 个工具名（DEGRADED_MUST_APPROVE_TOOLS）。按名字查表有两个
 * 实测缺陷：改名/包装（`mcp_${server}_${tool}`）即脱离名单，且未登记的名字一律 fail-open；
 * 按能力判定后同一结论自动覆盖全部 183 个注册点，名单不再需要维护。
 */
const DEGRADED_MUST_APPROVE_CAPABILITIES: ReadonlySet<Capability> = HIGH_RISK_CAPABILITIES;

/** 初筛不可用（降级或抛异常）时的处置：持有高危能力者恒需审批，其余取决于 EDGE_RISK_FAIL_CLOSED */
function degradedPolicy(capabilities: readonly Capability[]): {
  highRisk: boolean;
  mustApprove: boolean;
} {
  const highRisk = capabilities.some((c) => DEGRADED_MUST_APPROVE_CAPABILITIES.has(c));
  return { highRisk, mustApprove: highRisk || isFailClosedEnabled() };
}

// ── P2-13：判定缓存 ─────────────────────────────────────────
// 同一 (kind,payload) 的确定性终态短期复用，跳过双层 LLM。仅缓存不依赖
// 可用性状态的结论；degraded 旁路与"复核不可用 fail-open"一律不缓存。
interface VerdictCacheEntry {
  verdict: RiskVerdict;
  expiresAt: number;
}
const verdictCache = new Map<string, VerdictCacheEntry>();
const VERDICT_CACHE_TTL_MS = (() => {
  const n = parseInt(readString("RISK_VERDICT_CACHE_TTL_MS", "300000"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 300000;
})();
const VERDICT_CACHE_MAX = 256;

function verdictCacheKey(kind: PayloadKind, payload: string): string {
  return kind + "\u0000" + payload;
}

/** 清空判定缓存（测试/运维用；TTL=0 时缓存本身关闭） */
export function resetRiskVerdictCache(): void {
  verdictCache.clear();
}

function getCachedVerdict(kind: PayloadKind, payload: string): RiskVerdict | null {
  if (VERDICT_CACHE_TTL_MS === 0) return null;
  const key = verdictCacheKey(kind, payload);
  const entry = verdictCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    verdictCache.delete(key);
    return null;
  }
  return entry.verdict;
}

function cacheVerdict(kind: PayloadKind, payload: string, verdict: RiskVerdict): void {
  if (VERDICT_CACHE_TTL_MS === 0) return;
  if (verdictCache.size >= VERDICT_CACHE_MAX && !verdictCache.has(verdictCacheKey(kind, payload))) {
    const oldest = verdictCache.keys().next().value;
    if (oldest !== undefined) verdictCache.delete(oldest);
  }
  verdictCache.set(verdictCacheKey(kind, payload), {
    verdict,
    expiresAt: Date.now() + VERDICT_CACHE_TTL_MS,
  });
}

/** 一次工具调用的判定输入：能力 + 负载。名字与地址一律不参与判定。 */
export interface ToolCallView {
  readonly capabilities: readonly Capability[];
  readonly args: unknown;
  /** 仅用于审计标注 */
  readonly toolName?: string;
  /** 序列复核的主体键；缺省归入 unassigned 共桶（缺标注不等于免序列，见 R3-③） */
  readonly principal?: string;
  /** 注册处声明的"目标在哪个入参"（S-8）：命令类负载没有名字之外的认法 */
  readonly payloadFields?: PayloadFields;
}

/** 复核结果（null = 复核不可用） */
export interface ReviewResult {
  dangerous: boolean;
  reason?: string;
}

/**
 * 复核输出 schema（结构化输出收紧：dangerous 必须为布尔、reason 可选字符串；
 * 导出供测试复用）。校验失败 → reviewWithDecisionModel 返回 null →
 * 既有"复核不可用"回退语义不变（fail-closed/fail-open 按初筛等级由调用方处理）。
 */
export const riskReviewSchema = z.object({
  dangerous: z.boolean(),
  reason: z.string().optional(),
});

/** 初筛结论（degraded 可选：注入的替代适配器可不提供） */
export interface ScreenOutcome {
  risk: EdgeRisk;
  reason?: string;
  degraded?: boolean;
}

/** 可注入依赖（测试用 fake；生产为真实实现） */
export interface RiskMonitorDeps {
  screen?: (payload: string, kind: PayloadKind) => Promise<ScreenOutcome>;
  review?: (payload: string, kind: PayloadKind) => Promise<ReviewResult | null>;
}

// 能力 → 负载取法由 `permissions.ts` 的 CAPABILITY_PAYLOAD 单源提供（R1）：
// 判定层与复核层读同一份字段清单，新增字段只改一处。
// `internal` 不在表内（纯计算/状态查询不进入初筛）。`net.outbound` 同时在表里和
// `decideOutbound`（协议 + 宿主白名单）里，两者职责不同：白名单是**裁决**，本层只决定
// 要不要把人拉进来把关 —— 模型意见只能加严，不能放宽确定性结论。
// （main 的审计 P6 曾用工具名补齐 `browser_launch` 的 URL 负载，改名即失效，故改为按能力取。）

/**
 * 进入概率层初筛的能力集合（派生自单一数据源，不含 `fs.read`）。
 *
 * `fs.read` 在 `CAPABILITY_PAYLOAD` 里（判定层要用它取目标路径、序列层要用它记
 * L2 半链），但**不进初筛**：读负载只有一个路径字符串，越界与锚点已由
 * `decideFilesystem` 确定性裁决，剩下的灰区为空；每次读盘再问一遍小模型
 * （`EDGE_RISK_MONITOR` 默认关——需显式设 =1 并配置 GLM_FLASH 端点）只有延迟没有信号。`fs.glob` 不在豁免内 ——
 * 递归模式串无法逐条裁决（一条模式可命中整个 `.env` 家族），是枚举泄漏唯一的人可把关点。
 */
const NOT_SCREENED: ReadonlySet<Capability> = new Set<Capability>(["fs.read"]);

export const SCREENED_CAPABILITIES: ReadonlySet<Capability> = new Set(
  (Object.keys(PERMISSION_CAPABILITY_PAYLOAD) as Capability[]).filter(
    (c) => !NOT_SCREENED.has(c),
  ),
);

/**
 * 从工具参数中提取被复核负载。顺序：注册处声明的目标字段 → 常见字段名 → 值形态识别，
 * 一次调用只产出一条负载（content 之类的正文字段不参与，避免整份文件进提示词）。
 * 值形态这一步是 R2-D 加的：只认路径/URL 两种语法，所以把 `path` 改名成 `vault_path`
 * 仍能被人看的这一眼里拿到目标；命令类不猜（散文与命令行不可区分），靠声明。
 */
export function extractPayload(call: ToolCallView): { kind: PayloadKind; payload: string } | null {
  for (const capability of call.capabilities) {
    const picked = payloadForCapability(capability, call.args, call.payloadFields?.[capability]);
    if (picked) return picked;
    // 外部 MCP 工具的参数形状由远端决定，没有固定字段可认 —— 整体序列化后送筛，
    // 否则"包装工具零观测"会让 L5 重新出现。
    if (capability === "mcp.external") {
      const serialized = safeSerialize(call.args);
      if (serialized) return { kind: "command", payload: serialized };
    }
  }
  return null;
}

function safeSerialize(args: unknown): string | null {
  try {
    const s = JSON.stringify(args);
    return s && s !== "{}" ? s.slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * 概率层：对一次特权调用做双层风险初筛 + 复核。
 *
 * @returns "pass" 放行 | "require-approval" 升级强制人工审批（YOLO 也不豁免）
 */
export async function screenToolCall(
  call: ToolCallView,
  deps: RiskMonitorDeps = {},
): Promise<RiskVerdict> {
  // 能力集合决定要不要进概率层（不看名字、不看负载内容）：全为只读/内部时无事可筛
  if (!call.capabilities.some((c) => SCREENED_CAPABILITIES.has(c))) return "pass";
  const extracted = extractPayload(call);
  if (!extracted) return "pass";
  const { kind, payload } = extracted;
  const label = call.toolName ?? call.capabilities.join("+");
  // 注入任一适配器即视为测试路径：判定缓存不得影响 DI 断言
  const cacheEnabled = deps.screen === undefined && deps.review === undefined;

  // ── 判定缓存命中（P2-13）：approval 结论复放仍走 escalate 保审计链 ──
  const cached = cacheEnabled ? getCachedVerdict(kind, payload) : null;
  if (cached) {
    logger.debug("[RiskMonitor] verdict cache hit", { label, kind });
    if (cached === "require-approval") {
      escalate(label, kind, payload, "cached verdict: require-approval");
    }
    return cached;
  }

  // 注入的 screen 表示调用方显式提供了初筛适配器，不受生产开关影响（测试即走这条）
  // 概率层总开关：关掉只影响初筛/复核，不影响任何确定性强制
  const screen =
    deps.screen ?? (isEdgeEnabled("EDGE_RISK_MONITOR") ? screenPayloadWithEdge : null);
  if (!screen) {
    logger.debug("[RiskMonitor] probabilistic layer switched off; deterministic enforcement unaffected");
    return "pass";
  }
  const review = deps.review ?? reviewWithDecisionModel;

  // ── 第一层：边缘初筛 ──
  let edge: ScreenOutcome;
  try {
    edge = await screen(payload, kind);
  } catch (err) {
    // 初筛实现本身应自降级；此处兜底防 DI 实现抛异常
    logger.debug("[RiskMonitor] screen threw, fail-open", { error: (err as Error).message });
    degradedBypassCount++;
    auditLogger.log({
      event: "security.degraded_bypass",
      actor: "risk-monitor",
      resource: `${label}(${kind})`,
      outcome: "allowed",
      reason: `screen threw: ${(err as Error).message}`,
    });
    // 抛异常与 degraded 同源（"根本没测出来"），处置必须一致，否则换一个失败方式即可绕过
    const thrown = degradedPolicy(call.capabilities);
    if (thrown.mustApprove) {
      escalate(
        label,
        kind,
        payload,
        thrown.highRisk
          ? "screen unavailable; high-risk capability requires approval"
          : "screen unavailable (EDGE_RISK_FAIL_CLOSED=1)",
      );
      return "require-approval";
    }
    return "pass";
  }

  if (edge.risk === "low") {
    if ((edge as { degraded?: boolean }).degraded === true) {
      degradedBypassCount++;
      // 修复（审计 A 配套）：降级时不再对高危调用默认放行（R1：判据由工具名改为能力）
      const degraded = degradedPolicy(call.capabilities);
      logger.warn("[RiskMonitor] edge screening degraded", {
        label,
        capabilities: call.capabilities.join("+"),
        payload: payload.slice(0, 120),
        failClosed: isFailClosedEnabled(),
        highRiskCapability: degraded.highRisk,
        verdict: degraded.mustApprove ? "require-approval" : "pass",
      });
      auditLogger.log({
        event: "security.degraded_bypass",
        actor: "risk-monitor",
        resource: `${label}(${kind})`,
        outcome: degraded.mustApprove ? "denied" : "allowed",
        reason: "edge screening degraded",
      });
      if (degraded.mustApprove) {
        escalate(
          label,
          kind,
          payload,
          degraded.highRisk
            ? "edge degraded; high-risk capability requires approval"
            : "edge degraded (EDGE_RISK_FAIL_CLOSED=1)",
        );
        return "require-approval";
      }
    }
    // 干净 low 放行（非降级）为确定性结论，可缓存
    if (cacheEnabled && (edge as { degraded?: boolean }).degraded !== true) {
      cacheVerdict(kind, payload, "pass");
    }
    return "pass";
  }

  logger.warn(`[RiskMonitor] edge flagged ${edge.risk} risk: ${label}`, {
    payload: payload.slice(0, 120),
    reason: edge.reason,
  });

  // ── 第二层：主模型复核 ──
  let reviewResult: ReviewResult | null;
  try {
    reviewResult = await review(payload, kind);
  } catch (err) {
    logger.warn("[RiskMonitor] review threw, treating as unavailable", {
      error: (err as Error).message,
    });
    reviewResult = null;
  }

  if (reviewResult?.dangerous === true) {
    escalate(label, kind, payload, `edge=${edge.risk}, review=dangerous: ${reviewResult.reason ?? ""}`);
    if (cacheEnabled) cacheVerdict(kind, payload, "require-approval");
    return "require-approval";
  }

  if (reviewResult === null && edge.risk === "high") {
    // 复核不可用 + 初筛 high → fail-closed
    escalate(label, kind, payload, "edge=high, review=unavailable (fail-closed)");
    if (cacheEnabled) cacheVerdict(kind, payload, "require-approval");
    return "require-approval";
  }

  logger.info(`[RiskMonitor] cleared after review: ${label}`, {
    edgeRisk: edge.risk,
    review: reviewResult === null ? "unavailable" : "not-dangerous",
  });
  // 仅"复核真实发生且放行"为确定性结论；null(fail-open)依赖可用性，不缓存
  if (cacheEnabled && reviewResult !== null) {
    cacheVerdict(kind, payload, "pass");
  }
  return "pass";
}

// ─── 确定性层：跨调用序列复核（I4）─────────────────────────────────────────

/** 序列窗口（ms）：只回看这段时间内的调用 */
export const SEQUENCE_WINDOW_MS = 60_000;
/** 窗口内高影响能力调用条数上限：超出即认为正在批量推进特权操作 */
export const SEQUENCE_BURST_LIMIT = 8;

/** 除 internal 外的能力都可参与链路匹配（链路两端的"读"也是链路的一环） */
function isObservable(capability: Capability): boolean {
  return capability !== "internal";
}

/**
 * 高影响能力：会改变进程外状态或把数据送出进程。纯读不计入计数（读是常态，
 * 读的特权性由 safeFs 逐次裁决），但纯读仍参与下面的链路匹配。
 */
const HIGH_IMPACT: ReadonlySet<Capability> = new Set<Capability>([
  "proc.exec",
  "cfg.write",
  "db.write",
  "mcp.external",
  "net.outbound",
  "fs.write",
  "fs.delete",
]);

/**
 * 链路配对（方向敏感）：先前调用含 A 类、当前调用含 B 类即视为一次组合放大。
 * 依据 §3 矩阵：L2 读到即外发、L1 写可执行位再执行。
 */
const CHAIN_PAIRS: ReadonlyArray<{
  then: readonly Capability[];
  now: readonly Capability[];
  why: string;
}> = [
  {
    then: ["fs.read", "fs.glob"],
    now: ["net.outbound", "mcp.external"],
    why: "read-then-send (L2)",
  },
  {
    then: ["fs.write", "fs.delete", "cfg.write"],
    now: ["proc.exec"],
    why: "write-then-execute (L1)",
  },
];

interface SequenceEntry {
  readonly at: number;
  readonly capabilities: readonly Capability[];
}

/** 主体 → 近期特权调用。键只有主体，没有任何地址/回环维度。 */
const sequences = new Map<string, SequenceEntry[]>();

export interface SequenceOptions {
  /** 命中链路时回调（守卫据此走审批；审计已在内部落笔） */
  onEscalate?: (reason: string) => void;
  /** 可注入时钟（测试用） */
  now?: () => number;
  windowMs?: number;
  burstLimit?: number;
}

/**
 * 确定性层：跨调用序列复核（I4，封堵 L1/L2 的组合放大与 L8 的"单次都合规"论证）。
 *
 * 单次授权不等于链式授权：一次 fs.write 与一次 proc.exec 各自都能获批，
 * 连起来就是"写下可执行内容再执行它"。本函数只计数与配对，不调模型，
 * 因此无法被概率层开关关掉；升级后清空该主体窗口，避免逐条骚扰。
 */
export async function reviewSequence(
  call: ToolCallView,
  options: SequenceOptions = {},
): Promise<RiskVerdict> {
  const observed = call.capabilities.filter(isObservable);
  if (observed.length === 0) return "pass";

  const now = (options.now ?? Date.now)();
  const windowMs = options.windowMs ?? SEQUENCE_WINDOW_MS;
  const burstLimit = options.burstLimit ?? SEQUENCE_BURST_LIMIT;
  const principal = call.principal ?? UNATTRIBUTED_PRINCIPAL;

  const recent = (sequences.get(principal) ?? []).filter((e) => now - e.at < windowMs);
  const burst = observed.filter((c) => HIGH_IMPACT.has(c)).length;

  let reason: string | null = null;
  if (burst > 0) {
    const highImpactCount = recent.filter((e) => e.capabilities.some((c) => HIGH_IMPACT.has(c))).length;
    if (highImpactCount + 1 >= burstLimit) {
      reason = `${highImpactCount + 1} high-impact calls within ${windowMs}ms (burst limit ${burstLimit})`;
    }
  }
  if (!reason) {
    for (const pair of CHAIN_PAIRS) {
      const prior = recent.some((e) => e.capabilities.some((c) => pair.then.includes(c)));
      const current = observed.some((c) => pair.now.includes(c));
      if (prior && current) {
        reason = `chain ${pair.why}`;
        break;
      }
    }
  }

  recent.push({ at: now, capabilities: observed });
  sequences.set(principal, recent);

  if (!reason) return "pass";

  sequences.set(principal, []);
  escalate(
    call.toolName ?? observed.join("+"),
    observed.includes("proc.exec") ? "command" : "path",
    `${principal} → [${observed.join(", ")}]`,
    reason,
  );
  options.onEscalate?.(reason);
  return "require-approval";
}

/** 仅供测试与长会话清理：清空序列状态 */
export function resetSequences(): void {
  sequences.clear();
}

/** 升级记录：审计日志 + warn */
function escalate(label: string, kind: PayloadKind, payload: string, detail: string): void {
  logger.warn(`[RiskMonitor] ESCALATED ${label}: ${detail}`, { payload: payload.slice(0, 120) });
  auditLogger.log({
    event: "security.alert",
    actor: "risk-monitor",
    resource: `${label}(${kind})`,
    outcome: "denied",
    reason: detail,
    metadata: { payload: payload.slice(0, 500) },
  });
}

/**
 * 主模型复核（生产实现）：经 router decision 角色。
 * 返回 null 表示复核不可用（无模型/网络失败/输出非法）。
 */
async function reviewWithDecisionModel(
  payload: string,
  kind: PayloadKind,
): Promise<ReviewResult | null> {
  try {
    const { router } = await import("../router/model-router.js");
    const label = kind === "command" ? "shell 命令" : kind === "url" ? "浏览器打开的 URL" : "文件路径操作";
    const resp = await router.execute({
      role: "decision",
      messages: [
        {
          role: "user",
          content: `审查以下${label}是否会导致不可逆破坏、数据丢失或安全风险：${payload.slice(0, 500)}。只回答 JSON {"dangerous": true/false, "reason": "<=30字"}`,
        },
      ],
    });
    const parsed = extractJson(resp?.content ?? "");
    if (!parsed) return null;
    const review = riskReviewSchema.safeParse(parsed);
    if (!review.success) return null;
    return { dangerous: review.data.dangerous, reason: review.data.reason };
  } catch (err) {
    logger.warn("[RiskMonitor] decision-model review failed", {
      error: (err as Error).message,
    });
    return null;
  }
}
