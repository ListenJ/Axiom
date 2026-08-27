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

import { promises as dnsPromises } from "dns";

const BLOCKED_PROTOCOLS = ["file:", "ftp:", "gopher:", "dict:"];
const BLOCKED_HOSTS = [
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1",
  "169.254.169.254", "metadata.google.internal",
];

function isPrivateIPv4(host: string): boolean {
  if (/^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^0\./.test(host)) return true;
  return false;
}

function integerToIPv4(numStr: string): string | null {
  try {
    // 支持十进制、八进制(0前缀)、十六进制(0x) 的整数形式
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(numStr)) n = parseInt(numStr, 16);
    else if (/^0[0-7]+$/.test(numStr) && numStr !== "0") n = parseInt(numStr, 8);
    else if (/^\d+$/.test(numStr)) n = parseInt(numStr, 10);
    else return null;
    if (Number.isNaN(n) || n < 0 || n > 0xffffffff) return null;
    return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  } catch {
    return null;
  }
}

export function isSafeUrl(urlStr: string): boolean {
  try {
    // 预检整数/八进制/十六进制 IP（在 URL 解析前，避免某些环境不规范化）
    try {
      const m = urlStr.match(/^https?:\/\/([^\/?#:]+)(?::\d+)?(?:\/|$)/i);
      if (m) {
        const rawHost = m[1].toLowerCase();
        // 纯整数形式如 http://2130706433/
        const intIp = integerToIPv4(rawHost);
        if (intIp && isPrivateIPv4(intIp)) return false;
        // 混合点分但含八/十六进制段如 0x7f.0.0.1、0177.0.0.1
        if (/^(?:0x[0-9a-f]+\.?|0[0-7]+\.?|\d+\.?)+$/i.test(rawHost) && rawHost.includes(".")) {
          const parts = rawHost.split(".");
          let normalized = "";
          for (const p of parts) {
            if (/^0x/i.test(p)) normalized += parseInt(p, 16) + ".";
            else if (/^0[0-7]+$/.test(p) && p !== "0") normalized += parseInt(p, 8) + ".";
            else if (/^\d+$/.test(p)) normalized += parseInt(p, 10) + ".";
            else { normalized = ""; break; }
          }
          if (normalized) {
            normalized = normalized.slice(0, -1);
            if (isPrivateIPv4(normalized)) return false;
            // 规范化后若为 127/10 等也已拦截
            // 若仍为私有段，直接拦截
            if (/^10\./.test(normalized) || /^192\.168\./.test(normalized)) return false;
          }
        }
      }
    } catch {}

    const parsed = new URL(urlStr);
    if (BLOCKED_PROTOCOLS.some((p) => parsed.protocol === p)) return false;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h))) return false;
    // IPv4 私网/环回/链路本地（含 127/8、0/8）
    if (isPrivateIPv4(hostname)) return false;
    // 兼容 Node 已规范化的整数 IP：若原始 host 为整数但 parsed 已转为点分，isPrivateIPv4 已覆盖
    // 额外显式检查整数形式的 hostname（防御某些 URL 实现不规范化）
    const intFromHost = integerToIPv4(hostname);
    if (intFromHost && isPrivateIPv4(intFromHost)) return false;

    // IPv6
    const v6 = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (v6.includes(":")) {
      // loopback
      if (v6 === "::1") return false;
      // ULA(fc00::/7 → fc/fd 前缀) / link-local(fe80::/10 → fe8-fe9-fea-feb 前缀)
      if (/^f[cd]/i.test(v6)) return false;
      if (/^fe[89ab]/i.test(v6)) return false;
      // IPv4-mapped 地址 ::ffff:x.x.x.x 或 ::ffff:hex
      if (v6.includes("::ffff:")) {
        const after = v6.split("::ffff:")[1] || "";
        if (after) {
          if (after.includes(".")) {
            if (isPrivateIPv4(after)) return false;
            // 任何 ::ffff: 的点分私网都拦截，否则保守拦截所有映射（SSRF 面向私网）
            return false;
          } else {
            // hex 形式如 ::ffff:7f00:1 -> 127.0.0.1
            const hexParts = after.split(":");
            let ip = "";
            if (hexParts.length === 2) {
              const h1 = hexParts[0].padStart(4, "0");
              const h2 = hexParts[1].padStart(4, "0");
              const b1 = parseInt(h1.slice(0, 2), 16);
              const b2 = parseInt(h1.slice(2), 16);
              const b3 = parseInt(h2.slice(0, 2), 16);
              const b4 = parseInt(h2.slice(2), 16);
              if ([b1, b2, b3, b4].every((n) => !Number.isNaN(n))) ip = `${b1}.${b2}.${b3}.${b4}`;
            }
            if (ip && isPrivateIPv4(ip)) return false;
            // 保守：任何 ::ffff: 映射均视为可疑，拦截
            return false;
          }
        }
        return false;
      }
      // 0:0:0:0:0:ffff:127.0.0.1 规范化为 ::ffff:7f00:1，已在上分支处理；兜底拦截含 ffff 的 v6
      if (v6.includes("ffff")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** M7 审计修复：未提供 cdpUrl 时的默认回环端点 */
export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * M7 审计修复：CDP 端点守卫。
 * CDP 本质是本机/内网调试服务 —— 默认仅放行回环地址，远程端点必须显式
 * { allowRemote: true }（调用方接 AXIOM_ALLOW_REMOTE_CDP=1），阻断客户端可控
 * cdpUrl 对任意内网地址的探测面。返回规范化 URL 字符串。
 */
export function assertSafeCdpUrl(raw: unknown, opts?: { allowRemote?: boolean }): string {
  const rawStr = typeof raw === "string" ? raw.trim() : "";
  if (!rawStr) return DEFAULT_CDP_URL;
  let parsed: URL;
  try {
    parsed = new URL(rawStr);
  } catch {
    throw new Error(`invalid cdpUrl: ${rawStr}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`cdpUrl protocol not allowed: ${parsed.protocol}`);
  }
  if (!isLoopbackHost(parsed.hostname) && opts?.allowRemote !== true) {
    throw new Error(`remote cdpUrl blocked (set AXIOM_ALLOW_REMOTE_CDP=1 to allow): ${parsed.hostname}`);
  }
  return parsed.href;
}

/** L13：解析后二次校验（缓解 DNS-rebinding 到私网）；解析失败不拦截，交由连接层报错。
 *  TOCTOU 残窗（校验后连接前再变）为已知局限，在 LIMITATIONS 披露。 */
export async function assertResolvedHostSafe(
  hostname: string,
  resolve: (h: string) => Promise<string[]> = async (h) =>
    (await dnsPromises.lookup(h, { all: true })).map((a) => a.address),
): Promise<void> {
  try {
    const addrs = await resolve(hostname);
    for (const ip of addrs) {
      if (ip.includes(".") && isPrivateIPv4(ip)) {
        throw new Error(`resolved private address blocked: ${hostname} -> ${ip}`);
      }
      const bare = ip.replace(/^\[|\]$/g, "").toLowerCase();
      if (
        bare.includes(":") &&
        (bare === "::1" || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare))
      ) {
        throw new Error(`resolved private ipv6 blocked: ${hostname} -> ${ip}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("blocked")) throw err;
    // ENOTFOUND 等解析异常不在此拦截
  }
}
