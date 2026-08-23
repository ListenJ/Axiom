/**
 * Proxy-Aware Fetch Utility — 兼容 Bun + Windows TLS 的网络请求层
 *
 * 解决问题:
 *   Bun 1.x 的内置 fetch() 在 Windows 上存在 TLS 证书验证问题，
 *   导致无法访问部分 HTTPS 端点（如 OpenRouter）。
 *   本模块使用 node:https / node:http 模块（基于系统证书库）作为替代，
 *   同时支持 HTTP 代理 (CONNECT tunnel) 和 NO_PROXY 绕过规则。
 *
 * 代理检测优先级:
 *   1. 环境变量: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (大小写不敏感)
 *   2. .env 文件中的 PROXY_URL
 *   3. Windows 注册表: HKCU\...\Internet Settings\ProxyServer
 *
 * 用法:
 *   import { proxyFetch } from "../utils/proxy-fetch.js";
 *   const res = await proxyFetch("https://openrouter.ai/api/v1/models", {
 *     headers: { Authorization: "Bearer ..." },
 *     signal: AbortSignal.timeout(15000),
 *   });
 *   const data = await res.json();
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import { logger } from "./logger.js";
import { isSafeUrl, assertResolvedHostSafe } from "./url-safety.js";

// ========== 类型定义 ==========

export interface ProxyFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  signal?: AbortSignal;
  timeout?: number;
  /** 是否拒绝自签名证书（默认 true，生产环境应保持 true） */
  rejectUnauthorized?: boolean;
  /** 强制使用指定代理（覆盖自动检测） */
  proxy?: string | null;
  /** 是否跟随重定向（默认 true，最多 5 次） */
  followRedirects?: boolean;
  /** 最大重定向次数 */
  maxRedirects?: number;
  /** SSRF 防护：为 true 时校验初始 URL 与每个重定向跳（拒绝内网/环回/元数据地址） */
  ssrfGuard?: boolean;
}

export interface ProxyFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  text(): Promise<string>;
  json(): Promise<any>;
  buffer(): Promise<Buffer>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

// ========== 连接池 (性能优化) ==========

// 最大缓存的 agent 数量，超过后按 LRU 淘汰最久未使用的 agent
const MAX_AGENT_CACHE_SIZE = 32;
// key → { agent, lastUsedAt }
interface CachedAgent {
  agent: http.Agent | https.Agent;
  lastUsedAt: number;
}
const agentCache = new Map<string, CachedAgent>();

/**
 * LRU 淘汰：当缓存超过 MAX_AGENT_CACHE_SIZE 时销毁最久未使用的 agent
 */
function evictOldestAgent(): void {
  if (agentCache.size <= MAX_AGENT_CACHE_SIZE) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of agentCache) {
    if (entry.lastUsedAt < oldestTime) {
      oldestTime = entry.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const entry = agentCache.get(oldestKey);
    if (entry) {
      try {
        entry.agent.destroy();
      } catch {
        // 忽略关闭错误
      }
    }
    agentCache.delete(oldestKey);
  }
}

function getAgent(protocol: string, proxy?: ProxyConfig | null): http.Agent | https.Agent {
  const key = `${protocol}::${proxy ? `${proxy.host}:${proxy.port}` : "direct"}`;
  const existing = agentCache.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.agent;
  }

  evictOldestAgent();

  const isHttps = protocol === "https:";
  const Agent = isHttps ? https.Agent : http.Agent;
  const agent = new Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000,
  });
  agentCache.set(key, { agent, lastUsedAt: Date.now() });
  return agent;
}

// ========== 代理检测 ==========

interface ProxyConfig {
  host: string;
  port: number;
  protocol: string; // "http:" | "https:" | "socks5:"
  auth?: string;    // "user:pass"
  noProxy: string[];
}

let cachedProxyConfig: ProxyConfig | null | undefined = undefined; // undefined = not yet checked
// Windows 注册表结果缓存（避免重复 spawnSync）
let cachedWindowsProxy: { value: { proxy: string; bypass: string } | null; expiresAt: number } | null = null;
const WINDOWS_PROXY_CACHE_TTL_MS = 60_000; // 1 分钟

/**
 * 从 Windows 注册表读取系统代理设置
 * 结果会被缓存，避免每次请求都执行 spawnSync
 */
async function getWindowsSystemProxy(): Promise<{ proxy: string; bypass: string } | null> {
  if (process.platform !== "win32") return null;

  // 检查缓存
  const now = Date.now();
  if (cachedWindowsProxy && cachedWindowsProxy.expiresAt > now) {
    return cachedWindowsProxy.value;
  }

  try {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyEnable",
    ], { encoding: "utf-8", timeout: 3000 });

    if (result.status !== 0) {
      cachedWindowsProxy = { value: null, expiresAt: now + WINDOWS_PROXY_CACHE_TTL_MS };
      return null;
    }
    const enabled = result.stdout.includes("0x1");
    if (!enabled) {
      cachedWindowsProxy = { value: null, expiresAt: now + WINDOWS_PROXY_CACHE_TTL_MS };
      return null;
    }

    const serverResult = spawnSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyServer",
    ], { encoding: "utf-8", timeout: 3000 });

    const bypassResult = spawnSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyOverride",
    ], { encoding: "utf-8", timeout: 3000 });

    let proxy = "";
    let bypass = "";

    if (serverResult.status === 0) {
      const match = serverResult.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (match) proxy = match[1].trim();
    }

    if (bypassResult.status === 0) {
      const match = bypassResult.stdout.match(/ProxyOverride\s+REG_SZ\s+(.+)/i);
      if (match) bypass = match[1].trim();
    }

    const value = proxy ? { proxy, bypass } : null;
    cachedWindowsProxy = { value, expiresAt: now + WINDOWS_PROXY_CACHE_TTL_MS };
    return value;
  } catch {
    cachedWindowsProxy = { value: null, expiresAt: now + WINDOWS_PROXY_CACHE_TTL_MS };
    return null;
  }
}

/**
 * 解析代理字符串为 ProxyConfig
 */
function parseProxyString(proxyStr: string, noProxyStr: string = ""): ProxyConfig | null {
  if (!proxyStr) return null;

  try {
    // 处理不带协议的代理地址 (如 "127.0.0.1:7897")
    let url: URL;
    if (!proxyStr.includes("://")) {
      url = new URL(`http://${proxyStr}`);
    } else {
      url = new URL(proxyStr);
    }

    const noProxy = noProxyStr
      .split(/[;,]/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    return {
      host: url.hostname,
      port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 8080),
      protocol: url.protocol,
      auth: url.username ? `${url.username}:${url.password}` : undefined,
      noProxy,
    };
  } catch {
    logger.warn("[ProxyFetch] Failed to parse proxy string", { proxy: proxyStr });
    return null;
  }
}

/**
 * 检查目标主机是否应该绕过代理
 */
function shouldBypassProxy(hostname: string, noProxy: string[]): boolean {
  if (noProxy.length === 0) return false;

  const host = hostname.toLowerCase();
  for (const rule of noProxy) {
    if (rule === "*") return true;
    if (rule === "<local>" && !host.includes(".")) return true;
    if (host === rule) return true;
    if (host.endsWith("." + rule) || host.endsWith(rule)) return true;
  }
  return false;
}

/**
 * 获取当前有效的代理配置
 * 优先级: 自适应代理管理器 > 环境变量 > Windows 注册表
 */
export async function getProxyConfig(): Promise<ProxyConfig | null> {
  // 尝试自适应代理管理器 (如果已初始化)
  try {
    const { getAdaptiveProxy } = await import("./adaptive-proxy.js");
    const adaptiveProxy = await getAdaptiveProxy();
    if (adaptiveProxy) {
      return {
        host: adaptiveProxy.host,
        port: adaptiveProxy.port,
        protocol: adaptiveProxy.protocol === "socks5" ? "socks5:" : "http:",
        auth: adaptiveProxy.auth,
        noProxy: [],
      };
    }
  } catch {
    // 自适应代理模块不可用，降级到传统检测
  }

  if (cachedProxyConfig !== undefined) return cachedProxyConfig;

  // 1. 环境变量优先
  const envProxy = process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || process.env.PROXY_URL
    || "";

  const envNoProxy = process.env.NO_PROXY
    || process.env.no_proxy
    || "";

  if (envProxy) {
    cachedProxyConfig = parseProxyString(envProxy, envNoProxy);
    if (cachedProxyConfig) {
      logger.info("[ProxyFetch] Using proxy from environment", {
        host: cachedProxyConfig.host,
        port: cachedProxyConfig.port,
      });
      return cachedProxyConfig;
    }
  }

  // 2. Windows 注册表
  const winProxy = await getWindowsSystemProxy();
  if (winProxy?.proxy) {
    cachedProxyConfig = parseProxyString(winProxy.proxy, winProxy.bypass);
    if (cachedProxyConfig) {
      logger.info("[ProxyFetch] Using proxy from Windows registry", {
        host: cachedProxyConfig.host,
        port: cachedProxyConfig.port,
      });
      return cachedProxyConfig;
    }
  }

  cachedProxyConfig = null;
  logger.debug("[ProxyFetch] No proxy configured");
  return null;
}

// ========== CONNECT 隧道 ==========

function createConnectTunnel(
  targetHost: string,
  targetPort: number,
  proxy: ProxyConfig,
  timeout: number,
  signal?: AbortSignal,
): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(proxy.port, proxy.host);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("CONNECT tunnel timeout"));
      }
    }, timeout);

    if (signal) {
      signal.addEventListener("abort", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new Error("Request aborted"));
        }
      }, { once: true });
    }

    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    let buffer = "";
    socket.on("connect", () => {
      // Build CONNECT request manually (avoids Bun's http.request URL parsing issues)
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
      ];
      if (proxy.auth) {
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString("base64")}`);
      }
      lines.push("", "");
      socket.write(lines.join("\r\n"));
    });

    socket.on("data", function onData(chunk) {
      buffer += chunk.toString();
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      socket.removeListener("data", onData);
      const statusLine = buffer.split("\r\n")[0];
      const statusCode = parseInt(statusLine.split(" ")[1]);

      if (statusCode !== 200) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`CONNECT failed: ${statusLine}`));
        }
        return;
      }

      // Tunnel established — return the raw socket for TLS upgrade
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      }
    });
  });
}

// ========== 核心请求函数 ==========

async function makeRequest(
  url: URL,
  opts: ProxyFetchOptions,
  redirectCount: number = 0,
): Promise<ProxyFetchResponse> {
  // SSRF 防护：初始 URL 与每个重定向跳都过校验（makeRequest 递归即逐跳）
  if (opts.ssrfGuard && !isSafeUrl(url.href)) {
    return Promise.reject(new Error(`URL blocked by SSRF guard: ${url.hostname}`));
  }
  // L13：DNS 解析后二次校验（rebinding 缓解；TOCTOU 残窗已在 LIMITATIONS 披露）
  if (opts.ssrfGuard) {
    await assertResolvedHostSafe(url.hostname);
  }

  const isHttps = url.protocol === "https:";
  const proxy = opts.proxy !== undefined
    ? (opts.proxy ? parseProxyString(opts.proxy) : null)
    : await getProxyConfig();

  const effectiveProxy = proxy && !shouldBypassProxy(url.hostname, proxy.noProxy)
    ? proxy
    : null;

  const timeout = opts.timeout || (opts.signal ? undefined : 30000);
  const maxRedirects = opts.maxRedirects ?? 5;

  return new Promise<ProxyFetchResponse>((resolve, reject) => {
    const method = (opts.method || "GET").toUpperCase();
    const headers: Record<string, string> = { ...opts.headers };

    // 确保 Host 头
    if (!headers.Host && !headers.host) {
      headers.Host = url.host;
    }

    let req: http.ClientRequest;

    if (effectiveProxy && isHttps) {
      // HTTPS through proxy: CONNECT tunnel + manual TLS upgrade
      const tunnelPromise = createConnectTunnel(
        url.hostname,
        parseInt(url.port) || 443,
        effectiveProxy,
        timeout || 30000,
        opts.signal,
      );

      tunnelPromise.then((rawSocket) => {
        // Upgrade the raw TCP socket to TLS
        const tlsSocket = tls.connect({
          socket: rawSocket,
          servername: url.hostname,
          rejectUnauthorized: opts.rejectUnauthorized !== false,
        });

        tlsSocket.on("secureConnect", () => {
          // Send HTTP request over TLS
          const path = url.pathname + url.search;
          const lines = [
            `${method} ${path} HTTP/1.1`,
            `Host: ${url.host}`,
          ];
          // Ensure Content-Length for POST/PUT/PATCH bodies
          if (opts.body && !headers["Content-Length"] && !headers["content-length"]) {
            const bodyStr = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
            lines.push(`Content-Length: ${Buffer.byteLength(bodyStr)}`);
          }
          for (const [key, val] of Object.entries(headers)) {
            if (key.toLowerCase() !== "host") {
              lines.push(`${key}: ${val}`);
            }
          }
          if (!headers["Connection"] && !headers["connection"]) {
            lines.push("Connection: close");
          }
          lines.push("", "");
          tlsSocket.write(lines.join("\r\n"));
          if (opts.body) tlsSocket.write(opts.body);
        });

        tlsSocket.on("error", reject);

        if (timeout) {
          const reqTimer = setTimeout(() => {
            tlsSocket.destroy();
            reject(new Error("Request timeout"));
          }, timeout);

          tlsSocket.on("close", () => clearTimeout(reqTimer));
        }

        if (opts.signal) {
          opts.signal.addEventListener("abort", () => {
            tlsSocket.destroy();
            reject(new Error("Request aborted"));
          }, { once: true });
        }

        // Parse HTTP response from the TLS stream
        let responseBuffer = "";
        let headersParsed = false;
        let contentLength = -1;
        let isChunked = false;
        let bodyChunks: Buffer[] = [];
        let headerBuffer = Buffer.alloc(0);
        let savedStatusCode = 0;
        let savedStatusText = "";
        let savedHeaders: Record<string, string> = {};

        tlsSocket.on("data", (chunk: Buffer) => {
          if (!headersParsed) {
            headerBuffer = Buffer.concat([headerBuffer, chunk]);
            const headerStr = headerBuffer.toString("utf-8");
            const headerEnd = headerStr.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;

            headersParsed = true;
            const headerPart = headerStr.slice(0, headerEnd);
            const bodyStart = headerBuffer.slice(headerEnd + 4);

            const headerLines = headerPart.split("\r\n");
            const statusLine = headerLines[0];
            const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+) (.*)/);
            savedStatusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
            savedStatusText = statusMatch ? statusMatch[2] : "";

            for (let i = 1; i < headerLines.length; i++) {
              const colonIdx = headerLines[i].indexOf(":");
              if (colonIdx > 0) {
                const key = headerLines[i].slice(0, colonIdx).trim().toLowerCase();
                const val = headerLines[i].slice(colonIdx + 1).trim();
                savedHeaders[key] = val;
              }
            }

            const cl = savedHeaders["content-length"];
            if (cl) contentLength = parseInt(cl);
            isChunked = savedHeaders["transfer-encoding"]?.includes("chunked") || false;

            if (bodyStart.length > 0) bodyChunks.push(bodyStart);

            // Check if body is complete
            if (contentLength >= 0) {
              const totalBody = bodyChunks.reduce((sum, c) => sum + c.length, 0);
              if (totalBody >= contentLength) {
                finishResponse(savedStatusCode, savedStatusText, savedHeaders, url.href);
                tlsSocket.destroy();
              }
            }
          } else {
            bodyChunks.push(chunk);
            if (contentLength >= 0) {
              const totalBody = bodyChunks.reduce((sum, c) => sum + c.length, 0);
              if (totalBody >= contentLength) {
                finishResponse(
                  savedStatusCode || 200,
                  savedStatusText,
                  savedHeaders,
                  url.href,
                );
                tlsSocket.destroy();
              }
            }
          }
        });

        tlsSocket.on("end", () => {
          if (!headersParsed && headerBuffer.length > 0) {
            // Try to parse whatever we got
            const headerStr = headerBuffer.toString("utf-8");
            const headerEnd = headerStr.indexOf("\r\n\r\n");
            if (headerEnd > 0) {
              const headerPart = headerStr.slice(0, headerEnd);
              const headerLines = headerPart.split("\r\n");
              const statusMatch = headerLines[0].match(/HTTP\/[\d.]+ (\d+) (.*)/);
              const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
              const statusText = statusMatch ? statusMatch[2] : "";
              const responseHeaders: Record<string, string> = {};
              for (let i = 1; i < headerLines.length; i++) {
                const colonIdx = headerLines[i].indexOf(":");
                if (colonIdx > 0) {
                  responseHeaders[headerLines[i].slice(0, colonIdx).trim().toLowerCase()] =
                    headerLines[i].slice(colonIdx + 1).trim();
                }
              }
              const bodyStart = headerBuffer.slice(headerEnd + 4);
              if (bodyStart.length > 0) bodyChunks.push(bodyStart);
              finishResponse(statusCode, statusText, responseHeaders, url.href);
              return;
            }
          }
          // Finish with accumulated data
          if (headersParsed || bodyChunks.length > 0) {
            const savedCode = parseInt("200"); // fallback
            finishResponse(savedCode, "", {}, url.href);
          }
        });

        function finishResponse(
          statusCode: number,
          statusText: string,
          responseHeaders: Record<string, string>,
          finalUrl: string,
        ) {
          const body = Buffer.concat(bodyChunks);
          // Decode chunked encoding if needed
          const decodedBody = isChunked ? decodeChunked(body) : body;

          // Handle redirects
          const followRedirects = opts.followRedirects !== false;
          if (followRedirects && redirectCount < maxRedirects && [301, 302, 303, 307, 308].includes(statusCode)) {
            const location = responseHeaders["location"];
            if (location) {
              const redirectUrl = new URL(location, url);
              resolve(makeRequest(redirectUrl, opts, redirectCount + 1));
              return;
            }
          }

          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            statusText,
            headers: responseHeaders,
            url: finalUrl,
            text: () => Promise.resolve(decodedBody.toString("utf-8")),
            json: () => Promise.resolve(JSON.parse(decodedBody.toString("utf-8"))),
            buffer: () => Promise.resolve(decodedBody),
            arrayBuffer: () => Promise.resolve(new Uint8Array(decodedBody).buffer as ArrayBuffer),
          });
        }
      }).catch(reject);

      return;
    }

    // 直连或 HTTP 代理
    const requestOpts: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      method,
      path: url.pathname + url.search,
      headers,
      rejectUnauthorized: opts.rejectUnauthorized !== false,
      timeout: timeout || 30000,
    };

    if (effectiveProxy && !isHttps) {
      // HTTP proxy: 直接请求代理
      requestOpts.hostname = effectiveProxy.host;
      requestOpts.port = effectiveProxy.port;
      requestOpts.path = url.href; // 完整 URL
      requestOpts.agent = getAgent(url.protocol, effectiveProxy);
      if (effectiveProxy.auth) {
        headers["Proxy-Authorization"] = `Basic ${Buffer.from(effectiveProxy.auth).toString("base64")}`;
      }
      const httpReq = http.request(requestOpts, (res) => handleResponse(res));
      httpReq.on("error", reject);
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          httpReq.destroy();
          reject(new Error("Request aborted"));
        }, { once: true });
      }
      if (opts.body) httpReq.write(opts.body);
      httpReq.end();
      return;
    }

    // 直连 (使用连接池)
    requestOpts.agent = getAgent(url.protocol, null);
    const transport = isHttps ? https : http;
    req = transport.request(requestOpts, (res) => handleResponse(res));
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("Request aborted"));
      }, { once: true });
    }

    if (opts.body) req.write(opts.body);
    req.end();

    function handleResponse(res: http.IncomingMessage) {
      // 处理重定向
      const followRedirects = opts.followRedirects !== false;
      if (followRedirects && redirectCount < maxRedirects && res.statusCode) {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url);
          res.resume(); // drain the response
          resolve(makeRequest(redirectUrl, opts, redirectCount + 1));
          return;
        }
      }

      // 收集响应数据
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const responseHeaders: Record<string, string> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          if (val) responseHeaders[key.toLowerCase()] = Array.isArray(val) ? val.join(", ") : val;
        }

        resolve({
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          status: res.statusCode || 0,
          statusText: res.statusMessage || "",
          headers: responseHeaders,
          url: url.href,
          text: () => Promise.resolve(body.toString("utf-8")),
          json: () => Promise.resolve(JSON.parse(body.toString("utf-8"))),
          buffer: () => Promise.resolve(body),
          arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
        });
      });
      res.on("error", reject);
    }
  });
}

// ========== Chunked 解码 ==========

function decodeChunked(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let pos = 0;

  while (pos < buf.length) {
    // Find CRLF after chunk size
    const crlfIdx = buf.indexOf("\r\n", pos);
    if (crlfIdx === -1) break;

    const sizeStr = buf.slice(pos, crlfIdx).toString("utf-8").trim();
    const chunkSize = parseInt(sizeStr, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;

    const dataStart = crlfIdx + 2;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > buf.length) break;

    chunks.push(buf.slice(dataStart, dataEnd));
    pos = dataEnd + 2; // skip trailing CRLF
  }

  return Buffer.concat(chunks);
}

// ========== 公开 API ==========

/**
 * proxyFetch — 替代 Bun 内置 fetch 的代理感知版本
 *
 * 用法与原生 fetch 一致:
 * ```ts
 * const res = await proxyFetch("https://openrouter.ai/api/v1/models", {
 *   headers: { Authorization: "Bearer ..." },
 *   signal: AbortSignal.timeout(15000),
 * });
 * const data = await res.json();
 * ```
 */
export async function proxyFetch(
  urlOrString: string | URL,
  opts: ProxyFetchOptions = {},
): Promise<ProxyFetchResponse> {
  const url = typeof urlOrString === "string" ? new URL(urlOrString) : urlOrString;
  return makeRequest(url, opts);
}

/**
 * 便捷方法: 发送 JSON 请求
 */
export async function proxyFetchJson<T = unknown>(
  url: string | URL,
  opts: ProxyFetchOptions & { body?: unknown } = {},
): Promise<T> {
  const headers = { ...opts.headers };
  let body: string | undefined;

  if (opts.body !== undefined && typeof opts.body !== "string") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(opts.body);
  } else if (typeof opts.body === "string") {
    body = opts.body;
  }

  const res = await proxyFetch(url, { ...opts, body, headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  return res.json();
}

/**
 * 便捷方法: 带重试的请求
 */
export async function proxyFetchWithRetry(
  url: string | URL,
  opts: ProxyFetchOptions = {},
  maxRetries: number = 3,
): Promise<ProxyFetchResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await proxyFetch(url, opts);
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      lastError = err as Error;
    }

    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError || new Error("Request failed after retries");
}
