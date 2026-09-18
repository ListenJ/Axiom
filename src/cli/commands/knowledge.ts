import { getKnowledgeStore } from "../../knowledge/store.js";
import { collectKnowledge } from "../../knowledge/collector.js";
import { runPipeline } from "../../knowledge/pipeline.js";
import { getKnowledgeUpdater } from "../../knowledge/auto-updater.js";

export async function handleKnowledgeCollect(args: string[]) {
  const domain = args.find((a) => a.startsWith("--domain="))?.slice(9);
  if (!domain) {
    console.error("Usage: knowledge:collect --domain=mathematics|computer-science|philosophy|dictionary [--subdomain=<topic>] [--max=5] [--force]");
    console.error("  Domains: mathematics, computer-science, philosophy, dictionary");
    console.error("  Subdomains:");
    console.error("    mathematics: advanced-math, probability, linear-algebra");
    console.error("    computer-science: os, comp-arch, networking, compilers, gpu-programming, data-structures");
    console.error("    philosophy: ethics, logic, epistemology, metaphysics");
    return;
  }

  const subdomain = args.find((a) => a.startsWith("--subdomain="))?.slice(12) || "";
  const maxSources = Number(args.find((a) => a.startsWith("--max="))?.slice(6)) || 5;
  const force = args.includes("--force");

  console.log(`[知识收集] domain=${domain}${subdomain ? ` subdomain=${subdomain}` : ""} max=${maxSources} force=${force}\n`);

  const result = await collectKnowledge({
    domain,
    subdomain: subdomain || undefined,
    maxSources,
    force,
  });

  console.log(`[收集完成]\n`);
  console.log(`  领域:     ${result.domain}/${result.subdomain}`);
  console.log(`  已搜索:   ${result.searched}`);
  console.log(`  已收集:   ${result.collected}`);
  console.log(`  已跳过:   ${result.skipped}`);
  console.log(`  失败:     ${result.failed}`);
  console.log(`  耗时:     ${result.durationMs}ms\n`);

  if (result.sources.length > 0) {
    console.log("[收集的源]");
    for (const s of result.sources) {
      console.log(`  · ${s.title}`);
      console.log(`    质量: ${(s.quality * 100).toFixed(0)}% | ${s.url}`);
    }
  }
}

export async function handleKnowledgeStats() {
  const store = getKnowledgeStore();
  const stats = store.stats();

  console.log("[知识统计]\n");
  console.log(`  知识源总数:     ${stats.totalSources}`);
  console.log(`  词典条目数:     ${stats.totalDictionary}\n`);

  if (Object.keys(stats.byDomain).length > 0) {
    console.log("[按领域]");
    for (const [domain, count] of Object.entries(stats.byDomain)) {
      console.log(`  ${domain.padEnd(20)} ${count}`);
    }
  }
}

export async function handleKnowledgePipeline(args: string[]): Promise<void> {
  const flags: Record<string, string> = {}
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=")
      flags[k] = v ?? "true"
    }
  }

  const result = await runPipeline({
    githubTrending: flags["github"] === "true",
    bookTopics: flags["topics"] ? flags["topics"].split(",") : undefined,
    pdfWorkerUrl: flags["pdf-worker"] || undefined,
    convertPdf: flags["convert"] === "true",
  })

  console.log(`\nPipeline Results:`)
  console.log(`  GitHub repos:  ${result.githubReposCollected}`)
  console.log(`  Books:         ${result.booksDiscovered}`)
  console.log(`  PDFs converted: ${result.pdfsConverted}`)
  console.log(`  Notes written: ${result.notesWritten}`)
  console.log(`  Duration:      ${(result.durationMs / 1000).toFixed(1)}s`)
  if (result.errors.length > 0) {
    console.log(`  Errors:        ${result.errors.length}`)
    for (const e of result.errors) console.log(`    - ${e}`)
  }
}

// ─── 自动更新机制 CLI ─────────────────────────────────────────────────────

/**
 * 启动知识库自动更新定时器
 * 用法: knowledge:autoupdate:start [--interval=3600000] [--domains=mathematics,computer-science]
 *        [--max=3] [--quality=0.3] [--run-on-start]
 */
export function handleKnowledgeAutoupdateStart(args: string[]): void {
  const intervalMs = Number(args.find((a) => a.startsWith("--interval="))?.slice(11)) || undefined;
  const domainsArg = args.find((a) => a.startsWith("--domains="))?.slice(10);
  const domains = domainsArg ? domainsArg.split(",") : undefined;
  const maxSources = Number(args.find((a) => a.startsWith("--max="))?.slice(6)) || undefined;
  const qualityThreshold = Number(args.find((a) => a.startsWith("--quality="))?.slice(10)) || undefined;
  const runOnStart = args.includes("--run-on-start");

  const updater = getKnowledgeUpdater();
  updater.updateConfig({
    ...(intervalMs ? { intervalMs } : {}),
    ...(domains ? { domains } : {}),
    ...(maxSources ? { maxSourcesPerSubdomain: maxSources } : {}),
    ...(qualityThreshold ? { qualityThreshold } : {}),
    runOnStart,
  });
  updater.start();

  console.log("[自动更新] 已启动");
  console.log(`  间隔: ${updater.getStats().isRunning ? "running" : "stopped"}`);
}

/** 停止自动更新定时器 */
export function handleKnowledgeAutoupdateStop(): void {
  const updater = getKnowledgeUpdater();
  updater.stop();
  console.log("[自动更新] 已停止");
}

/** 显示自动更新状态 */
export function handleKnowledgeAutoupdateStatus(): void {
  const updater = getKnowledgeUpdater();
  const stats = updater.getStats();
  const lastReport = updater.getLastReport();
  const reports = updater.getReports();

  console.log("[自动更新状态]\n");
  console.log(`  运行中:         ${stats.isRunning ? "是" : "否"}`);
  console.log(`  知识源总数:     ${stats.totalSources}`);
  console.log(`  词典条目数:     ${stats.totalDictionary}`);
  console.log(`  历史报告数:     ${reports.length}`);

  if (Object.keys(stats.byDomain).length > 0) {
    console.log("\n[按领域]");
    for (const [domain, count] of Object.entries(stats.byDomain)) {
      console.log(`  ${domain.padEnd(20)} ${count}`);
    }
  }

  if (lastReport) {
    console.log("\n[上次更新]");
    console.log(`  域:             ${lastReport.domain}/${lastReport.subdomain}`);
    console.log(`  时间:           ${new Date(lastReport.timestamp).toISOString()}`);
    console.log(`  耗时:           ${lastReport.durationMs}ms`);
    console.log(`  已搜索/收集/跳过/失败: ${lastReport.searched}/${lastReport.collected}/${lastReport.skipped}/${lastReport.failed}`);
    if (lastReport.errors.length > 0) {
      console.log(`  错误:`);
      for (const e of lastReport.errors) console.log(`    - ${e}`);
    }
  }
}

/** 手动触发一次更新 (不依赖定时器) */
export async function handleKnowledgeAutoupdateRun(args: string[]): Promise<void> {
  const domainsArg = args.find((a) => a.startsWith("--domains="))?.slice(10);
  const domains = domainsArg ? domainsArg.split(",") : undefined;
  const maxSources = Number(args.find((a) => a.startsWith("--max="))?.slice(6)) || undefined;
  const qualityThreshold = Number(args.find((a) => a.startsWith("--quality="))?.slice(10)) || undefined;

  const updater = getKnowledgeUpdater();
  if (domains || maxSources || qualityThreshold) {
    updater.updateConfig({
      ...(domains ? { domains } : {}),
      ...(maxSources ? { maxSourcesPerSubdomain: maxSources } : {}),
      ...(qualityThreshold ? { qualityThreshold } : {}),
    });
  }

  console.log("[自动更新] 手动触发更新...\n");
  const reports = await updater.runUpdate();

  console.log(`[更新完成] ${reports.length} 个子域报告\n`);
  const totals = reports.reduce(
    (acc, r) => ({
      searched: acc.searched + r.searched,
      collected: acc.collected + r.collected,
      skipped: acc.skipped + r.skipped,
      failed: acc.failed + r.failed,
    }),
    { searched: 0, collected: 0, skipped: 0, failed: 0 },
  );
  console.log(`  已搜索: ${totals.searched}`);
  console.log(`  已收集: ${totals.collected}`);
  console.log(`  已跳过: ${totals.skipped}`);
  console.log(`  失败:   ${totals.failed}\n`);

  for (const r of reports) {
    const status = r.failed > 0 ? "⚠" : "✓";
    console.log(`  ${status} ${r.domain}/${r.subdomain}: ${r.collected} collected, ${r.failed} failed (${r.durationMs}ms)`);
  }
}
