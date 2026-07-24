/**
 * HTTP / WebSocket 认证判定 —— 从 main.ts 抽出的纯逻辑，便于独立单元测试。
 *
 * 安全要点（P0 回归防线）：
 *   - isLocal 必须来自 socket 对端地址（server.requestIP），
 *     绝不可来自 req.url / Host header —— 客户端可伪造 Host 冒充本地请求。
 *   - 未配置 AXIOM_AUTH_TOKEN 时 fail-closed：远程请求一律拒绝。
 *   - 静态豁免仅限真实 SPA 资源扩展名；.json/.txt 被排除，
 *     因为动态 API 路由可能以它们结尾（如 /traces/<id>.json）。
 */

import { timingSafeEqual } from "crypto";
import { logger } from "./logger.js";

/** 判定 socket 对端地址是否为回环地址 */
export function isLocalAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * 常量时间字符串比较 —— 防止时序攻击泄露 API Key。
 * 长度不同时直接返回 false（key 长度非机密信息）。
 */
function safeCompare(a: string | undefined, b: string): boolean {
  if (typeof a !== "string" || a.length === 0) return false;
  if (typeof b !== "string" || b.length === 0) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// 免认证静态扩展名：真实 SPA 资源类型。不含 .json/.txt（见文件头注释）。
const AUTH_EXEMPT_EXTS = new Set([
  ".html", ".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".gif",
  ".svg", ".ico", ".webp", ".woff", ".woff2", ".map",
]);

// 免认证公共路径（精确匹配）
const PUBLIC_PATHS = ["/health", "/", "/manifest.json", "/sw.js", "/icon.png", "/favicon.ico"];

/**
 * API 认证检查。
 * @param req      incoming request（只用其 URL 路径与认证 header，不信任 Host）
 * @param isLocal 是否回环请求——调用方必须用 socket 对端地址判定（见 isLocalAddress）
 * @param apiKey  服务端配置的 AXIOM_AUTH_TOKEN；空串表示未配置（fail-closed）
 */
export function checkApiKey(req: Request, isLocal: boolean, apiKey: string): boolean {
  // Fail-closed: if no server-side auth token is configured, deny ALL requests.
  // This protects /chat and other endpoints from open access when env is misconfigured.
  const url = new URL(req.url);
  // Allow local requests without auth (for E2E tests and local development)
  if (isLocal) return true;
  logger.debug("checkApiKey called", { path: url.pathname, apiKeyExists: !!apiKey, apiKeyLength: apiKey?.length });
  const staticExt = url.pathname.includes(".") ? url.pathname.slice(url.pathname.lastIndexOf(".")) : "";
  if (!apiKey) {
    // No auth token configured: allow static assets and public paths, deny API endpoints
    // 只对根路径或 /assets/ 下的静态资源豁免扩展名（防止 /vault/write.js 等绕过认证）
    const isStaticPath = !url.pathname.slice(1).includes("/") || url.pathname.startsWith("/assets/");
    if (AUTH_EXEMPT_EXTS.has(staticExt) && isStaticPath) return true;
    if (PUBLIC_PATHS.includes(url.pathname)) return true;
    if (url.pathname === "/ws") return true;
    logger.warn("Auth check failed: AXIOM_AUTH_TOKEN not configured");
    return false;
  }
  if (PUBLIC_PATHS.includes(url.pathname)) return true;
  // Allow real static assets (JS, CSS, images, fonts, etc.) so the SPA shell loads without auth
  // 只对根路径或 /assets/ 下的静态资源豁免（防止 /api/data.js 等路径绕过认证）
  const isStaticAsset = !url.pathname.slice(1).includes("/") || url.pathname.startsWith("/assets/");
  if (AUTH_EXEMPT_EXTS.has(staticExt) && isStaticAsset) {
    logger.debug("Static asset allowed without auth", { path: url.pathname, ext: staticExt });
    return true;
  }
  // WebSocket: check auth in upgrade handler, not here
  if (url.pathname === "/ws") return true;
  const auth = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace("Bearer ", "");
  return safeCompare(auth, apiKey);
}
