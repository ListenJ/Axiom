import { Database } from "bun:sqlite";
import { searchAggregator } from "../../crawl/search-engines.js";
import { unifiedSearch } from "../../crawl/unified-search.js";
import { DataPipeline } from "../../crawl/data-pipeline.js";
import { getGlobalVault } from "../../memory/vault-manager.js";

export async function handleSearch(args: string[]) {
  const query = args[0];
  if (!query) { console.error("Usage: search <query>"); return; }

  const enginesArg = args.find((a) => a.startsWith("--engines="))?.slice(10)?.split(",") || ["duckduckgo", "searxng"];
  const num = Number(args.find((a) => a.startsWith("--num="))?.slice(6)) || 10;

  console.log(`[搜索] "${query}" via [${enginesArg.join(", ")}]\n`);
  const results = await searchAggregator.searchMulti({ query, num }, enginesArg);
  for (const r of results) {
    console.log(`  ${r.position}. ${r.title}`);
    console.log(`     ${r.link}`);
    console.log(`     ${r.snippet.slice(0, 120)}...`);
    console.log();
  }
  console.log(`共 ${results.length} 条结果`);
}

export async function handleESearch(args: string[]) {
  const query = args[0];
  if (!query) { console.error("Usage: esearch <query> [--mode=quick|deep|news|academic|code] [--num=10]"); return; }

  const mode = args.find((a) => a.startsWith("--mode="))?.slice(7) || "quick";
  const num = Number(args.find((a) => a.startsWith("--num="))?.slice(6)) || 10;

  console.log(`[增强搜索] [${mode}]: "${query}"\n`);

  let results;
  switch (mode) {
    case "deep":
      results = await unifiedSearch.deepSearch(query, num);
      break;
    case "news":
      results = await unifiedSearch.newsSearch(query, num);
      break;
    case "academic":
      results = await unifiedSearch.academicSearch(query, num);
      break;
    case "code":
      results = await unifiedSearch.codeSearch(query, num);
      break;
    default:
      results = await unifiedSearch.quickSearch(query, num);
  }

  for (const r of results) {
    console.log(`  ${r.position}. ${r.title}`);
    console.log(`     ${r.link}`);
    console.log(`     ${r.snippet.slice(0, 120)}...`);
    console.log(`     [相关性] ${(r.relevanceScore * 100).toFixed(0)}% | 来源: ${r.engine}`);
    console.log();
  }
  console.log(`共 ${results.length} 条结果`);
}

export async function handleSearchSuggestions(args: string[], dbPath: string) {
  const partial = args[0];
  if (!partial) { console.error("Usage: search:suggestions <partial_query>"); return; }

  const suggestionsDb = new Database(dbPath);
  const rows = suggestionsDb.query("SELECT DISTINCT query FROM search_history WHERE query LIKE ? ORDER BY created_at DESC LIMIT 10").all(`${partial}%`) as { query: string }[];
  suggestionsDb.close();
  const suggestions = rows.map(r => r.query);
  console.log(`搜索建议 for "${partial}":\n`);
  suggestions.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}

export async function handleSearchStats(args: string[], dbPath: string) {
  const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7)) || 7;
  const stats = unifiedSearch.getStats(days);

  console.log(`[搜索统计] (最近 ${days} 天)\n`);
  console.log(`总搜索次数: ${stats.totalSearches}`);
  console.log(`唯一查询: ${stats.uniqueQueries}`);
  console.log(`平均结果数: ${stats.avgResults}`);
  console.log(`平均延迟: ${stats.avgLatency}ms\n`);

  console.log("[热门查询]");
  stats.topQueries.forEach((q, i) => console.log(`  ${i + 1}. ${q.query} (${q.count}次)`));

  const statsDb = new Database(dbPath);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const topEngines = statsDb.query(`
    SELECT engines as engine, COUNT(*) as count FROM search_history
    WHERE created_at >= ? GROUP BY engines ORDER BY count DESC LIMIT 10
  `).all(since) as { engine: string; count: number }[];
  statsDb.close();
  console.log("\n[引擎使用]");
  topEngines.forEach((e, i) => console.log(`  ${i + 1}. ${e.engine} (${e.count}次)`));
}

export async function handleSearchHistory(args: string[]) {
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 50;
  const history = unifiedSearch.getHistory(limit);

  console.log(`[最近 ${history.length} 条搜索历史]\n`);
  history.forEach((h, i) => {
    console.log(`  ${i + 1}. [${new Date(h.createdAt).toLocaleString()}] "${h.query}"`);
    console.log(`     引擎: ${h.engines} | 结果: ${h.resultCount} | 耗时: ${h.latencyMs}ms`);
  });
}

export async function handleSearchClear() {
  unifiedSearch.clearCache();
  unifiedSearch.clearHistory();
  console.log("[完成] 搜索缓存和历史已清除");
}

export async function handleFetch(args: string[]) {
  const url = args[0];
  if (!url) { console.error("Usage: fetch <url>"); return; }

  const pipeline = new DataPipeline();
  console.log(`[抓取] ${url}\n`);
  const result = await pipeline.crawlStructured(url);
  if (!result) { console.error("抓取失败"); return; }

  console.log(`标题: ${result.title}`);
  console.log(`站点: ${result.siteName}`);
  console.log(`语言: ${result.language}`);
  console.log(`描述: ${result.description?.slice(0, 200) || "无"}`);
  console.log(`\n结构化数据类型: ${result.structuredData.map((d: { "@type"?: string }) => d["@type"] || "Unknown").join(", ") || "无"}`);
  console.log(`标题层级: ${result.headings.length} 个`);
  console.log(`表格: ${result.tables.length} 个`);
  console.log(`代码块: ${result.codeBlocks.length} 个`);
  console.log(`图片: ${result.images.length} 个`);
  console.log(`链接: ${result.links.length} 个`);
  console.log(`内容分块: ${result.chunks.length} 个`);
  console.log(`\n--- Markdown 预览 (前 800 字符) ---\n${result.markdown.slice(0, 800)}...`);
}

export async function handleVaultSearch(args: string[]) {
  const query = args[0];
  if (!query) { console.error("Usage: vault:search <query>"); return; }
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 10;
  const para = args.find((a) => a.startsWith("--para="))?.slice(7);
  const vault = getGlobalVault();
  const results = vault.search(query, { limit, paraCategory: para });
  console.log(`[搜索] Vault 搜索结果: "${query}" (${results.length} 条)\n`);
  for (const r of results) {
    console.log(`  [${r.score.toFixed(1)}] ${r.note.title}`);
    console.log(`      [文件] ${r.note.path}`);
    console.log(`      [标签] ${r.note.tags.join(", ") || "无标签"}`);
    console.log(`      [原因] ${r.reasons.join("; ")}`);
    console.log(`      [摘要] ${r.excerpt.slice(0, 120)}...`);
    console.log();
  }
}

export async function handleVaultRead(args: string[]) {
  const notePath = args[0];
  if (!notePath) { console.error("Usage: vault:read <path>"); return; }
  const vault = getGlobalVault();
  const note = vault.readNote(notePath);
  if (!note) { console.error("笔记不存在:"); return; }
  console.log(`--- ${notePath} ---\n`);
  console.log("frontmatter:", JSON.stringify(note.frontmatter, null, 2));
  console.log("\n--- 内容 ---\n");
  console.log(note.content.slice(0, 3000));
  if (note.content.length > 3000) console.log("\n... (截断)");
}

export async function handleVaultPara(args: string[]) {
  const category = args[0];
  if (!category) { console.error("Usage: vault:para <category>"); return; }
  const vault = getGlobalVault();
  const notes = vault.browsePara(category);
  console.log(`[PARA] / ${category} (${notes.length} 条)\n`);
  for (const n of notes.slice(0, 30)) {
    console.log(`  ${n.title} — ${n.path} [${n.tags.join(", ") || "无标签"}]`);
  }
  if (notes.length > 30) console.log(`  ... 还有 ${notes.length - 30} 条`);
}

export async function handleVaultStats() {
  const vault = getGlobalVault();
  const stats = vault.stats();
  console.log("[统计] Vault 统计:\n");
  console.log(`  总笔记数: ${stats.totalNotes}`);
  console.log(`  总词数: ${stats.totalWords}`);
  console.log(`  总标签数: ${stats.totalTags}`);
  console.log(`  总 wiki-link: ${stats.totalLinks}`);
  console.log("  PARA 分布:");
  for (const [type, count] of Object.entries(stats.paraDistribution)) {
    console.log(`    ${type}: ${count}`);
  }
}

export async function handleVaultIndexCode() {
  const vault = getGlobalVault();
  console.log("[索引] 正在索引代码...");
  const result = await vault.indexCode();
  console.log(`[索引完成] ${result.indexed} 个文件`);
  if (result.errors.length) console.log(`[错误] ${result.errors.join(", ")}`);
}

export async function handleDistill(args: string[]) {
  const title = args[0];
  const content = args.slice(1).join(" ");
  if (!title || !content) { console.error("Usage: distill <title> <content>"); return; }
  const { MemoryDistiller } = await import("../../memory/distiller.js");
  const distiller = new MemoryDistiller();
  const path = await distiller.distillManual(title, content, {
    source: "cli-manual",
    sourceType: "manual",
  });
  console.log(`[原子笔记已创建] ${path}`);
}
