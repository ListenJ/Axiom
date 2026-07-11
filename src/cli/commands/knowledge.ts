import { getKnowledgeStore } from "../../knowledge/store.js";
import { collectKnowledge } from "../../knowledge/collector.js";

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
