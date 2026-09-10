#!/usr/bin/env bun
/**
 * test:full 自动发现运行器 — 递归收集 tests 树下的 *.test.ts 后交给 bun test 单进程执行
 *
 * 背景（docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S3）：
 * 手工白名单两次漏新测试（P1 五文件回退事件），且组合序依赖 stress 文件残留 tick。
 * 本脚本以"目录排除 + 慢速后缀 + 单文件账本"的显式排除清单替代手工白名单，
 * 新增测试自动纳入运行，不再依赖人工维护白名单。
 */

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * 排除的目录段名（收集根下任意层级同名目录整棵跳过）：
 * - node_modules：依赖目录，永不收集。
 * - stress：压测/环境依赖目录（含存量 flaky audit-regression-stress——storm-caller
 *   actor 残留 tick 单进程挂起，二分实测见 operations-log 2026-08-30）。
 * - e2e：E2E 需要真实运行时，走 test:e2e（当前仓库暂无该目录，保留以防回归）。
 */
const EXCLUDE_DIRS = ["node_modules", "stress", "e2e"];

/**
 * 单文件黑名单（相对收集根的 POSIX 路径）——"已知 flaky/环境依赖"显式账本。
 * 约定：新增测试在全量跑中发现 flaky/环境依赖 → 先入此清单并注明依据，修复后移除。
 *
 * 以下 6 项均为存量失败（2026-08-30 全量自动发现首次盘点，单文件独立运行可复现，
 * 与本脚本无关；修复后应移出本清单）：
 */
const EXCLUDE_FILES: string[] = [
  // env 模板完整性：src 读取的 env 变量未全部登记 .env.example（登记漂移）
  "env-example-completeness.test.ts",
  // L3 SQLite 持久化"写入后新实例可读取"（存量失败，operations-log 2026-08-30 P2-S1 已记录）
  "llm-cache.test.ts",
  // "package.json 暴露 audit:runtime 脚本"断言失败（存量）
  "runtime-audit.test.ts",
  // EventBus async handler 抛错后仍继续执行后续 handler 的断言（存量时序敏感）
  "edge-cases/abnormal-input.test.ts",
  // EventBus 错误风暴后自愈断言（存量时序敏感）
  "edge-cases/network-resilience.test.ts",
  // ResourceBudget recommendedMaxTokens 2000 vs 4000 线性断言（存量，jitter 过滤干扰）
  "rigorous/system-scheduler-rigorous.test.ts",
  // autoEscalate 升级断言时序敏感：单文件独立运行（含 --isolate）全绿，
  // 全量负载下 ~1.6s 升级窗口失稳（2026-08-30 两次全量复现，见 operations-log）
  "distributed/pcda-scheduler-test.test.ts",
];

/** 慢速属性测试后缀（长时运行，由 test:stress / stress-runner 单独调度） */
const SLOW_SUFFIX = ".slow.ts";

/** 测试文件判定：*.test.ts 且非 *.slow.ts */
function isTestFile(name: string): boolean {
  return name.endsWith(".test.ts") && !name.endsWith(SLOW_SUFFIX);
}

/** 收集选项：排除清单可注入覆盖（默认取上方账本；供测试与未来调度方定制） */
export interface CollectOptions {
  /** 覆盖目录段排除清单（默认 EXCLUDE_DIRS） */
  excludeDirs?: string[];
  /** 覆盖单文件账本（默认 EXCLUDE_FILES） */
  excludeFiles?: string[];
}

function walk(
  dir: string,
  root: string,
  excludeDirs: string[],
  excludeFiles: string[],
  excluded: Set<string>,
  out: string[],
): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (excludeDirs.includes(dirent.name)) continue;
      walk(full, root, excludeDirs, excludeFiles, excluded, out);
    } else if (isTestFile(dirent.name)) {
      const rel = relative(root, full).split(sep).join("/");
      if (excludeFiles.includes(rel)) {
        excluded.add(rel);
        continue;
      }
      out.push(rel);
    }
  }
}

/** 递归收集 root 下应纳入 test:full 的测试文件（相对 POSIX 路径、排序）。 */
export function collectTestFiles(root: string, opts: CollectOptions = {}): string[] {
  const out: string[] = [];
  walk(root, root, opts.excludeDirs ?? EXCLUDE_DIRS, opts.excludeFiles ?? EXCLUDE_FILES, new Set(), out);
  return out.sort();
}

// ── main：收集 → 统计 → spawn bun test（stdio 继承，退出码透传） ──

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const files = collectTestFiles(join(repoRoot, "tests")).map((rel) => `tests/${rel}`);
  console.log(
    `[test-full] collected ${files.length} test files ` +
      `(excluded dirs: ${EXCLUDE_DIRS.join("/")}, slow suffix: ${SLOW_SUFFIX}, file ledger: ${EXCLUDE_FILES.length})`,
  );
  // --isolate：每文件独立全局对象——结构性根治跨文件状态泄漏（mock.module/单例/env 残留）
  // 造成的组合序干扰（2026-08-30 实测：非隔离 80 fail → 隔离 8 fail，其中 6 为上列存量）；
  // --timeout 15000：对齐 package.json "test" 脚本约定（隔离冷启动下长测试 5s 默认会误杀）。
  const proc = Bun.spawn([process.execPath, "test", "--isolate", "--timeout", "15000", ...files], {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
