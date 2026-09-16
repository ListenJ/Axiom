import { describe, test, expect } from 'bun:test'
import path from 'node:path'
import { apply } from '../src/index.js'
import { normalizeConfig } from '../src/config.js'
import type { DshContext, DshToolDefinition } from '../src/types.js'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')

interface MockCtx extends DshContext {
  tools: DshContext['tools'] & { defs: DshToolDefinition[] }
  cleanups: Array<() => void>
}

function mockCtx(): MockCtx {
  const defs: DshToolDefinition[] = []
  const cleanups: Array<() => void> = []
  return {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      defs,
      register: (def: DshToolDefinition) => {
        defs.push(def)
        return () => {
          const i = defs.indexOf(def)
          if (i >= 0) defs.splice(i, 1)
        }
      },
    },
    effect: (register: () => void | (() => void)) => {
      const cleanup = register()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    inject: () => {},
    get: () => undefined,
  } as unknown as MockCtx
}

describe('apply + axiom_status', () => {
  test('注册 axiom_status，返回值为 lossless JSON 且与 schema 相容', async () => {
    const ctx = mockCtx()
    const config = normalizeConfig({ axiomHome: REPO, mcpEnabled: false, frostedGlass: false }, import.meta.url)
    await apply(ctx, config)
    const status = ctx.tools.defs.find((d) => d.name === 'axiom_status')
    expect(status).toBeDefined()

    const value = (await status!.execute({})) as Record<string, unknown>
    // dsh 的 lossless-JSON 契约：JSON 往返后深度相等
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    expect(Object.keys(value).sort()).toEqual(['config', 'frostedGlass', 'mcp', 'server'])

    // schema 声明的属性集必须与实际返回值一致（additionalProperties: false 时尤其关键）
    const schemaProps = Object.keys((status!.output.schema as { properties: Record<string, unknown> }).properties).sort()
    expect(schemaProps).toEqual(Object.keys(value).sort())
  })
})
