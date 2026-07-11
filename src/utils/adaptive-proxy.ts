/**
 * 自适应代理管理器
 *
 * 功能:
 *   1. 自动检测系统代理状态 (环境变量 + Windows 注册表)
 *   2. 健康检查: 定期探测代理连通性
 *   3. 自动切换: 代理不可用时降级为直连，恢复时切回代理
 *   4. 多代理轮转: 支持多个代理地址，按延迟排序
 *   5. 缓存策略: 避免重复检测，定时刷新
 *
 * 用法:
 *   import { getAdaptiveProxy } from "./adaptive-proxy.js";
 *   const proxy = await getAdaptiveProxy();
 *   if (proxy) {
 *     // 使用 proxy.host:proxy.port 建立 CONNECT tunnel
 *   }
 */
import { logger } from "./logger.js";
import { readString } from "./env.js";

// ========== 类型定义 ==========

export interface ProxyEndpoint {
  host: string;
  port: number;
  protocol: "http" | "https" | "socks5";
  auth?: string;
  label?: string;  // 例如 "clash-verge", "system", "env"
}

export interface ProxyHealthStatus {
  endpoint: ProxyEndpoint;
  healthy: boolean;
  latencyMs: number;
  lastCheck: Date;
  consecutiveFailures: number;
}

export interface AdaptiveProxyConfig {
  /** 健康检查间隔 (ms) */
  healthCheckInterval: number;
  /** 探测超时 (ms) */
  probeTimeout: number;
  /** 连续失败多少次后标记为不健康 */
  failureThreshold: number;
  /** 探测目标 URL */
  probeUrls: string[];
  /** 是否启用自动检测 */
  autoDetect: boolean;
}

// ========== 默认配置 ==========

const DEFAULT_CONFIG: AdaptiveProxyConfig = {
  healthCheckInterval: 60_000,      // 60 秒检查一次
  probeTimeout: 5000,               // 5 秒超时
  failureThreshold: 3,              // 连续 3 次失败切换
  probeUrls: [
    "https://openrouter.ai/api/v1/models",
    "https://api.deepseek.com/v1/models",
    "https://www.google.com",
  ],
  autoDetect: true,
};

// ========== 状态 ==========

let config: AdaptiveProxyConfig = { ...DEFAULT_CONFIG };
let candidates: ProxyEndpoint[] = [];
let healthStatuses: Map<string, ProxyHealthStatus> = new Map();
let currentBest: ProxyEndpoint | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

// ========== 代理发现 ==========

/**
 * 从 Windows 注册表读取系统代理
 */
async function detectWindowsProxy(): Promise<ProxyEndpoint | null> {
  if (process.platform !== "win32") return null;

  try {
    const { spawnSync } = await import("node:child_process");

    const enabled = spawnSync("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyEnable",
    ], { encoding: "utf-8", timeout: 3000 });

    if (enabled.status !== 0 || !enabled.stdout.includes("0x1")) return null;

    const server = spawnSync("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyServer",
    ], { encoding: "utf-8", timeout: 3000 });

    if (server.status !== 0) return null;

    const match = server.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!match) return null;

    const proxyStr = match[1].trim();
    // 解析格式: "host:port" 或 "http=host:port;https=host:port"
    let host: string, port: number;

    if (proxyStr.includes("=")) {
      // 多协议格式: http=127.0.0.1:7897;https=127.0.0.1:7897;...
      const httpsMatch = proxyStr.match(/https=([^;]+)/);
      const httpMatch = proxyStr.match(/http=([^;]+)/);
      const addr = httpsMatch?.[1] || httpMatch?.[1];
      if (!addr) return null;
      const parts = addr.split(":");
      host = parts[0];
      port = parseInt(parts[1], 10);
    } else {
      const parts = proxyStr.split(":");
      host = parts[0];
      port = parseInt(parts[1], 10);
    }

    if (!host || isNaN(port)) return null;

    return { host, port, protocol: "http", label: "system" };
  } catch {
    return null;
  }
}

/**
 * 从环境变量读取代理
 */
function detectEnvProxy(): ProxyEndpoint[] {
  const endpoints: ProxyEndpoint[] = [];
  const envVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

  for (const envVar of envVars) {
    const val = readString(envVar);
    if (!val) continue;

    try {
      const url = new URL(val.startsWith("http") ? val : `http://${val}`);
      const protocol = val.startsWith("socks") ? "socks5" : "http";
      const endpoint: ProxyEndpoint = {
        host: url.hostname,
        port: parseInt(url.port) || (protocol === "socks5" ? 1080 : 8080),
        protocol: protocol as "http" | "socks5",
        label: envVar,
      };
      if (url.username) {
        endpoint.auth = `${url.username}:${url.password}`;
      }
      endpoints.push(endpoint);
    } catch { /* skip invalid */ }
  }

  return endpoints;
}

/**
 * 常见本地代理端口扫描 (Clash, V2Ray, Shadowsocks 等)
 */
async function scanCommonProxies(): Promise<ProxyEndpoint[]> {
  const commonPorts = [
    { port: 7897, label: "clash-verge" },
    { port: 7890, label: "clash-default" },
    { port: 1080, label: "socks5-default" },
    { port: 10808, label: "v2ray" },
    { port: 10809, label: "v2ray-http" },
    { port: 8080, label: "generic" },
    { port: 33210, label: "ss-local" },
  ];

  const found: ProxyEndpoint[] = [];
  const { createConnection } = await import("node:net");

  // 并行探测端口
  const checks = commonPorts.map(({ port, label }) =>
    new Promise<ProxyEndpoint | null>((resolve) => {
      const sock = createConnection({ host: "127.0.0.1", port, timeout: 1000 });
      sock.on("connect", () => {
        sock.destroy();
        resolve({ host: "127.0.0.1", port, protocol: "http", label });
      });
      sock.on("error", () => resolve(null));
      sock.on("timeout", () => { sock.destroy(); resolve(null); });
    })
  );

  const results = await Promise.all(checks);
  for (const r of results) {
    if (r) found.push(r);
  }

  return found;
}

// ========== 健康检查 ==========

/**
 * 探测单个代理的连通性
 */
async function probeProxy(endpoint: ProxyEndpoint): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();

  try {
    const net = await import("node:net");
    const tls = await import("node:tls");

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sock.destroy();
        resolve({ healthy: false, latencyMs: config.probeTimeout });
      }, config.probeTimeout);

      const sock = net.createConnection({ host: endpoint.host, port: endpoint.port }, () => {
        // TCP 连接成功，尝试 HTTP CONNECT 隧道
        const targetHost = "openrouter.ai";
        sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`);
      });

      let responseData = "";
      sock.on("data", (chunk: Buffer) => {
        responseData += chunk.toString();
        if (responseData.includes("\r\n\r\n")) {
          clearTimeout(timer);
          const statusMatch = responseData.match(/HTTP\/\d\.\d (\d+)/);
          const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
          sock.destroy();

          if (statusCode >= 200 && statusCode < 300) {
            resolve({ healthy: true, latencyMs: Date.now() - start });
          } else {
            resolve({ healthy: false, latencyMs: Date.now() - start });
          }
        }
      });

      sock.on("error", () => {
        clearTimeout(timer);
        resolve({ healthy: false, latencyMs: Date.now() - start });
      });
    });
  } catch {
    return { healthy: false, latencyMs: config.probeTimeout };
  }
}

/**
 * 运行健康检查，更新状态
 */
async function runHealthCheck(): Promise<void> {
  logger.debug("[AdaptiveProxy] Running health check...");

  const checks = candidates.map(async (ep) => {
    const key = `${ep.host}:${ep.port}`;
    const existing = healthStatuses.get(key);
    const result = await probeProxy(ep);

    const status: ProxyHealthStatus = {
      endpoint: ep,
      healthy: result.healthy,
      latencyMs: result.latencyMs,
      lastCheck: new Date(),
      consecutiveFailures: result.healthy
        ? 0
        : (existing?.consecutiveFailures || 0) + 1,
    };

    healthStatuses.set(key, status);
    return status;
  });

  const results = await Promise.all(checks);

  // 选择最佳代理: 健康 + 最低延迟
  const healthy = results
    .filter((r) => r.healthy && r.consecutiveFailures < config.failureThreshold)
    .sort((a, b) => a.latencyMs - b.latencyMs);

  const newBest = healthy.length > 0 ? healthy[0].endpoint : null;

  if (newBest) {
    if (!currentBest || `${currentBest.host}:${currentBest.port}` !== `${newBest.host}:${newBest.port}`) {
      logger.info("[AdaptiveProxy] Switched proxy", {
        from: currentBest ? `${currentBest.host}:${currentBest.port}` : "none",
        to: `${newBest.host}:${newBest.port}`,
        label: newBest.label,
        latency: healthy[0].latencyMs,
      });
    }
    currentBest = newBest;
  } else if (currentBest) {
    logger.warn("[AdaptiveProxy] All proxies unhealthy, switching to direct connection");
    currentBest = null;
  }
}

// ========== 公共 API ==========

/**
 * 初始化自适应代理管理器
 */
export async function initAdaptiveProxy(overrides?: Partial<AdaptiveProxyConfig>): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (overrides) {
    config = { ...config, ...overrides };
  }

  logger.info("[AdaptiveProxy] Initializing...");

  // 1. 收集代理候选
  const envProxies = detectEnvProxy();
  const winProxy = await detectWindowsProxy();
  const scannedProxies = config.autoDetect ? await scanCommonProxies() : [];

  // 合并去重
  const allCandidates = [...envProxies];
  if (winProxy && !allCandidates.some((e) => e.host === winProxy.host && e.port === winProxy.port)) {
    allCandidates.push(winProxy);
  }
  for (const sp of scannedProxies) {
    if (!allCandidates.some((e) => e.host === sp.host && e.port === sp.port)) {
      allCandidates.push(sp);
    }
  }

  candidates = allCandidates;
  logger.info("[AdaptiveProxy] Discovered proxy candidates", {
    count: candidates.length,
    proxies: candidates.map((c) => `${c.label}(${c.host}:${c.port})`),
  });

  // 2. 首次健康检查
  await runHealthCheck();

  // 3. 定时健康检查
  healthCheckTimer = setInterval(runHealthCheck, config.healthCheckInterval);
}

/**
 * 获取当前最佳代理 (或 null 表示直连)
 */
export async function getAdaptiveProxy(): Promise<ProxyEndpoint | null> {
  if (!initialized) {
    await initAdaptiveProxy();
  }
  return currentBest;
}

/**
 * 报告连接失败 (触发即时重检)
 */
export async function reportFailure(): Promise<void> {
  if (!currentBest) return;

  const key = `${currentBest.host}:${currentBest.port}`;
  const status = healthStatuses.get(key);
  if (status) {
    status.consecutiveFailures++;
    if (status.consecutiveFailures >= config.failureThreshold) {
      logger.warn("[AdaptiveProxy] Proxy failed, triggering recheck", { proxy: key });
      await runHealthCheck();
    }
  }
}

/**
 * 报告连接成功
 */
export function reportSuccess(): void {
  if (!currentBest) return;

  const key = `${currentBest.host}:${currentBest.port}`;
  const status = healthStatuses.get(key);
  if (status) {
    status.consecutiveFailures = 0;
  }
}

/**
 * 获取代理状态摘要 (用于 /health 或 /status API)
 */
export function getProxyStatus(): {
  enabled: boolean;
  current: ProxyEndpoint | null;
  candidates: Array<{
    endpoint: ProxyEndpoint;
    healthy: boolean;
    latencyMs: number;
    lastCheck: Date;
  }>;
} {
  return {
    enabled: currentBest !== null,
    current: currentBest,
    candidates: Array.from(healthStatuses.values()).map((s) => ({
      endpoint: s.endpoint,
      healthy: s.healthy && s.consecutiveFailures < config.failureThreshold,
      latencyMs: s.latencyMs,
      lastCheck: s.lastCheck,
    })),
  };
}

/**
 * 停止健康检查定时器
 */
export function stopAdaptiveProxy(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  initialized = false;
  currentBest = null;
  healthStatuses.clear();
  candidates = [];
}
