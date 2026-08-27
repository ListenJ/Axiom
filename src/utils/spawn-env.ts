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
 * Windows cmd 用 caret 转义元字符与分隔符（^ 自身优先转义）。
 * 实测（Bun.spawn + cmd /c）：双引号会被 cmd 保留为字面量，caret 是唯一可靠方案。
 */
export function shellQuoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // ^ 必须最先转义；随后追加 \n/\r/`/$/()/ 转义（2026-08-27 Task5 Low 缺口闭合），最后是 cmd 元字符与参数分隔符
    return arg
      .replace(/\^/g, "^^")
      .replace(/\r/g, "^\r")
      .replace(/\n/g, "^\n")
      .replace(/`/g, "^`")
      .replace(/\$/g, "^$")
      .replace(/\(/g, "^(")
      .replace(/\)/g, "^)")
      .replace(/([&|<>%!" \t,;=%])/g, "^$1");
  }
  // POSIX: 拒绝换行（2026-08-27 Task5，sh 单引号不可包裹裸换行）
  if (/[\n\r]/.test(arg)) throw new Error("argument contains newline");
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
