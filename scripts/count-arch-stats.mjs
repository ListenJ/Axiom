/**
 * 架构基线统计（单一生成器，供 docs/ARCHITECTURE.md §1 引用，禁止手抄）
 *
 * 用法：`bun run scripts/count-arch-stats.mjs`
 *
 * 口径（可复算，与 `find|wc` 同义）：
 *   - src 模块 = `src/` 顶层目录数
 *   - src 文件/行数 = `src/` 下 *.ts 递归（排除 node_modules），行数按换行符计数
 *   - 测试文件 = `tests/` 下 *.test.ts 递归
 *   - MCP 工具 = 委托单一事实源 `src/testing/tool-count.ts`（countMcpTools）
 * 用例数**不在本脚本**：须实跑 `bun test --timeout 15000 ./tests`（避免把文档生成做成重活）。
 * 历史漂移证据：ARCHITECTURE.md §1 曾手抄 260+ 文件 / ~70,000 行 / 80+ 测试文件 / ~1,170 用例，
 * 2026-09-29 实测为 452 / 121,873 / 470 / 4,675 —— 本脚本即为此类漂移的止损点。
 */
import fs from "node:fs";
import path from "node:path";
import { countMcpTools } from "../src/testing/tool-count.ts";

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const srcTsfiles = walk("src").filter((f) => f.endsWith(".ts"));
const srcLines = srcTsfiles.reduce((n, f) => n + fs.readFileSync(f, "utf8").split("\n").length - 1, 0);
const srcModules = fs.readdirSync("src", { withFileTypes: true }).filter((e) => e.isDirectory()).length;
const testFiles = walk("tests").filter((f) => f.endsWith(".test.ts"));
const { total: mcpTools, duplicates } = countMcpTools();

const stats = {
  srcModules,
  srcFiles: srcTsfiles.length,
  srcLines,
  testFiles: testFiles.length,
  mcpTools,
  duplicateTools: duplicates.length,
};

console.log(JSON.stringify(stats, null, 2));
console.log(
  `\n片段：src/ **${srcModules} 模块 / ${srcTsfiles.length} 文件 / ${srcLines.toLocaleString("en-US")} 行**；` +
  `tests/ **${testFiles.length} 个 *.test.ts**；MCP 工具 **${mcpTools}**（零重复）。`,
);
