/**
 * Lightpanda 无头浏览器客户端
 *
 * 为 web crawling 提供轻量级浏览器渲染能力:
 *   - 解决 JS 渲染页面 (SPA/React/Vue) 的内容提取问题
 *   - 9-11x 速度于 Chrome, 1/16 内存
 *   - 支持 CDP 协议 (Chrome DevTools Protocol)
 *   - 智能回退: 静态页面走 HTTP, 动态页面走浏览器
 *
 * 使用方式:
 *   1. 直接 CLI: `lightpanda fetch <url> --dump html`
 *   2. Docker CLI: `docker exec lightpanda lightpanda fetch <url> --dump html`
 *   3. CDP Server: `lightpanda serve --host 0.0.0.0` -> WebSocket CDP
 *   4. Docker CDP: `docker run openclaw-lightpanda serve`
 */
import { logger } from "../utils/logger.js";
import { proxyFetch } from "../utils/proxy-fetch.js";

export interface LightpandaConfig {
  /** Lightpanda 二进制路径 */
  binaryPath?: string;
  /** CDP 服务器地址 */
  cdpUrl?: string;
  /** 页面加载超时 (ms) */
  timeout?: number;
  /** 是否等待 JS 执行完毕 */
  waitForJs?: boolean;
  /** JS 等待时间 (ms) */
  jsWaitTime?: number;
}

export interface RenderResult {
  url: string;
  html: string;
  title: string;
  statusCode: number;
  rendered: boolean;  // whether JS was executed
  loadTimeMs: number;
  method: "cli" | "docker-cli" | "cdp" | "fallback";
}

// ========== 安装检测 ==========

/** 检测 Lightpanda 是否可用 */
export async function detectLightpanda(): Promise<{ available: boolean; path: string | null; method: "binary" | "docker-cli" | "cdp" | "none"; container?: string }> {
  // 1. 检查本地二进制
  const candidates = [
    process.env.LIGHTPANDA_PATH,
    "lightpanda",
    "./lightpanda",
    "/usr/local/bin/lightpanda",
    "/opt/homebrew/bin/lightpanda",
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    try {
      const proc = Bun.spawn([bin, "version"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const version = await new Response(proc.stdout).text();
        logger.info(`[Lightpanda] Found binary: ${bin} (${version.trim()})`);
        return { available: true, path: bin, method: "binary" };
      }
    } catch { /* not found */ }
  }

  // 2. 检查 Docker 容器 (优先使用 docker exec CLI 模式)
  try {
    const proc = Bun.spawn(["docker", "ps", "--filter", "name=lightpanda", "--format", "{{.Names}}|{{.Status}}"], {
      stdout: "pipe", stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const output = (await new Response(proc.stdout).text()).trim();
      if (output.includes("lightpanda")) {
        const containerName = output.split("|")[0].trim();
        logger.info(`[Lightpanda] Found Docker container: ${containerName}`);
        return { available: true, path: null, method: "docker-cli", container: containerName };
      }
    }
  } catch { /* docker not available */ }

  // 3. 检查 CDP 端口 (9222) — 仅用于非 Docker 的独立 CDP 服务器
  try {
    const res = await proxyFetch("http://127.0.0.1:9222/json/version", { timeout: 2000 });
    if (res.ok) {
      const data = await res.json();
      logger.info("[Lightpanda] Found CDP server", { browser: data.Browser });
      return { available: true, path: null, method: "cdp" };
    }
  } catch { /* no CDP server */ }

  return { available: false, path: null, method: "none" };
}

// ========== CLI 渲染 ==========

/** 使用 Lightpanda CLI 渲染单个页面 */
export async function renderWithCLI(
  binaryPath: string,
  url: string,
  timeout: number = 15000,
): Promise<RenderResult> {
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const proc = Bun.spawn(
      [binaryPath, "fetch", url, "--dump", "html", "--wait-ms", String(Math.min(timeout, 10000))],
      {
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      },
    );

    const exitCode = await proc.exited;
    clearTimeout(timer);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      logger.warn(`[Lightpanda] CLI fetch failed: ${stderr.slice(0, 200)}`);
      throw new Error(`Lightpanda CLI error (exit ${exitCode}): ${stderr.slice(0, 200)}`);
    }

    // Extract title from rendered HTML
    const titleMatch = stdout.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? titleMatch[1].trim() : "";

    const loadTimeMs = Date.now() - startTime;
    logger.debug(`[Lightpanda] CLI rendered ${url} in ${loadTimeMs}ms (${stdout.length} bytes)`);

    return {
      url,
      html: stdout,
      title,
      statusCode: 200,
      rendered: true,
      loadTimeMs,
      method: "cli",
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ========== Docker CLI 渲染 ==========

/** 使用 Docker exec 调用 Lightpanda CLI 渲染页面 (适用于 Windows/macOS 无原生二进制时) */
export async function renderWithDockerCLI(
  containerName: string,
  url: string,
  timeout: number = 20000,
): Promise<RenderResult> {
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const proc = Bun.spawn(
      ["docker", "exec", containerName, "lightpanda", "fetch", url,
        "--dump", "html",
        "--wait-ms", String(Math.min(timeout - 2000, 10000))],
      {
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      },
    );

    const exitCode = await proc.exited;
    clearTimeout(timer);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      logger.warn(`[Lightpanda] Docker CLI fetch failed: ${stderr.slice(0, 200)}`);
      throw new Error(`Docker CLI error (exit ${exitCode}): ${stderr.slice(0, 200)}`);
    }

    const titleMatch = stdout.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? titleMatch[1].trim() : "";

    const loadTimeMs = Date.now() - startTime;
    logger.debug(`[Lightpanda] Docker CLI rendered ${url} in ${loadTimeMs}ms (${stdout.length} bytes)`);

    return {
      url,
      html: stdout,
      title,
      statusCode: 200,
      rendered: true,
      loadTimeMs,
      method: "docker-cli",
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ========== CDP 渲染 ==========

/** 使用 CDP 协议渲染页面 (需要 lightpanda serve 运行中) */
export async function renderWithCDP(
  url: string,
  cdpUrl: string = "http://127.0.0.1:9222",
  timeout: number = 15000,
  jsWaitTime: number = 2000,
): Promise<RenderResult> {
  const startTime = Date.now();

  // 1. 获取 CDP WebSocket URL
  const targetsRes = await proxyFetch(`${cdpUrl}/json/new`, { method: "PUT", timeout: 5000 });
  if (!targetsRes.ok) throw new Error("Failed to create CDP target");
  const target = await targetsRes.json();
  const wsUrl: string | undefined = target.webSocketDebuggerUrl;

  if (!wsUrl) throw new Error("No WebSocket debugger URL from CDP");

  // 2. 通过 WebSocket 发送 CDP 命令
  return new Promise<RenderResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP render timeout after ${timeout}ms`));
    }, timeout);

    const ws = new WebSocket(wsUrl);
    let messageId = 1;
    let navigated = false;

    ws.onopen = () => {
      // Navigate to URL
      ws.send(JSON.stringify({
        id: messageId++,
        method: "Page.navigate",
        params: { url },
      }));
    };

    ws.onmessage = async (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data));

      // Page loaded
      if (msg.method === "Page.loadEventFired" || msg.method === "Page.frameStoppedLoading") {
        if (!navigated) {
          navigated = true;
          // Wait for JS to finish executing
          await new Promise(r => setTimeout(r, jsWaitTime));
          // Get rendered HTML
          ws.send(JSON.stringify({
            id: messageId++,
            method: "Runtime.evaluate",
            params: { expression: "document.documentElement.outerHTML" },
          }));
        }
      }

      // Got rendered HTML
      if (msg.id === 2 && msg.result?.result?.value) {
        clearTimeout(timer);
        const html = msg.result.result.value as string;
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);

        // Close the page
        ws.send(JSON.stringify({
          id: messageId++,
          method: "Page.close",
          params: {},
        }));
        ws.close();

        resolve({
          url,
          html,
          title: titleMatch ? titleMatch[1].trim() : "",
          statusCode: 200,
          rendered: true,
          loadTimeMs: Date.now() - startTime,
          method: "cdp",
        });
      }

      // Navigation error
      if (msg.method === "Page.navigationRequestFailed" || msg.method === "Inspector.detached") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`CDP navigation failed: ${msg.params?.errorText || "unknown"}`));
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket error"));
    };
  });
}

// ========== 智能渲染 ==========

let lightpandaInfo: Awaited<ReturnType<typeof detectLightpanda>> | null = null;

/** 智能渲染页面 -- 自动选择最佳方式 */
export async function smartRender(
  url: string,
  options: {
    preferBrowser?: boolean;  // 优先使用浏览器渲染
    timeout?: number;
    jsWaitTime?: number;
  } = {},
): Promise<RenderResult> {
  const { preferBrowser: _preferBrowser = false, timeout = 15000, jsWaitTime = 2000 } = options;

  // 检测 Lightpanda 可用性 (缓存结果)
  if (!lightpandaInfo) {
    lightpandaInfo = await detectLightpanda();
  }

  if (lightpandaInfo.available) {
    try {
      if (lightpandaInfo.method === "binary" && lightpandaInfo.path) {
        return await renderWithCLI(lightpandaInfo.path, url, timeout);
      }
      if (lightpandaInfo.method === "docker-cli") {
        return await renderWithDockerCLI(lightpandaInfo.container || "lightpanda", url, timeout);
      }
      // CDP mode (standalone CDP server, not Docker)
      if (lightpandaInfo.method === "cdp") {
        return await renderWithCDP(url, "http://127.0.0.1:9222", timeout, jsWaitTime);
      }
    } catch (err) {
      logger.warn(`[Lightpanda] Render failed, falling back to HTTP: ${(err as Error).message}`);
    }
  }

  // Fallback: 普通 HTTP fetch
  const startTime = Date.now();
  const res = await proxyFetch(url, {
    timeout,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);

  return {
    url,
    html,
    title: titleMatch ? titleMatch[1].trim() : "",
    statusCode: res.status,
    rendered: false,
    loadTimeMs: Date.now() - startTime,
    method: "fallback",
  };
}

/** 判断页面是否需要浏览器渲染的启发式检测 */
export function needsBrowserRendering(html: string): boolean {
  // 检查 JS 渲染的常见标志
  const indicators = [
    /id="(?:app|root|__next|__nuxt)"/i,        // SPA mount points
    /<div[^>]*id="app"[^>]*>\s*<\/div>/i,      // Empty app div
    /window\.__INITIAL_STATE__|window\.__NUXT__/i,  // SSR hydration
    /React\.createElement|ReactDOM\.render/i,   // React
    /Vue\.createApp|new Vue\(/i,               // Vue
    /ng-version=/i,                             // Angular
    /data-reactroot/i,                          // React root
  ];

  // 如果内容很少但有 SPA 标志，可能需要浏览器渲染
  const textContent = html.replace(/<[^>]+>/g, "").trim();
  const wordCount = textContent.split(/\s+/).length;

  if (wordCount < 50) {
    // Very little text content -- check for SPA indicators
    return indicators.some(re => re.test(html));
  }

  return false;
}

/** 获取 Lightpanda 状态 */
export async function getLightpandaStatus(): Promise<{
  available: boolean;
  method: string;
  version?: string;
}> {
  if (!lightpandaInfo) {
    lightpandaInfo = await detectLightpanda();
  }
  return {
    available: lightpandaInfo.available,
    method: lightpandaInfo.method,
  };
}

/** 启动 Lightpanda Docker 容器 */
export async function startLightpandaDocker(): Promise<boolean> {
  try {
    // 先检查是否已在运行
    const status = await detectLightpanda();
    if (status.available) return true;

    logger.info("[Lightpanda] Starting Docker container...");
    const proc = Bun.spawn([
      "docker", "run", "-d",
      "--name", "lightpanda",
      "-p", "9222:9222",
      "--memory", "256m",
      "--rm",
      "openclaw-lightpanda",
      "serve", "--host", "0.0.0.0", "--advertise-host", "127.0.0.1",
    ], { stdout: "pipe", stderr: "pipe" });

    const exitCode = await proc.exited;
    if (exitCode === 0) {
      // 等待容器启动
      await new Promise(r => setTimeout(r, 3000));
      lightpandaInfo = await detectLightpanda();
      return lightpandaInfo.available;
    }

    const stderr = await new Response(proc.stderr).text();
    logger.warn(`[Lightpanda] Docker start failed: ${stderr.slice(0, 200)}`);
    return false;
  } catch (err) {
    logger.warn(`[Lightpanda] Docker not available: ${(err as Error).message}`);
    return false;
  }
}
