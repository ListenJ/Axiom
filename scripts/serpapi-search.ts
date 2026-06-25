#!/usr/bin/env bun
/**
 * SerpAPI 搜索 CLI
 * 用法:
 *   bun run scripts/serpapi-search.ts --query="Coffee" --location="Austin, Texas"
 *   bun run scripts/serpapi-search.ts -q "OpenAI" -l "Beijing" --hl=zh-CN --gl=cn
 *   bun run scripts/serpapi-search.ts --query="TypeScript tutorial" --num=20
 */

import { parseArgs } from "util";
import { Database } from "bun:sqlite";
import { SerpApiClient, type SerpApiSearchParams } from "../src/crawl/serpapi-client.js";
import { VaultManager } from "../src/memory/vault-manager.js";
import { logger } from "../src/utils/logger.js";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    query: { type: "string", short: "q" },
    location: { type: "string", short: "l" },
    google_domain: { type: "string" },
    hl: { type: "string", default: "en" },
    gl: { type: "string", default: "us" },
    num: { type: "string", default: "10" },
    safe: { type: "string", default: "active" },
    device: { type: "string", default: "desktop" },
    tbs: { type: "string" },
    site: { type: "string" },
    save: { type: "boolean", default: true },
    vault: { type: "string", default: "./openclaw-memory" },
    db: { type: "string", default: "./data/agent.db" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
  allowPositionals: true,
});

if (values.help || (!values.query && positionals.length === 0)) {
  console.log(`
[SerpAPI] 搜索 CLI (OpenClaw)

用法:
  bun run scripts/serpapi-search.ts [选项]

选项:
  -q, --query <text>        搜索关键词 (必填)
  -l, --location <text>     地理位置，如 "Austin, Texas, United States"
  --google_domain <domain>  Google 域名，默认 google.com
  --hl <lang>               界面语言，默认 en
  --gl <region>             国家代码，默认 us
  --num <n>                 结果数量 (1-100)，默认 10
  --safe <active|off>       安全搜索，默认 active
  --device <type>           设备类型 desktop|tablet|mobile
  --tbs <range>             时间范围，如 qdr:d (一天内), qdr:w (一周内)
  --site <domain>           限定站点搜索
  --save                    保存到 Vault (默认 true)
  --vault <path>            Vault 路径
  --db <path>               SQLite 数据库路径
  -h, --help                显示此帮助

示例:
  bun run scripts/serpapi-search.ts -q "Coffee" -l "Austin, Texas, United States"
  bun run scripts/serpapi-search.ts -q "TypeScript" --hl=zh-CN --gl=cn --num=20
  bun run scripts/serpapi-search.ts -q "AI news" --tbs=qdr:w
`);
  process.exit(0);
}

const query = values.query || positionals.join(" ");
if (!query) {
  console.error("[错误] 错误: 必须提供 --query 或位置参数");
  process.exit(1);
}

const apiKey = process.env.SERPAPI_KEY;
if (!apiKey) {
  console.error("[错误] 错误: 环境变量 SERPAPI_KEY 未设置");
  console.error("   请在 .env 文件中添加 SERPAPI_KEY=your_key");
  process.exit(1);
}

async function main() {
  const client = new SerpApiClient(apiKey);

  const params: SerpApiSearchParams = {
    q: query,
    engine: "google",
    location: values.location,
    google_domain: values.google_domain || "google.com",
    hl: values.hl,
    gl: values.gl,
    num: Math.min(Number(values.num) || 10, 100),
    safe: values.safe as "active" | "off",
    device: values.device as "desktop" | "tablet" | "mobile",
    ...(values.tbs ? { tbs: values.tbs } : {}),
    ...(values.site ? { as_sitesearch: values.site } : {}),
  };

  console.log(`[搜索] "${query}"`);
  if (values.location) console.log(`[位置] ${values.location}`);
  console.log("⏳ 请求 SerpAPI...\n");

  const start = performance.now();
  const response = await client.search(params);
  const latency = Math.round(performance.now() - start);

  const organic = response.organic_results || [];
  const kg = response.knowledge_graph;
  const rq = response.related_questions || [];
  const rs = response.related_searches || [];
  const images = response.images_results || [];
  const videos = response.videos_results || [];
  const news = response.news_results || [];
  const info = response.search_information;

  console.log("[完成] 搜索完成!\n");
  console.log(`───────────────────────────────`);
  console.log(`[摘要] 查询摘要`);
  console.log(`───────────────────────────────`);
  console.log(`  搜索 ID : ${response.search_metadata?.id}`);
  console.log(`  状态    : ${response.search_metadata?.status}`);
  console.log(`  总结果  : ${info?.total_results ?? "N/A"}`);
  console.log(`  耗时    : ${latency} ms (API) / ${info?.time_taken_displayed ?? "N/A"} s (Google)`);
  console.log(`  有机结果: ${organic.length}`);
  console.log(`  知识图谱: ${kg ? "[有]" : "[无]"}`);
  console.log(`  相关问题: ${rq.length}`);
  console.log(`  关联搜索: ${rs.length}`);
  console.log(`  图片结果: ${images.length}`);
  console.log(`  视频结果: ${videos.length}`);
  console.log(`  新闻结果: ${news.length}`);
  console.log(`───────────────────────────────\n`);

  // 打印前 5 个有机结果
  if (organic.length > 0) {
    console.log("🔗 前 5 个有机结果:");
    organic.slice(0, 5).forEach((r, i) => {
      const snippet = (r.snippet || "").slice(0, 80).replace(/\n/g, " ");
      console.log(`  ${i + 1}. ${r.title}`);
      console.log(`     ${r.link}`);
      if (snippet) console.log(`     > ${snippet}...`);
      console.log();
    });
  }

  // 保存到 Vault
  let vaultPath = "";
  if (values.save) {
    console.log("[保存] 保存到 Vault...");
    const vault = new VaultManager({ vaultPath: values.vault });
    vaultPath = await vault.writeSerpApiResult(query, response as Record<string, unknown>, {
      location: values.location,
      lang: values.hl,
      region: values.gl,
      latencyMs: latency,
    });
    console.log(`   Vault 笔记: ${vaultPath}`);
    vault.close();

    // 保存到 SQLite
    console.log("[数据库] 保存到 SQLite...");
    const dbPath = values.db;
    const db = new Database(dbPath);
    try {
      db.run(
        `INSERT INTO search_history (query, query_hash, engines, results_count, top_result_url, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          query,
          String(Bun.hash(query)),
          "serpapi:google",
          organic.length,
          organic[0]?.link || null,
          latency,
          Date.now(),
        ]
      );
      console.log(`   SQLite: search_history 已记录`);
    } catch (e: any) {
      console.warn(`   SQLite 写入失败: ${e.message}`);
    }
    db.close();
  }

  console.log("\n[完成]");
  if (vaultPath) {
    console.log(`   笔记路径: openclaw-memory/${vaultPath}`);
    console.log(`   在 Obsidian 中打开 Vault 即可查看和管理此笔记。`);
  }
}

main().catch((e) => {
  console.error("\n[错误]:", e.message);
  process.exit(1);
});
