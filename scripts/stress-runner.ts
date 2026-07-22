/**
 * 代码级压测运行器 — 统一调度 stress / perf 测试，收集性能指标，输出结构化报告
 *
 * 用法：
 *   bun run scripts/stress-runner.ts                    # 运行全部压测，输出报告
 *   bun run scripts/stress-runner.ts --baseline         # 运行并保存为基线
 *   bun run scripts/stress-runner.ts --compare          # 与基线对比，检测性能回归
 *   bun run scripts/stress-runner.ts --suite=stress     # 只运行 stress 套件
 *   bun run scripts/stress-runner.ts --suite=perf       # 只运行 perf 套件
 *   bun run scripts/stress-runner.ts --suite=gate       # 只运行性能门禁
 *
 * 输出：
 *   reports/stress/<timestamp>.json   — 完整 JSON 报告
 *   reports/stress/latest.json        — 最新报告软链接（Windows 下为副本）
 *   reports/stress/baseline.json      — 基线报告（--baseline 时生成）
 *   stdout                            — ASCII 摘要表格
 *
 * 性能指标阈值定义在 THRESHOLDS 中，可根据项目需求调整。
 */

import { spawn } from "bun";
import { mkdir, writeFile, copyFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  name: string;
  suite: string;
  durationMs: number;
  passed: boolean;
  /** 从 console.log 中提取的性能指标 */
  metrics: PerfMetric[];
  errorMessage?: string;
}

interface PerfMetric {
  /** 指标名，如 "5000 atoms create" / "cache.getOrSet" */
  label: string;
  /** 测量值（ms） */
  valueMs: number;
  /** 吞吐量（ops/s），可选 */
  throughput?: number;
  /** 内存增量（MB），可选 */
  memDeltaMb?: number;
}

interface StressReport {
  timestamp: string;
  gitCommit: string;
  bunVersion: string;
  platform: string;
  totalDurationMs: number;
  totalTests: number;
  passed: number;
  failed: number;
  regressionCount: number;
  testCases: TestCase[];
  thresholdViolations: ThresholdViolation[];
}

interface ThresholdViolation {
  metric: string;
  actual: number;
  threshold: number;
  suite: string;
  testCase: string;
  /** "regression" = 比基线慢, "threshold" = 超过绝对阈值 */
  type: "regression" | "threshold";
  /** 回归百分比（type=regression 时有效） */
  regressionPct?: number;
}

// ═══════════════════════════════════════════════════════════════
// 压测套件配置
// ═══════════════════════════════════════════════════════════════

interface SuiteConfig {
  name: string;
  testFiles: string[];
  description: string;
  timeoutMs: number;
}

const SUITES: Record<string, SuiteConfig> = {
  stress: {
    name: "stress",
    testFiles: ["tests/stress/extreme-stress.test.ts"],
    description: "极限压力测试 — Scheduler/AtomEngine/KnowledgeNetwork/ReasoningGraph/LLMClient/ConsciousnessStream/CapabilityRegistry/Memory",
    timeoutMs: 120000,
  },
  perf: {
    name: "perf",
    testFiles: ["tests/perf-benchmark.test.ts"],
    description: "性能基准 — Cache/ThompsonRouter/ConstraintSolver/VaultManager/ConfigCenter/EventBus 热路径",
    timeoutMs: 60000,
  },
  gate: {
    name: "gate",
    testFiles: ["tests/stress/perf-gate.test.ts"],
    description: "性能门禁 — 统一阈值断言，CI 性能回归检测",
    timeoutMs: 60000,
  },
};

// ═══════════════════════════════════════════════════════════════
// 性能阈值（绝对上限，单位 ms）
// 超过即标记为 threshold violation
// ═══════════════════════════════════════════════════════════════

const THRESHOLDS: Record<string, number> = {
  // extreme-stress 阈值
  "500 tasks": 5000,
  "1000 rapid cycles": 3000,
  "5000 atoms create": 2000,
  "query 5000 atoms by kind": 100,
  "delete 1000 atoms": 500,
  "search 5000 atoms by content": 100,
  "2000 entities + 5000 links": 3000,
  "delete 500 entities with link cascade": 2000,
  "5000 nodes graph": 3000,
  "Gap detection 1500 nodes": 1000,
  "50 concurrent failures": 5000,
  "5000 steps": 10000,
  "1000 diverse steps": 5000,
  "1000 caps + 500 selects": 2000,
  // perf-benchmark 阈值
  "cache100k": 200,
  "cacheLRU 10k": 100,
  "thompson50k": 500,
  "solver50k": 500,
  "pipeline10k-empty": 100,
  "eventBus100k": 50,
  "configCenter50k": 100,
  "vault10k-writes": 200,
  "vault10k-search": 500,
};

/** 性能回归容忍度：比基线慢 X% 才标记为 regression */
const REGRESSION_TOLERANCE_PCT = 20;

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

const REPORTS_DIR = path.resolve(import.meta.dir, "..", "reports", "stress");

async function getGitCommit(): Promise<string> {
  try {
    const proc = spawn({
      cmd: ["git", "rev-parse", "--short", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.resolve(import.meta.dir, ".."),
    });
    const text = await new Response(proc.stdout).text();
    return text.trim();
  } catch {
    return "unknown";
  }
}

/**
 * 从 bun test 的输出中解析性能指标。
 * 匹配格式：
 *   [Stress] 500 tasks: 1234ms, mem delta: 5MB
 *   [Gate] cacheSetGet_10k: 14.38ms / 200ms threshold
 *   cache100k: total=123.45ms, 0.001234ms/op
 *   thompson50k: 456.78ms, 0.009136ms/route
 */
function parseMetricsFromOutput(output: string): PerfMetric[] {
  const metrics: PerfMetric[] = [];
  const seenLabels = new Set<string>();

  // 模式 1: [Stress] <label>: <value>ms[, mem delta: <N>MB]
  const stressPattern = /\[Stress\]\s+(.+?):\s*([\d.]+)ms(?:.*?mem delta:\s*(-?[\d.]+)MB)?/g;
  let match: RegExpExecArray | null;
  while ((match = stressPattern.exec(output)) !== null) {
    const label = match[1].trim();
    metrics.push({
      label,
      valueMs: parseFloat(match[2]),
      memDeltaMb: match[3] ? parseFloat(match[3]) : undefined,
    });
    seenLabels.add(label);
  }

  // 模式 1b: [Gate] <label>: <value>ms / <threshold>ms threshold
  const gatePattern = /\[Gate\]\s+(.+?):\s*([\d.]+)ms(?:\s*\/\s*([\d.]+)ms)?/g;
  while ((match = gatePattern.exec(output)) !== null) {
    const label = match[1].trim();
    if (!seenLabels.has(label)) {
      metrics.push({ label, valueMs: parseFloat(match[2]) });
      seenLabels.add(label);
    }
  }

  // 模式 2: <label>: total=<value>ms 或 <label>: <value>ms（必须行首有缩进）
  const totalPattern = /^\s+(.+?):\s*(?:total=)?([\d.]+)ms/gm;
  while ((match = totalPattern.exec(output)) !== null) {
    const label = match[1].trim();
    const valueMs = parseFloat(match[2]);
    if (!seenLabels.has(label)) {
      metrics.push({ label, valueMs });
      seenLabels.add(label);
    }
  }

  // 模式 3: 吞吐量 — <value>ms/op 或 <value>ms/route 或 <value>ms/iter
  const throughputPattern = /([\d.]+)ms\/(op|route|iter|search|write|publish|check|set)/g;
  while ((match = throughputPattern.exec(output)) !== null) {
    const msPerOp = parseFloat(match[1]);
    if (msPerOp > 0) {
      metrics.push({
        label: `per-${match[2]}`,
        valueMs: msPerOp,
        throughput: Math.round(1000 / msPerOp),
      });
    }
  }

  return metrics;
}

/**
 * 运行单个测试文件，返回结果。
 */
async function runTestFile(
  testFile: string,
  suiteName: string,
  timeoutMs: number,
): Promise<TestCase> {
  const projectRoot = path.resolve(import.meta.dir, "..");
  const fullPath = path.resolve(projectRoot, testFile);

  if (!existsSync(fullPath)) {
    return {
      name: testFile,
      suite: suiteName,
      durationMs: 0,
      passed: false,
      metrics: [],
      errorMessage: `File not found: ${fullPath}`,
    };
  }

  const start = performance.now();
  const proc = spawn({
    cmd: ["bun", "test", testFile],
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "test", FORCE_COLOR: "0" },
  });

  // 超时控制
  const timeoutPromise = new Promise<{ stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      setTimeout(() => {
        try { proc.kill(); } catch { /* already exited */ }
        resolve({ stdout: "", stderr: "TIMEOUT", timedOut: true });
      }, timeoutMs);
    },
  );

  const outputPromise = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([stdout, stderr]) => ({ stdout, stderr, timedOut: false }));

  const { stdout, stderr, timedOut } = await Promise.race([outputPromise, timeoutPromise]);
  const durationMs = performance.now() - start;

  const combinedOutput = stdout + "\n" + stderr;
  const metrics = parseMetricsFromOutput(combinedOutput);

  // 判断通过/失败
  const passed = !timedOut && !/\b(fail|FAIL)\b/.test(stdout) && !stderr.includes("TIMEOUT");

  return {
    name: testFile,
    suite: suiteName,
    durationMs,
    passed,
    metrics,
    errorMessage: timedOut ? `Timed out after ${timeoutMs}ms` : (passed ? undefined : stderr.slice(0, 500)),
  };
}

/**
 * 与基线对比，检测性能回归。
 *
 * 过滤规则（避免噪声误报）:
 *  1. 噪声地板：基线值 < 1ms 时不参与回归对比（亚毫秒级测量抖动过大）
 *  2. 标签冲突：跳过 per-iter / per-op / per-route 等吞吐量派生标签
 *     （多个不同测试会产生同名标签，导致跨测试错误对比）
 *  3. 模块导入时间：跳过 `import xxx` 标签（受 FS 缓存影响，非真实性能）
 */
function detectRegressions(
  current: StressReport,
  baseline: StressReport,
): ThresholdViolation[] {
  const violations: ThresholdViolation[] = [];

  // 噪声地板：基线值低于此阈值时不参与回归对比
  const NOISE_FLOOR_MS = 1;
  // 跳过的标签前缀（吞吐量派生指标，标签会冲突）
  const SKIP_PREFIXES = ["per-", "import "];

  // 构建基线指标索引：suite:label → valueMs
  const baselineIndex = new Map<string, number>();
  for (const tc of baseline.testCases) {
    for (const m of tc.metrics) {
      baselineIndex.set(`${tc.suite}:${m.label}`, m.valueMs);
    }
  }

  for (const tc of current.testCases) {
    for (const m of tc.metrics) {
      // 跳过冲突标签
      if (SKIP_PREFIXES.some((p) => m.label.startsWith(p))) continue;

      const key = `${tc.suite}:${m.label}`;
      const baselineValue = baselineIndex.get(key);
      if (baselineValue === undefined) continue;

      // 噪声地板过滤
      if (baselineValue < NOISE_FLOOR_MS) continue;

      const regressionPct = ((m.valueMs - baselineValue) / baselineValue) * 100;
      if (regressionPct > REGRESSION_TOLERANCE_PCT) {
        violations.push({
          metric: m.label,
          actual: m.valueMs,
          threshold: baselineValue,
          suite: tc.suite,
          testCase: tc.name,
          type: "regression",
          regressionPct: Math.round(regressionPct),
        });
      }
    }
  }

  return violations;
}

/**
 * 检查绝对阈值违规。
 */
function checkThresholds(report: StressReport): ThresholdViolation[] {
  const violations: ThresholdViolation[] = [];

  for (const tc of report.testCases) {
    for (const m of tc.metrics) {
      const threshold = THRESHOLDS[m.label];
      if (threshold !== undefined && m.valueMs > threshold) {
        violations.push({
          metric: m.label,
          actual: m.valueMs,
          threshold,
          suite: tc.suite,
          testCase: tc.name,
          type: "threshold",
        });
      }
    }
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════
// ASCII 报告输出
// ═══════════════════════════════════════════════════════════════

function printAsciiSummary(report: StressReport): void {
  const W = 80;
  const line = "═".repeat(W);
  console.log(`\n${line}`);
  console.log("  代码级压测报告 — Code-Level Stress Test Report");
  console.log(line);
  console.log(`  时间:     ${report.timestamp}`);
  console.log(`  Commit:   ${report.gitCommit}`);
  console.log(`  Bun:      ${report.bunVersion}`);
  console.log(`  平台:     ${report.platform}`);
  console.log(`  总耗时:   ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  测试数:   ${report.totalTests} (pass: ${report.passed}, fail: ${report.failed})`);
  console.log(line);

  // 按套件分组输出
  const suites = [...new Set(report.testCases.map((tc) => tc.suite))];
  for (const suite of suites) {
    const cases = report.testCases.filter((tc) => tc.suite === suite);
    console.log(`\n  ┌─ ${suite.toUpperCase()} (${cases.length} files)`);
    for (const tc of cases) {
      const status = tc.passed ? "✓" : "✗";
      const dur = `${tc.durationMs.toFixed(0)}ms`;
      console.log(`  │ ${status} ${tc.name.padEnd(50)} ${dur.padStart(8)}`);
      for (const m of tc.metrics) {
        const threshold = THRESHOLDS[m.label];
        const thresholdMark = threshold ? (m.valueMs > threshold ? " ⚠OVER" : "") : "";
        const memStr = m.memDeltaMb !== undefined ? `, mem: ${m.memDeltaMb}MB` : "";
        const tpStr = m.throughput !== undefined ? `, ${m.throughput} ops/s` : "";
        console.log(`  │     ${m.label.padEnd(48)} ${m.valueMs.toFixed(2).padStart(8)}ms${memStr}${tpStr}${thresholdMark}`);
      }
      if (tc.errorMessage) {
        console.log(`  │     ERROR: ${tc.errorMessage.slice(0, 70)}`);
      }
    }
  }

  // 阈值违规
  if (report.thresholdViolations.length > 0) {
    console.log(`\n  ┌─ THRESHOLD VIOLATIONS (${report.thresholdViolations.length})`);
    for (const v of report.thresholdViolations) {
      if (v.type === "threshold") {
        console.log(`  │ ⚠ ${v.metric}: ${v.actual.toFixed(2)}ms > ${v.threshold}ms (absolute threshold)`);
      } else {
        console.log(`  │ ⚠ ${v.metric}: ${v.actual.toFixed(2)}ms vs baseline ${v.threshold.toFixed(2)}ms (+${v.regressionPct}%)`);
      }
    }
  } else {
    console.log(`\n  ✓ 无阈值违规 / No threshold violations`);
  }

  console.log(`\n${line}`);
  const overall = report.failed === 0 && report.thresholdViolations.length === 0;
  console.log(`  总体结果: ${overall ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`${line}\n`);
}

// ═══════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isBaseline = args.includes("--baseline");
  const isCompare = args.includes("--compare");
  const suiteArg = args.find((a) => a.startsWith("--suite="));
  const suiteFilter = suiteArg ? suiteArg.split("=")[1] : null;

  // 确定要运行的套件
  const suitesToRun = suiteFilter
    ? [SUITES[suiteFilter]].filter(Boolean)
    : Object.values(SUITES);

  if (suitesToRun.length === 0) {
    console.error(`Unknown suite: ${suiteFilter}. Available: ${Object.keys(SUITES).join(", ")}`);
    process.exit(1);
  }

  console.log("stress-runner: 开始代码级压测...");
  console.log(`suites: ${suitesToRun.map((s) => s.name).join(", ")}`);
  console.log(`mode: ${isBaseline ? "baseline" : isCompare ? "compare" : "normal"}\n`);

  // 确保报告目录存在
  await mkdir(REPORTS_DIR, { recursive: true });

  // 运行所有测试文件
  const testCases: TestCase[] = [];
  const totalStart = performance.now();

  for (const suite of suitesToRun) {
    console.log(`\n── ${suite.name.toUpperCase()} ── ${suite.description}`);
    for (const testFile of suite.testFiles) {
      console.log(`  running ${testFile}...`);
      const result = await runTestFile(testFile, suite.name, suite.timeoutMs);
      testCases.push(result);
      console.log(`  ${result.passed ? "✓" : "✗"} ${testFile} (${result.durationMs.toFixed(0)}ms, ${result.metrics.length} metrics)`);
    }
  }

  const totalDurationMs = performance.now() - totalStart;

  // 构建报告
  const report: StressReport = {
    timestamp: new Date().toISOString(),
    gitCommit: await getGitCommit(),
    bunVersion: Bun.version,
    platform: `${process.platform}/${process.arch}`,
    totalDurationMs,
    totalTests: testCases.length,
    passed: testCases.filter((tc) => tc.passed).length,
    failed: testCases.filter((tc) => !tc.passed).length,
    regressionCount: 0,
    testCases,
    thresholdViolations: [],
  };

  // 绝对阈值检查
  report.thresholdViolations = checkThresholds(report);

  // 基线对比
  if (isCompare) {
    const baselinePath = path.join(REPORTS_DIR, "baseline.json");
    if (existsSync(baselinePath)) {
      const baselineData = await readFile(baselinePath, "utf-8");
      const baseline = JSON.parse(baselineData) as StressReport;
      const regressions = detectRegressions(report, baseline);
      report.thresholdViolations.push(...regressions);
      report.regressionCount = regressions.length;
      console.log(`\nbaseline comparison: ${regressions.length} regression(s) detected (tolerance: ${REGRESSION_TOLERANCE_PCT}%)`);
    } else {
      console.log(`\n⚠ No baseline found at ${baselinePath}, skipping regression comparison.`);
      console.log(`  Run with --baseline first to establish a baseline.`);
    }
  }

  // 保存报告
  const timestamp = report.timestamp.replace(/[:.]/g, "-");
  const reportPath = path.join(REPORTS_DIR, `${timestamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  // 保存 latest.json（Windows 不支持符号链接，用副本）
  const latestPath = path.join(REPORTS_DIR, "latest.json");
  await copyFile(reportPath, latestPath);

  // 保存 baseline.json
  if (isBaseline) {
    const baselinePath = path.join(REPORTS_DIR, "baseline.json");
    await copyFile(reportPath, baselinePath);
    console.log(`\nbaseline saved: ${baselinePath}`);
  }

  // 打印 ASCII 摘要
  printAsciiSummary(report);

  console.log(`report saved: ${reportPath}`);
  console.log(`latest:       ${latestPath}`);

  // 退出码：有失败或阈值违规则非零
  const hasFailures = report.failed > 0 || report.thresholdViolations.length > 0;
  process.exit(hasFailures ? 1 : 0);
}

main().catch((err) => {
  console.error("stress-runner fatal error:", err);
  process.exit(2);
});
