/**
 * HTTP 请求面加固纯函数（Step 3）。
 *
 * 抽出为独立模块的原因：main.ts 是顶层入口（import 即启动服务），
 * 纯函数单独落点才能被测试直接驱动（AGENTS 规则 8：接口即测试面）。
 *
 * 覆盖：
 *   - parseContentLength / validateRequestBodySize：缺头/非法/超限的确定裁决；
 *   - normalizeMetricPath：metrics label 的路径归一，防高基数无界增长；
 *   - mergeErrorHeaders：500 错误响应保留 rate-limit 头并带上 baseHeaders（CORS）。
 */

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const NUMERIC_RE = /^\d+$/;

/** 解析 Content-Length：只有非负安全整数有效；缺头/非法一律 null。 */
export function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export interface BodySizeDecision {
  ok: boolean;
  status?: 411 | 413;
  message?: string;
}

/**
 * 写方法（POST/PUT/PATCH）的请求体大小裁决：
 *   - 缺 Content-Length 或值非法 → 411（不能把缺失当 0 放行，chunked 会绕过上限）；
 *   - Content-Length > maxBytes        → 413；
 *   - 其余（含非写方法）              → 放行。
 */
export function validateRequestBodySize(
  method: string,
  rawContentLength: string | null,
  maxBytes: number,
): BodySizeDecision {
  if (!WRITE_METHODS.has(method.toUpperCase())) return { ok: true };
  const length = parseContentLength(rawContentLength);
  if (length === null) {
    return { ok: false, status: 411, message: "Content-Length header is required" };
  }
  if (length > maxBytes) {
    return { ok: false, status: 413, message: `Request body too large (max ${maxBytes} bytes)` };
  }
  return { ok: true };
}

/**
 * metrics label 的路径归一：
 *   - UUID、纯数字段、长 hex 段 → :id；
 *   - 其他段原样保留。
 * 目的：防止 /api/resource/<uuid> 这类高基数路径把指标 Map 撑爆。
 */
export function normalizeMetricPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      if (UUID_RE.test(segment) || NUMERIC_RE.test(segment) || LONG_HEX_RE.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/**
 * 500 错误响应的头部合并：保留 rate-limit 头，并带上 baseHeaders
 * （securityHeaders + 按 Origin 计算的 CORS）。baseHeaders 后者优先。
 */
export function mergeErrorHeaders(
  rateLimitHeaders: Record<string, string>,
  baseHeaders: Record<string, string>,
): Record<string, string> {
  return { ...rateLimitHeaders, ...baseHeaders };
}
