/**
 * 前端 T3.1：渲染层级深度扫描脚本（计划 2026-09-09-frontend-ux-completion-plan.md 附录 B 契约）
 *
 * 口径（契约冻结）：单文件 AST 静态 JSX 嵌套深度——确定性高、零网络、零 LLM。
 * 跨文件组件引用图深度与运行时深度分别归后续可选 / T3.2，本脚本不做。
 *
 * 纯函数核心 scanJsxDepth(source) 为测试面；CLI 薄封装：扫描 frontend/src 下全部 .tsx
 * → 每文件深度 + 全仓 Top 清单 → JSON + Markdown 双份报告（对齐 eval 报告惯例）。
 * 零新增依赖：typescript 已在依赖树（5.9.3），glob 用 Bun 内置。
 *
 * 运行：bun run scripts/frontend/render-depth-audit.ts
 * 确定性：同输入同输出（报告不含时间戳；排序=文件路径升序、深度降序、行号升序）。
 */
import ts from "typescript";
import { mkdirSync, writeFileSync } from "node:fs";

/** 告警阈值：嵌套深度 > 10 层计入 hotspots（契约冻结） */
export const DEPTH_WARN = 10;

export interface JsxHotspot {
  line: number;
  depth: number;
}

export interface JsxDepthResult {
  maxDepth: number;
  hotspots: JsxHotspot[];
}

/** 计入一层的 JSX 节点类型（Fragment <>…</> 与 <React.Fragment> 分别经 JsxFragment / JsxElement 覆盖） */
function isJsxNode(node: ts.Node): boolean {
  return (
    ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)
  );
}

/**
 * 单文件 JSX 嵌套深度审计。
 * 语法错误容错：createSourceFile 对不完整源仍产出可遍历 AST（parseDiagnostics 记录但不抛），
 * 已解析出的 JSX 节点照常计层；行号取节点起始位置（1-based）。
 */
export function scanJsxDepth(source: string): JsxDepthResult {
  const sourceFile = ts.createSourceFile(
    "audit.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  let maxDepth = 0;
  const hotspots: JsxHotspot[] = [];

  const visit = (node: ts.Node, depth: number): void => {
    const next = isJsxNode(node) ? depth + 1 : depth;
    if (isJsxNode(node)) {
      if (next > maxDepth) maxDepth = next;
      if (next > DEPTH_WARN) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        hotspots.push({ line: line + 1, depth: next });
      }
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sourceFile, 0);

  // 稳定排序：深度降序 → 行号升序（同深度按出现顺序）
  hotspots.sort((a, b) => b.depth - a.depth || a.line - b.line);
  return { maxDepth, hotspots };
}

// ---------------- CLI ----------------

interface FileReport {
  file: string;
  maxDepth: number;
  hotspots: JsxHotspot[];
}

async function runCli(): Promise<void> {
  const glob = new Bun.Glob("frontend/src/**/*.tsx");
  const files: string[] = [];
  for await (const f of glob.scan()) files.push(f);
  files.sort(); // 确定性：路径升序

  const reports: FileReport[] = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    const { maxDepth, hotspots } = scanJsxDepth(source);
    reports.push({ file, maxDepth, hotspots });
  }

  const outDir = "reports/frontend";
  mkdirSync(outDir, { recursive: true });

  // JSON 全量（reports/ 在 .gitignore 内，运行时产物）
  const json = { thresholdWarn: DEPTH_WARN, files: reports };
  writeFileSync(`${outDir}/render-depth.json`, JSON.stringify(json, null, 2));

  // Markdown 摘要：>DEPTH_WARN 层清单（文件:行号），可直接作为 T3.3 优化输入
  const offenders = reports
    .filter((r) => r.hotspots.length > 0)
    .sort((a, b) => b.maxDepth - a.maxDepth || a.file.localeCompare(b.file));
  const md: string[] = [];
  md.push("# 前端渲染层级深度扫描报告（T3.1）");
  md.push("");
  md.push(
    `> 脚本：scripts/frontend/render-depth-audit.ts ｜ 口径：单文件 AST 静态 JSX 嵌套深度 ｜ 阈值：>${DEPTH_WARN} 层`,
  );
  md.push(`> 扫描文件数：${reports.length} ｜ 热点文件数：${offenders.length} ｜ 确定性：同输入同输出（无时间戳）`);
  md.push("");
  if (offenders.length === 0) {
    md.push(`无 >${DEPTH_WARN} 层嵌套热点。`);
  } else {
    md.push(`| 文件 | 最大深度 | 热点（行号:深度） |`);
    md.push(`|---|---|---|`);
    for (const r of offenders) {
      const spots = r.hotspots.map((h) => `${h.line}:${h.depth}`).join(", ");
      md.push(`| ${r.file} | ${r.maxDepth} | ${spots} |`);
    }
  }
  md.push("");
  writeFileSync(`${outDir}/render-depth.md`, md.join("\n"));

  const totalHotspots = offenders.reduce((s, r) => s + r.hotspots.length, 0);
  console.log(
    `scanned ${reports.length} files, ${offenders.length} offender files, ${totalHotspots} hotspots (> ${DEPTH_WARN} levels)`,
  );
  console.log(`reports: ${outDir}/render-depth.json + ${outDir}/render-depth.md`);
}

if (import.meta.main) {
  await runCli();
}
