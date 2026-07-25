/**
 * 子进程环境变量过滤（2026-07-26 安全修复，terminal.ts 抽出的共享实现）：
 * 剥离密钥类变量（*_KEY / *_TOKEN / *_SECRET / *PASSWORD* / *CREDENTIAL*），
 * 防止 spawn 出去的任意命令用 `env`/`set` 读取 provider API key。
 * 调用方显式传入的 extra 视为有意为之，不过滤。
 */
export function sanitizeSpawnEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string> {
  const SENSITIVE_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)(_|$)/i;
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SENSITIVE_RE.test(k)) continue;
    filtered[k] = v;
  }
  return { ...filtered, ...(extra ?? {}) };
}

/**
 * shell 参数引用（防 args 注入，R3 修复）：
 * POSIX sh 用单引号（内嵌单引号转义为 '\''）；
 * Windows cmd 用双引号（内嵌双引号转义为 ""）。
 */
export function shellQuoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
