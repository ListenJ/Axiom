/**
 * 架构基线统计 CLI（逻辑单一事实源：src/testing/arch-stats.ts）
 *
 * 用法：
 *   `bun run arch:stats`         仅打印实测值与可粘贴片段
 *   `bun run arch:check`         与 docs/ARCHITECTURE.md §1 的声明值比对；不一致 exit 1
 *   `bun run scripts/count-arch-stats.mjs --check`
 *
 * 为什么有 --check（2026-10-20）：
 *   棘轮门禁（tests/unit/docs-consistency.test.ts）只在**跑测试**时生效；实测中曾两次
 *   出现「改了 src/** 却漏跑 arch:stats，直接把不一致的文档提交上去」，靠 CI 事后发现，
 *   每次多一个「红→修→重推」往返。--check 让这一步变成**提交前一条命令**，
 *   可被 .githooks/pre-commit 自动调用。
 *
 * 退出码：0 = 一致；1 = 不一致（打印差异）；2 = 文档结构无法解析。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { archStats, archStatsSnippet } from "../src/testing/arch-stats.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const DOC = path.join(ROOT, "docs", "ARCHITECTURE.md");
const checkMode = process.argv.includes("--check");

const stats = archStats();

if (!checkMode) {
  console.log(JSON.stringify(stats, null, 2));
  console.log(`\n片段：${archStatsSnippet(stats)}`);
  process.exit(0);
}

/** 文档里 §1 的声明形态：**40 模块 / 457 文件 / 122,316 行** */
const DECLARED_RE = /\*\*(\d+) 模块 \/ (\d+) 文件 \/ ([\d,]+) 行\*\*/;
/** 文档里测试数声明形态：**502 个 `*.test.ts`** */
const DECLARED_TESTS_RE = /\*\*(\d+) 个\s*`\*\.test\.ts`\*\*/;

let doc;
try {
  doc = readFileSync(DOC, "utf8");
} catch {
  console.error(`[arch:check] 无法读取 ${DOC}`);
  process.exit(2);
}

const m = doc.match(DECLARED_RE);
const mt = doc.match(DECLARED_TESTS_RE);
if (!m) {
  console.error("[arch:check] docs/ARCHITECTURE.md §1 中未找到「**N 模块 / N 文件 / N 行**」声明");
  process.exit(2);
}
if (!mt) {
  console.error("[arch:check] docs/ARCHITECTURE.md §1 中未找到「**N 个 `*.test.ts`**」声明");
  process.exit(2);
}

const declared = {
  srcModules: Number(m[1]),
  srcFiles: Number(m[2]),
  srcLines: Number(m[3].replace(/,/g, "")),
  testFiles: Number(mt[1]),
};

const diffs = [];
const cmp = (label, declaredValue, actualValue) => {
  if (declaredValue !== actualValue) {
    diffs.push(`${label}: 文档声明 ${declaredValue}，实测 ${actualValue}`);
  }
};
cmp("src 模块数", declared.srcModules, stats.srcModules);
cmp("src 文件数", declared.srcFiles, stats.srcFiles);
cmp("src 行数", declared.srcLines, stats.srcLines);
cmp("tests 文件数", declared.testFiles, stats.testFiles);

if (diffs.length > 0) {
  console.error("[arch:check] ✗ 文档声明与实测不一致（棘轮未同步）：");
  for (const d of diffs) console.error(`  - ${d}`);
  console.error(`\n修复：bun run arch:stats 后按片段更新 docs/ARCHITECTURE.md §1`);
  console.error(`实测片段：${archStatsSnippet(stats)}`);
  process.exit(1);
}

console.log(`[arch:check] ✓ 一致：${archStatsSnippet(stats)}`);
process.exit(0);
