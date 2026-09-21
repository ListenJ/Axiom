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

/** 已登记开关的安全侧默认值（键为环境变量名） */
export const SECURITY_DEFAULTS: Readonly<Record<string, string | boolean>> = {
  [LOCAL_BYPASS_ENV]: false,
  [PTY_APPROVAL_MODE_ENV]: PTY_APPROVAL_DEFAULT_MODE,
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
