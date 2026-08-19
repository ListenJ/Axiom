import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  indexProject,
  searchSymbolsLocal,
  getCallersLocal,
  getCalleesLocal,
  isProjectIndexed,
  getCodeIndexDb,
} from '../../src/codeindex/local-index.js'

let fixture: string
const PROJ = 'fixture-proj'

beforeEach(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'codeindex-'))
  const src = path.join(fixture, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(path.join(src, 'math.ts'), `
export function add(a: number, b: number): number {
  return a + b;
}
export function multiply(a: number, b: number): number {
  return a * b;
}
`)
  writeFileSync(path.join(src, 'calc.ts'), `
import { add } from './math.js';
export class Calculator {
  total: number = 0;
  addTo(n: number): number {
    this.total = add(this.total, n);
    return this.total;
  }
}
export function run(): number {
  const c = new Calculator();
  return c.addTo(5);
}
`)
  // node_modules 应被排除
  mkdirSync(path.join(fixture, 'node_modules', 'x'), { recursive: true })
  writeFileSync(path.join(fixture, 'node_modules', 'x', 'junk.ts'), `export const junk = 1;`)
})

describe('专有代码索引（AST→SQLite）', () => {
  test('indexProject 提取符号/调用并写入 SQLite（排除 node_modules）', () => {
    const r = indexProject(fixture, PROJ)
    expect(r.files).toBe(2)
    expect(r.symbols).toBeGreaterThanOrEqual(6) // add/multiply/Calculator/total/addTo/run
    expect(r.calls).toBeGreaterThanOrEqual(2)   // run→Calculator / addTo→add
    expect(isProjectIndexed(PROJ)).toBe(true)

    const db = getCodeIndexDb()
    const rows = db.query('SELECT DISTINCT file_path FROM code_symbols WHERE project = ?').all(PROJ) as Array<{ file_path: string }>
    expect(rows.some((r2) => r2.file_path.includes('node_modules'))).toBe(false)
  })

  test('searchSymbolsLocal 按 kind/关键字查询', () => {
    indexProject(fixture, PROJ)
    const classes = searchSymbolsLocal('', PROJ, { kind: 'class' })
    expect(classes.some((s) => s.node.name === 'Calculator')).toBe(true)
    const fns = searchSymbolsLocal('add', PROJ, { kind: 'function' })
    expect(fns.length).toBeGreaterThan(0)
    expect(fns.some((s) => s.node.name === 'add')).toBe(true)
  })

  test('getCallersLocal / getCalleesLocal 返回真实调用关系', () => {
    indexProject(fixture, PROJ)
    // addTo 调用 add → add 的调用者是 addTo（qualified Calculator.addTo）
    const callers = getCallersLocal('add', PROJ)
    expect(callers.some((s) => s.node.name === 'addTo')).toBe(true)
    // run 调用 Calculator.addTo → Calculator.addTo 的调用者是 run
    const callers2 = getCallersLocal('Calculator.addTo', PROJ)
    expect(callers2.some((s) => s.node.name === 'run')).toBe(true)
    // addTo 的被调用者（addTo 调用的符号）含 add
    const callees = getCalleesLocal('Calculator.addTo', PROJ)
    expect(callees.some((s) => s.node.name === 'add')).toBe(true)
    // run 的调用者是顶层（无）；run 的被调用者含 Calculator 与 addTo
    const runCallees = getCalleesLocal('run', PROJ)
    expect(runCallees.some((s) => s.node.name === 'Calculator')).toBe(true)
    expect(runCallees.some((s) => s.node.name === 'addTo')).toBe(true)
  })

  test('重复索引幂等（先清旧数据）', () => {
    indexProject(fixture, PROJ)
    const first = searchSymbolsLocal('', PROJ).length
    indexProject(fixture, PROJ)
    const second = searchSymbolsLocal('', PROJ).length
    expect(second).toBe(first)
  })
})
