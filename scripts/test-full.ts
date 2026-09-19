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
 * 2026-09-10：2026-08-30 首次盘点的 4 项存量已全部修复移出
 * （llm-cache 拖欠清理 / abnormal-input 与 network-resilience 缺 await /
 *  rigorous 观测点落饱和区 / pcda 端到端用例中性化真实墙钟 p95）。
 * 账本清空；后续新发现 flaky 按约定重新登记。
 */
const EXCLUDE_FILES: string[] = [];

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
  // 透传 --parallel=N：本 collector 是**唯一**的排除口径出处（本地 test 与 CI test:full 共用），
  // 但两者对速度的要求不同 —— CI 串行求稳，本地可并行求快。若不透传，本地就得自建一份排除清单，
  // 那就又回到"两份清单必然漂移"的老问题（2026-09-20 修：本地 test 曾跑 stress/，而 CI 排除它，
  // 导致 stress 重负载用例在本地 15s 超时、在 CI 从不发生）。
  const argv = process.argv.slice(2);
  const parallelArg = argv.find((a) => a.startsWith("--parallel="));
  const passthrough = parallelArg ? [parallelArg] : [];
  if (passthrough.length > 0) console.log(`[test-full] passthrough: ${passthrough.join(" ")}`);

  // --isolate：每文件独立全局对象——结构性根治跨文件状态泄漏（mock.module/单例/env 残留）
  // 造成的组合序干扰（2026-08-30 实测：非隔离 80 fail → 隔离 8 fail，其中 6 为上列存量）；
  // --timeout 15000：对齐 package.json "test" 脚本约定（隔离冷启动下长测试 5s 默认会误杀）。
  const proc = Bun.spawn([process.execPath, "test", "--isolate", "--timeout", "15000", ...passthrough, ...files], {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
