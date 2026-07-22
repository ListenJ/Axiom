#!/usr/bin/env bun
/**
 * 分布式测试运行器 — 三节点集群 PCDA 自动化测试入口
 *
 * 集群节点：
 *   1. Local Dev Machine (本机)
 *   2. Server 192.168.0.150 (SSH: data@192.168.0.150)
 *   3. Remote Node 192.168.0.21 (SSH: git@192.168.0.21)
 *
 * 用法：
 *   bun run scripts/distributed-test-runner.ts [options]
 *
 * 选项：
 *   --local-only        仅使用本地节点（跳过远程 SSH 连接）
 *   --scenarios <list>  逗号分隔的场景列表（默认: hallucination,cross-talk,concurrent-load）
 *   --max-cycles <n>    最大 PCDA 循环次数（默认: 4）
 *   --start-level <n>   起始负载级别 1-4（默认: 1=warmup）
 *   --no-escalate       不自动升级负载级别
 *   --report <path>     报告输出路径（默认: reports/distributed-test-report.md）
 *   --check-ssh         仅检查 SSH 连通性，不执行测试
 */

import {
  PCDAScheduler,
  DistributedTestReporter,
  testSshConnectivity,
  DEFAULT_CLUSTER_CONFIG,
  DEFAULT_PCDA_CONFIG,
  LOAD_LEVELS,
  type ClusterConfig,
  type PCDAConfig,
  type ScenarioType,
} from "../src/testing/index.js";
import { logger } from "../src/utils/logger.js";

// ═══════════════════════════════════════════════════════════════
// 命令行参数解析
// ═══════════════════════════════════════════════════════════════

interface CliArgs {
  localOnly: boolean;
  scenarios: ScenarioType[];
  maxCycles: number;
  startLevel: number;
  autoEscalate: boolean;
  reportPath: string;
  checkSshOnly: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    localOnly: false,
    scenarios: ["hallucination", "cross-talk", "concurrent-load"],
    maxCycles: 4,
    startLevel: 1,
    autoEscalate: true,
    reportPath: "reports/distributed-test-report.md",
    checkSshOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--local-only":
        opts.localOnly = true;
        break;
      case "--scenarios":
        opts.scenarios = (args[++i] ?? "").split(",").filter(Boolean) as ScenarioType[];
        break;
      case "--max-cycles":
        opts.maxCycles = parseInt(args[++i] ?? "4", 10);
        break;
      case "--start-level":
        opts.startLevel = parseInt(args[++i] ?? "1", 10);
        break;
      case "--no-escalate":
        opts.autoEscalate = false;
        break;
      case "--report":
        opts.reportPath = args[++i] ?? opts.reportPath;
        break;
      case "--check-ssh":
        opts.checkSshOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(`
分布式测试运行器 — 三节点集群 PCDA 自动化测试

用法: bun run scripts/distributed-test-runner.ts [options]

选项:
  --local-only        仅使用本地节点（跳过远程 SSH 连接）
  --scenarios <list>  逗号分隔的场景列表（默认: hallucination,cross-talk,concurrent-load）
  --max-cycles <n>    最大 PCDA 循环次数（默认: 4）
  --start-level <n>   起始负载级别 1-4（默认: 1=warmup）
  --no-escalate       不自动升级负载级别
  --report <path>     报告输出路径（默认: reports/distributed-test-report.md）
  --check-ssh         仅检查 SSH 连通性，不执行测试
  --help              显示此帮助信息

负载级别:
  1=warmup (2并发/5请求)  2=normal (5/10)  3=high (10/20)  4=extreme (20/50)
`);
        process.exit(0);
        break;
    }
  }

  return opts;
}

// ═══════════════════════════════════════════════════════════════
// SSH 连通性检查
// ═══════════════════════════════════════════════════════════════

async function checkSshConnectivity(clusterConfig: ClusterConfig): Promise<void> {
  console.log("\n═══ SSH 连通性检查 ═══");
  console.log(`集群: ${clusterConfig.name}\n`);

  for (const node of clusterConfig.nodes) {
    if (node.type === "local") {
      console.log(`  [✓] ${node.name} (${node.id}) — 本地节点`);
      continue;
    }

    if (!node.host || !node.sshUser) {
      console.log(`  [✗] ${node.name} (${node.id}) — 配置缺少 host/sshUser`);
      continue;
    }

    console.log(`  [?] ${node.name} (${node.id}) — 正在连接 ${node.sshUser}@${node.host}...`);
    try {
      const ok = await testSshConnectivity(node.host, node.sshUser, {
        port: node.sshPort ?? 22,
        connectTimeout: 10,
      });
      if (ok) {
        console.log(`  [✓] ${node.name} (${node.id}) — SSH 连接成功`);
      } else {
        console.log(`  [✗] ${node.name} (${node.id}) — SSH 连接失败`);
      }
    } catch (err) {
      console.log(`  [✗] ${node.name} (${node.id}) — SSH 错误: ${(err as Error).message}`);
    }
  }
  console.log("");
}

// ═══════════════════════════════════════════════════════════════
// 构建集群配置
// ═══════════════════════════════════════════════════════════════

function buildClusterConfig(localOnly: boolean): ClusterConfig {
  if (localOnly) {
    return {
      ...DEFAULT_CLUSTER_CONFIG,
      nodes: [DEFAULT_CLUSTER_CONFIG.nodes[0]], // 仅 local
    };
  }
  return DEFAULT_CLUSTER_CONFIG;
}

// ═══════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     分布式测试运行器 — PCDA 自动化测试框架               ║");
  console.log("║     三节点集群: Local + 192.168.0.150 + 192.168.0.21    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const clusterConfig = buildClusterConfig(args.localOnly);

  // SSH 连通性检查
  await checkSshConnectivity(clusterConfig);

  if (args.checkSshOnly) {
    console.log("仅检查 SSH 连通性模式，退出。");
    return;
  }

  // 构建 PCDA 配置
  const pcdaConfig: PCDAConfig = {
    ...DEFAULT_PCDA_CONFIG,
    scenarios: args.scenarios,
    maxCycles: args.maxCycles,
    initialLoadLevel: args.startLevel,
    autoEscalate: args.autoEscalate,
    maxLoadLevel: LOAD_LEVELS.length,
  };

  console.log("═══ PCDA 测试配置 ═══");
  console.log(`  场景: ${args.scenarios.join(", ")}`);
  console.log(`  最大循环: ${args.maxCycles}`);
  console.log(`  起始级别: ${LOAD_LEVELS[args.startLevel - 1]?.name ?? "unknown"}`);
  console.log(`  自动升级: ${args.autoEscalate ? "是" : "否"}`);
  console.log(`  节点数: ${clusterConfig.nodes.length}`);
  console.log("");

  // 创建并运行 PCDA 调度器
  console.log("═══ 启动 PCDA 循环 ═══\n");
  const scheduler = new PCDAScheduler(pcdaConfig, clusterConfig);

  try {
    const cycles = await scheduler.run();

    // 打印每个循环的摘要
    console.log("\n═══ PCDA 循环结果 ═══\n");
    for (const cycle of cycles) {
      const level = cycle.plan?.loadLevel.name ?? "?";
      const passed = cycle.checkResult?.passed ? "PASS" : "FAIL";
      const action = cycle.decision?.action ?? "?";
      const issues = cycle.checkResult?.issues.length ?? 0;
      const metrics = cycle.checkResult?.aggregated;

      console.log(`  循环 #${cycle.cycleId} [${level}] ${passed} → ${action}`);
      if (metrics) {
        console.log(`    请求: ${metrics.totalRequests} | 吞吐: ${metrics.totalThroughput.toFixed(0)} req/s`);
        console.log(`    P95: ${metrics.p95ResponseMs}ms | P99: ${metrics.p99ResponseMs}ms`);
        console.log(`    幻觉率: ${(metrics.hallucinationRate * 100).toFixed(2)}% | 串词率: ${(metrics.crossTalkRate * 100).toFixed(2)}%`);
        console.log(`    错误率: ${(metrics.errorRate * 100).toFixed(2)}% | 问题数: ${issues}`);
      }
      if (issues > 0) {
        for (const issue of cycle.checkResult!.issues) {
          console.log(`    [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`);
        }
      }
      console.log("");
    }

    // 生成报告
    console.log("═══ 生成测试报告 ═══");
    const reporter = new DistributedTestReporter();
    const report = reporter.generateReport(cycles);
    await reporter.saveReport(report, args.reportPath);
    console.log(`  Markdown 报告已保存: ${args.reportPath}`);

    // JSON 报告
    const jsonPath = args.reportPath.replace(/\.md$/, ".json");
    const jsonReport = reporter.generateJsonReport(cycles);
    await reporter.saveReport(jsonReport, jsonPath);
    console.log(`  JSON 报告已保存: ${jsonPath}`);

    // 最终结论
    const allPassed = cycles.every((c) => c.checkResult?.passed);
    const lastAction = cycles[cycles.length - 1]?.decision?.action;

    console.log("\n═══ 最终结论 ═══");
    if (allPassed && lastAction === "pass") {
      console.log("  ✓ 所有负载级别测试通过，系统在极限负载下稳定可靠。");
    } else if (lastAction === "fail") {
      console.log("  ✗ 测试失败：检测到严重问题，需修复后重测。");
    } else {
      console.log(`  △ 测试完成，最终决策: ${lastAction}（请查看报告详情）。`);
    }

    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    logger.error("分布式测试运行失败", err instanceof Error ? err : new Error(String(err)));
    console.error(`\n✗ 测试运行失败: ${(err as Error).message}`);
    process.exit(2);
  }
}

main();
