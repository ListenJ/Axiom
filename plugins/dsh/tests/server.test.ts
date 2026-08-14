import { describe, test, expect } from 'bun:test'
import http from 'node:http'
import path from 'node:path'
import { buildServerEnv, probeHealth, stopChild, spawnAxiomServer, type AxiomServerHandle } from '../src/server.js'
import { normalizeConfig } from '../src/config.js'

const REPO = path.resolve(process.cwd(), '..', '..')
const config = normalizeConfig({ axiomHome: REPO }, 'file:///C:/repo/plugins/dsh/src/index.ts')

describe('buildServerEnv', () => {
  test('注入端口与绑定，保留父环境，显式 env 覆盖', () => {
    const parent = { PATH: '/bin', HOME: '/home' }
    const env = buildServerEnv({ ...config, serverEnv: { AXIOM_GATEWAY_PORT: '9999' } }, parent)
    expect(env.AXIOM_GATEWAY_PORT).toBe('9999')
    expect(env.HOST).toBe('127.0.0.1')
    expect(env.PATH).toBe('/bin')
  })
})

describe('probeHealth', () => {
  test('可达返回 true，不可达返回 false', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    try {
      expect(await probeHealth(`http://127.0.0.1:${addr.port}/health`)).toBe(true)
      expect(await probeHealth('http://127.0.0.1:1/health')).toBe(false)
    } finally {
      server.close()
    }
  })
})

describe('stopChild', () => {
  test('已退出/空子进程不抛错', async () => {
    await stopChild(null)
    const c = spawnAxiomServer({ ...config, serverCommand: process.execPath, serverArgs: ['-e', 'process.exit(0)'] })
    // 等待退出后再 stop 应无副作用
    await new Promise((r) => setTimeout(r, 300))
    await stopChild(c)
  })
})

describe('startAxiomServer 复用逻辑', () => {
  test('已健康实例直接复用（不 spawn）', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const cfg = { ...config, serverPort: addr.port }
    const logs: string[] = []
    let spawned = false
    const { startAxiomServer } = await import('../src/server.js')
    const handle: AxiomServerHandle = await startAxiomServer(
      cfg,
      (m) => logs.push(m),
      { spawnFn: () => { spawned = true; return spawnAxiomServer(cfg) } },
    )
    try {
      expect(spawned).toBe(false)
      expect(handle.child).toBeNull()
      await handle.stop()
    } finally {
      server.close()
    }
  })
})
