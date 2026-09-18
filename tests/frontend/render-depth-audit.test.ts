/**
 * 前端 T3.1：渲染层级深度扫描脚本测试（计划附录 B 契约，TDD RED→GREEN）
 *
 * 契约口径：scanJsxDepth(source) 单文件 AST 静态 JSX 嵌套深度审计，
 * 返回 { maxDepth, hotspots: Array<{line, depth}> }；hotspots = 深度 > DEPTH_WARN(10) 的节点。
 * 夹具覆盖：浅嵌套 / 深嵌套 / 自闭合 / Fragment / 条件渲染 / 空源 / 语法错误容错，
 * 外加 JSX 长尾形态（泛型箭头组件、可选链子元素）。
 */
import { describe, expect, it } from "bun:test";
import { scanJsxDepth, DEPTH_WARN } from "../../scripts/frontend/render-depth-audit.js";

/** 单行 n 层 div 嵌套（行号全为 1，用于精确深度断言） */
function nest(n: number): string {
  return `const X = () => ${"<div>".repeat(n)}x${"</div>".repeat(n)};`;
}

/** 每层一行的 n 层 div 嵌套（第 k 层 div 落在第 k+1 行，用于行号断言） */
function nestLines(n: number): string {
  const open = Array.from({ length: n }, (_, i) => `${"  ".repeat(i + 1)}<div>`).join("\n");
  const close = Array.from({ length: n }, (_, i) => `${"  ".repeat(n - i)}</div>`).join("\n");
  return `const Y = () => (\n${open}\nx\n${close}\n);\n`;
}

describe("T3.1 scanJsxDepth：深度计算", () => {
  it("浅嵌套：div > span → maxDepth=2", () => {
    const src = `const A = () => (\n  <div>\n    <span>hello</span>\n  </div>\n);\n`;
    expect(scanJsxDepth(src).maxDepth).toBe(2);
  });

  it("自闭合元素计入一层：div > img → maxDepth=2", () => {
    const src = `const B = () => <div><img src="x" alt="a" /></div>;\n`;
    expect(scanJsxDepth(src).maxDepth).toBe(2);
  });

  it("Fragment（<>...</>）计入一层：Fragment > div > p → maxDepth=3", () => {
    const src = `const C = () => (\n  <>\n    <div><p>x</p></div>\n  </>\n);\n`;
    expect(scanJsxDepth(src).maxDepth).toBe(3);
  });

  it("显式 React.Fragment 计入一层", () => {
    const src = `const C2 = () => (\n  <React.Fragment>\n    <div><p>x</p></div>\n  </React.Fragment>\n);\n`;
    expect(scanJsxDepth(src).maxDepth).toBe(3);
  });

  it("条件渲染不额外计层：div > {ok && section > article} → maxDepth=3", () => {
    const src = `const E = ({ ok }: { ok: boolean }) => (\n  <div>\n    {ok && <section><article>x</article></section>}\n  </div>\n);\n`;
    expect(scanJsxDepth(src).maxDepth).toBe(3);
  });

  it("无 JSX 源 → maxDepth=0", () => {
    expect(scanJsxDepth(`export const f = (x: number) => x + 1;\n`).maxDepth).toBe(0);
  });

  it("精确深度：nest(1)/nest(6)/nest(12)", () => {
    expect(scanJsxDepth(nest(1)).maxDepth).toBe(1);
    expect(scanJsxDepth(nest(6)).maxDepth).toBe(6);
    expect(scanJsxDepth(nest(12)).maxDepth).toBe(12);
  });
});

describe("T3.1 scanJsxDepth：hotspots（> DEPTH_WARN 清单）", () => {
  it("DEPTH_WARN 常量为 10（契约冻结）", () => {
    expect(DEPTH_WARN).toBe(10);
  });

  it("12 层嵌套 → hotspots 为 depth 11、12 两节点（不含 ≤10 层）", () => {
    const { maxDepth, hotspots } = scanJsxDepth(nest(12));
    expect(maxDepth).toBe(12);
    expect(hotspots.map((h) => h.depth)).toEqual([12, 11]); // 深度降序
    expect(hotspots.every((h) => h.depth > DEPTH_WARN)).toBe(true);
  });

  it("恰好 10 层 → hotspots 为空（严格大于阈值）", () => {
    const { maxDepth, hotspots } = scanJsxDepth(nest(10));
    expect(maxDepth).toBe(10);
    expect(hotspots).toEqual([]);
  });

  it("行号精确：每层一行时第 k 层 div 落在第 k+1 行", () => {
    const { hotspots } = scanJsxDepth(nestLines(12));
    // 深度 11 → 第 12 行；深度 12 → 第 13 行
    expect(hotspots).toEqual([
      { line: 13, depth: 12 },
      { line: 12, depth: 11 },
    ]);
  });
});

describe("T3.1 scanJsxDepth：容错与 JSX 长尾", () => {
  it("空源 → maxDepth=0 且 hotspots 空，不抛异常", () => {
    const r = scanJsxDepth("");
    expect(r).toEqual({ maxDepth: 0, hotspots: [] });
  });

  it("语法错误源不抛异常，返回数值型 maxDepth（容错）", () => {
    const broken = `const D = () => (\n  <div>\n    <span>unclosed\n);\n`;
    const r = scanJsxDepth(broken);
    expect(Number.isInteger(r.maxDepth)).toBe(true);
    expect(r.maxDepth).toBeGreaterThanOrEqual(1); // 已解析出的 div 仍计入
    expect(Array.isArray(r.hotspots)).toBe(true);
  });

  it("泛型箭头组件 <T,>(...) 不误判为 JSX", () => {
    const src = `const Z = <T,>(p: { x: T }) => <div>{p.x}</div>;\n`;
    expect(scanJsxDepth(src).maxDepth).toBe(1);
  });

  it("可选链子元素正常计层：div > {a?.b && span} → maxDepth=2", () => {
    const src = `const F = ({ a }: { a?: { b?: boolean } }) => <div>{a?.b && <span>x</span>}</div>;\n`;
    expect(scanJsxDepth(src).maxDepth).toBe(2);
  });
});
