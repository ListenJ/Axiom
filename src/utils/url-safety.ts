/**
 * URL 安全检查（SSRF 防护）—— 共享实现
 *
 * 此前 routes/search.ts 私有实现仅校验初始 URL，且 MCP web_fetch 完全没有校验。
 * 2026-07-26 安全修复：抽出共享，供路由层与 proxyFetch 重定向逐跳校验使用。
 *
 * 拦截：
 *   - 非 http/https 协议（file:/ftp:/gopher:/dict: 等）
 *   - loopback / 0.0.0.0 / link-local / 云元数据端点
 *   - RFC1918 私网（10/8、172.16/12、192.168/16）
 *   - IPv6 loopback(::1) / ULA(fc00::/7) / link-local(fe80::/10)
 */

const BLOCKED_PROTOCOLS = ["file:", "ftp:", "gopher:", "dict:"];
const BLOCKED_HOSTS = [
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1",
  "169.254.169.254", "metadata.google.internal",
];

export function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (BLOCKED_PROTOCOLS.some((p) => parsed.protocol === p)) return false;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h))) return false;
    // IPv4 私网/链路本地
    if (/^10\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^169\.254\./.test(hostname)) return false;
    // IPv6 ULA(fc00::/7 → fc/fd 前缀) / link-local(fe80::/10 → fe8-fe9-fea-feb 前缀)
    const v6 = hostname.replace(/^\[|\]$/g, "");
    if (/^f[cd]/i.test(v6)) return false;
    if (/^fe[89ab]/i.test(v6)) return false;
    return true;
  } catch {
    return false;
  }
}
