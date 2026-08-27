/**
 * axiom-dsh Axiom HTTP 服务器管理器 —— 拉起/复用 Axiom 主服务并等待健康。
 *
 * Axiom 主服务提供 OpenAI 兼容端点（/v1/chat/completions，可用作 dsh 的
 * LLM provider baseURL）、统计端点与 /axiom 代理目标。默认 autoStartServer=false，
 * dsh 自带 agent loop；需要 Axiom 路由/成本/OpenAI-compat 能力时开启。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import type { NormalizedConfig } from './config.js'

export interface AxiomServerHandle {
  port: number
  url: string
  /** 由本插件拉起的子进程；复用已有实例时为 null。 */
  child: ChildProcess | null
  stop(): Promise<void>
}

export interface SpawnResult {
  child: ChildProcess
}

export type SpawnFn = (config: NormalizedConfig) => ChildProcess
export type HealthPoller = (url: string, timeoutMs: number, child: ChildProcess | null, log: (m: string) => void) => Promise<boolean>

/** 构造子进程 env：注入端口/绑定，合并用户显式 env。 */
export function buildServerEnv(config: NormalizedConfig, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (v !== undefined) env[k] = v
  }
  env.AXIOM_GATEWAY_PORT = String(config.serverPort)
  env.HOST = '127.0.0.1'
  for (const [k, v] of Object.entries(config.serverEnv)) env[k] = v
  return env
}

/** 拉取 Axiom 主服务子进程（默认 bun run src/main.ts，cwd=Axiom 仓库根）。 */
export function spawnAxiomServer(config: NormalizedConfig): ChildProcess {
  const child = spawn(config.serverCommand, config.serverArgs, {
    cwd: config.axiomHome,
    env: buildServerEnv(config),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // 保持子进程日志可诊断但不过量：只留最近若干行
  let tail = ''
  const capture = (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-4000)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  ;(child as ChildProcess & { _logTail?: string })._logTail = tail
  return child
}

function childTail(child: ChildProcess | null): string {
  return (child as ChildProcess & { _logTail?: string } | null)?._logTail ?? ''
}

/** 单次健康探测。 */
export async function probeHealth(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 轮询健康直到就绪或超时；子进程提前退出视为失败并附 stderr 尾部。
 * 默认实现可被测试注入替换。
 */
export const waitForHealth: HealthPoller = async (url, timeoutMs, child, log) => {
  const deadline = Date.now() + timeoutMs
  let lastOk = false
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`[axiom-dsh] Axiom server exited before healthy (code=${child.exitCode}): ${childTail(child)}`)
    }
    lastOk = await probeHealth(url)
    if (lastOk) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`[axiom-dsh] Axiom server not healthy within ${timeoutMs}ms: ${url} (${childTail(child)})`)
}

/** 停止子进程（容错：已退出则直接返回）。 */
export async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed || child.exitCode !== null) return
  child.kill()
  if (child.exitCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
  }
  if (child.exitCode === null) child.kill('SIGKILL')
}

/**
 * 启动（或复用）Axiom HTTP 服务器。
 * @param config 归一化配置
 * @param log 日志回调
 * @param deps 可注入依赖（测试用）：spawnFn / waitForHealthFn
 */
export async function startAxiomServer(
  config: NormalizedConfig,
  log: (m: string) => void,
  deps?: { spawnFn?: SpawnFn; waitForHealthFn?: HealthPoller },
): Promise<AxiomServerHandle> {
  if (!config.homeCheck.ok) {
    throw new Error(
      `[axiom-dsh] Axiom home invalid, missing: ${config.homeCheck.missing.join(', ')}. ` +
        'Set axiomHome in cordis config or AXIOM_HOME env.',
    )
  }
  const url = `http://127.0.0.1:${config.serverPort}`
  const healthUrl = `${url}${config.serverHealthPath}`

  // 复用已在运行的实例（例如用户已手动启动 Axiom）
  if (await probeHealth(healthUrl, 2000)) {
    log(`[axiom-dsh] reuse running Axiom server at ${url}`)
    return { port: config.serverPort, url, child: null, stop: async () => {} }
  }

  const spawnFn = deps?.spawnFn ?? spawnAxiomServer
  const healthFn = deps?.waitForHealthFn ?? waitForHealth
  const child = spawnFn(config)
  await healthFn(healthUrl, config.serverStartTimeoutMs, child, log)
  log(`[axiom-dsh] Axiom server ready at ${url}`)
  return {
    port: config.serverPort,
    url,
    child,
    stop: async () => {
      await stopChild(child)
    },
  }
}

/** 构造 /axiom 前缀 HTTP 代理 handler（转发到 Axiom 主服务，剥离前缀）。 */
export function createProxyHandler(config: NormalizedConfig): (req: unknown, res: unknown) => void {
  return (req: unknown, res: unknown): void => {
    const incoming = req as http.IncomingMessage
    const response = res as http.ServerResponse
    const rawUrl = incoming.url ?? '/'
    const stripped = rawUrl.startsWith(config.proxyPath)
      ? rawUrl.slice(config.proxyPath.length) || '/'
      : rawUrl
    const target = new URL(stripped, `http://127.0.0.1:${config.serverPort}`)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(incoming.headers)) {
      if (v !== undefined && k.toLowerCase() !== 'host') headers[k] = String(v)
    }
    if (config.serverApiKey) headers['x-api-key'] = config.serverApiKey

    const proxyReq = http.request(
      target,
      { method: incoming.method ?? 'GET', headers },
      (proxyRes) => {
        response.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(response)
      },
    )
    proxyReq.on('error', (err) => {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(`[axiom-dsh] proxy error: ${err.message}`)
    })
    incoming.pipe(proxyReq)
  }
}

