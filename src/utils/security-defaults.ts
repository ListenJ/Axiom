/**
 * 安全开关默认值 —— 单一来源（S3 / S-6，封堵 L6 回环豁免、L8 审批关闭）。
 *
 * 口径：豁免与审批类开关「未配置」不等于「关闭」。开/关由显式取值决定，
 * 未配置时一律按安全侧解释（fail-closed），使"忘记设置"不构成提权入口。
 *
 * 本模块是运行时的判定依据；config/security-defaults.json 是对外的声明契约，
 * 两者的一致性由 tests/capability-invariants.test.ts 的 S-6 锁死，防止漂移。
 */

/** 回环地址免鉴权开关（默认关闭，需显式 =1 才开） */
export const LOCAL_BYPASS_ENV = "AXIOM_ALLOW_LOCAL_BYPASS";

/** PTY 交互终端审批模式开关（off|risky|strict） */
export const PTY_APPROVAL_MODE_ENV = "AXIOM_PTY_APPROVAL_MODE";

/** PTY 审批的安全侧默认：未配置时不是 off，而是 risky */
export const PTY_APPROVAL_DEFAULT_MODE = "risky" as const;

/**
 * 已登记开关的安全侧默认值（键为环境变量名）。
 *
 * 不变式（由 S-6 门禁锁死）：本表每项 == config/security-defaults.json 的
 * `secureDefault`，且 == 代码实际行为。即"登记在此 = 默认即安全侧"。
 */
export const SECURITY_DEFAULTS: Readonly<Record<string, string | boolean>> = {
  [LOCAL_BYPASS_ENV]: false,
  [PTY_APPROVAL_MODE_ENV]: PTY_APPROVAL_DEFAULT_MODE,
};

/**
 * 已知 fail-open 缺口登记表（2026-10-14 全仓审核发现 2）。
 *
 * 这些开关**当前实际默认值是 fail-open**（未配置 = 放行），与本仓库
 * "审批/豁免类开关未配置一律按安全侧解释"的声明口径不符。此前它们既不在
 * SECURITY_DEFAULTS、也无任何门禁可见，属静默缺口。
 *
 * 处置边界：本表只让缺口**可见且受门禁约束**；收紧默认值会影响既有部署，属需要显式决策的变更
 * （2026-10-22 P1.4 已按 D1=C 把 AXIOM_SECOND_FACTOR_TOKEN 的**写路径**收紧为 fail-closed，
 * 只读终端视图仍 fail-open，故该项继续留在 gaps —— 缺口只剩只读侧）。新增 fail-open 安全开关
 * 必须登记于此，否则 capability-invariants 的 S-6 完备性断言会红。
 */
export const SECURITY_GAPS: Readonly<Record<string, string>> = {
  AXIOM_ENFORCE_MODE_APPROVAL:
    "默认 0 → agent 模式下 caution/destructive 工具不触发审批（src/mcp/tool-registry.ts:58 短路）",
  AXIOM_SECOND_FACTOR_TOKEN:
    "未配置 → 写路由（git commit/push、/config POST、/permissions/mode POST、终端创建/输入/关闭）已 fail-closed 403（code=second-factor-unconfigured，P1.4）；只读终端视图（stream/会话列表）仍放行并 warn once —— 只读侧仍是 fail-open 缺口",
  EDGE_RISK_FAIL_CLOSED:
    "默认 0 → 风险初筛不可用时不升级为强制审批（src/agents/risk-monitor.ts:62）",
  AXIOM_ALLOW_REMOTE_CDP:
    "默认 0 → 拒绝远程 CDP（此项默认即安全侧，登记以纳入完备性门禁）",
};

/**
 * 回环免鉴权是否开启：只有显式 1/true/yes 才开。
 * 未配置、空值、无法识别的写法一律关闭 —— 与 readBool(…, true) 的旧行为相反。
 */
export function localBypassEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env[LOCAL_BYPASS_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 只监听本机的绑定值 */
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * 回环豁免 + 非回环绑定 ⇒ 同主机反向代理转来的远程流量在 socket 层呈现为
 * 127.0.0.1，会被豁免规则整片放行。返回告警文案即调用方必须留痕（L8）；
 * null 表示该组合不存在。
 */
export function bypassExposureWarning(enabled: boolean, bindHost: string): string | null {
  if (!enabled || LOOPBACK_BINDS.has(bindHost.trim().toLowerCase())) return null;
  return `${LOCAL_BYPASS_ENV}=1 且绑定 ${bindHost}（非回环）：同主机反向代理转发的远程流量在 socket 层呈现为 127.0.0.1，将整体绕过鉴权`;
}
