#!/usr/bin/env bun
/**
 * test:smoke — 自动发现 @smoke 标记的快烟囱门禁（秒级反馈，分割工作流）。
 *
 * 复用 test-full.ts 的 collectTestFiles 框架收集全部 *.test.ts（继承 flaky 账本与
 * 目录排除），再按 `@smoke` 标记筛选核心子集（架构红线 + 活跃特性 + 不变量）。
 * 新 smoke 测试在文件头加 `// @smoke` 标记即自动纳入，无需维护手工清单——
 * 避免 test:core 那类手工静态清单漂移漏新测试（P2-S3 已废弃同款模式）。
 *
 * 定位：迭代期秒级反馈门禁；test:full（~4min）仍为 pre-merge 全量门禁。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectTestFiles } from "./test-full.js";

const SMOKE_MARKER = "@smoke";
const repoRoot = join(import.meta.dir, "..");

const allFiles = collectTestFiles(join(repoRoot, "tests"));
const smokeFiles = allFiles.filter((rel) => {
  try {
    // 扫描文件首 4KB（头部注释区），命中 @smoke 标记即纳入
    const head = readFileSync(join(repoRoot, "tests", rel), "utf8").slice(0, 4000);
    return head.includes(SMOKE_MARKER);
  } catch {
    return false;
  }
});

if (smokeFiles.length === 0) {
  console.error("[test-smoke] 未发现 @smoke 标记的测试；在核心测试文件头加 `// @smoke` 标记以纳入烟囱门禁");
  process.exit(1);
}

const files = smokeFiles.map((rel) => `tests/${rel}`);
console.log(`[test-smoke] ${files.length} 个 smoke 测试: ${files.join(", ")}`);
const proc = Bun.spawn([process.execPath, "test", "--isolate", "--timeout", "15000", ...files], {
  cwd: repoRoot,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
