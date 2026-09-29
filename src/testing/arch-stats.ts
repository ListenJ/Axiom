/**
 * 架构基线统计（单一事实源）
 *
 * 口径（可复算，与 `find|wc` 同义）：
 *   - src 模块 = `src/` 顶层目录数
 *   - src 文件/行数 = `src/` 下 *.ts 递归（排除 node_modules/.git），行数按换行符计数
 *   - 测试文件 = `tests/` 下 *.test.ts 递归
 *   - MCP 工具 = 委托单一事实源 `src/testing/tool-count.ts`（countMcpTools）
 *
 * 消费方：`scripts/count-arch-stats.mjs`（CLI 打印）与
 * `tests/unit/docs-consistency.test.ts`（断言 docs/ARCHITECTURE.md §1 声明值
 * 与实测精确相等——把"手抄数字"变成棘轮，2026-09-29）。
 * 历史漂移证据：§1 曾手抄 260+ 文件 / ~70,000 行 / ~1,170 用例；2026-09-29 校准当天
 * 又漂 137 行（新增文件未同步），故本模块 + 守卫即止损点。
 * 用例数**不在此模块**：须实跑 `bun test --timeout 15000 ./tests`（避免把文档生成做成重活）。
 */
import fs from "node:fs";
import path from "node:path";
import { countMcpTools } from "./tool-count.js";

export interface ArchStats {
  srcModules: number;
  srcFiles: number;
  srcLines: number;
  testFiles: number;
  mcpTools: number;
  duplicateTools: number;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 统计当前工作树（cwd 为仓库根）。 */
export function archStats(root = "."): ArchStats {
  const srcTsfiles = walk(path.join(root, "src")).filter((f) => f.endsWith(".ts"));
  const srcLines = srcTsfiles.reduce((n, f) => n + fs.readFileSync(f, "utf8").split("\n").length - 1, 0);
  const srcModules = fs
    .readdirSync(path.join(root, "src"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).length;
  const testFiles = walk(path.join(root, "tests")).filter((f) => f.endsWith(".test.ts"));
  const { total: mcpTools, duplicates } = countMcpTools();
  return {
    srcModules,
    srcFiles: srcTsfiles.length,
    srcLines,
    testFiles: testFiles.length,
    mcpTools,
    duplicateTools: duplicates.length,
  };
}

/** §1 声明的文档片段（生成器与守卫共用同一格式，避免两处口径分叉）。 */
export function archStatsSnippet(s: ArchStats): string {
  return (
    `src/ **${s.srcModules} 模块 / ${s.srcFiles} 文件 / ${s.srcLines.toLocaleString("en-US")} 行**；` +
    `tests/ **${s.testFiles} 个 *.test.ts**；MCP 工具 **${s.mcpTools}**（零重复）。`
  );
}
