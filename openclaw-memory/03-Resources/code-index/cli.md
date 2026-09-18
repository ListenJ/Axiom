---
id: code-cli
type: code-index
source: cli.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 1161
tags: [code, auto-indexed]
imports: ["bun:sqlite", "kg-graph.js", "crawl-search-engines.js", "crawl-data-pipeline.js", "crawl-proxy-manager.js", "memory-vault-manager.js", "utils-logger.js"]
---

# cli

## 元信息

- **源文件**: `cli.ts`
- **模块**: `cli`
- **行数**: 322
- **索引时间**: 2026-05-25T05:11:12.520Z

## 依赖

- [[bun:sqlite]]
- [[kg-graph.js]]
- [[crawl-search-engines.js]]
- [[crawl-data-pipeline.js]]
- [[crawl-proxy-manager.js]]
- [[memory-vault-manager.js]]
- [[utils-logger.js]]

## 代码

```typescript
/**
 * Axiom AI Agent — CLI 命令行工具
 * 提供交互式命令行接口，用于日常运维和数据操作
 *
 * 用法: bun run src/cli.ts <command> [options]
 */
import { Database } from "bun:sqlite";
import { KnowledgeGraph } from "./kg/graph.js";
import { searchAggregator } from "./crawl/search-engines.js";
import { DataPipeline } from "./crawl/data-pipeline.js";
import { proxyManager } from "./crawl/proxy-manager.js";
import { VaultManager } from "./memory/vault-manager.js";
import { logger } from "./utils/logger.js";

const dbPath = process.env.DATABASE_PATH || "./data/agent.db";

const commands: Record<string, { desc: string; run: (args: string[]) => Promise<void> | void }> = {
  status: {
    desc: "查看系统状态",
    run: () => {
      const db = new Database(dbPath);
      const tables = ["conversations", "tasks", "knowledge", "entities", "relationships", "crawl_results", "search_history", "model_usage"];
      console.log("📊 数据库统计:\n");
      for (const t of tables) {
        const row = db.query(`SELECT COUNT(*) as c FROM ${t}`).get() as any;
        console.log(`  ${t.padEnd(20)} ${String(row?.c || 0).padStart(6)} 条记录`);
      }
      db.close();

      console.log("\n🔍 搜索引擎:");
      for (const e of searchAggregator.listEngines()) {
        console.log(`  ${e.name.padEnd(15)} ${e.available ? "✅ 可用" : "⚪ 未配置"}`);
      }

      console.log(`\n🔌 代理: ${proxyManager.getHealthyCount()} 个健康代理`);
    },
  },

  search: {
    desc: "多引擎搜索 (search <query> [--engines=ddg,bing] [--num=10])",
    run: async (args) => {
      const query = args[0];
      if (!query) { console.error("Usage: search <query>"); return; }

      const enginesArg = args.find((a) => a.startsWith("--engines="))?.slice(10)?.split(",") || ["duckduckgo", "searxng"];
      const num = Number(args.find((a) => a.startsWith("--num="))?.slice(6)) || 10;

      console.log(`🔍 搜索: "${query}" via [${enginesArg.join(", ")}]\n`);
      const results = await searchAggregator.searchMulti({ query, num }, enginesArg);
      for (const r of results) {
        console.log(`  ${r.position}. ${r.title}`);
        console.log(`     ${r.link}`);
        console.log(`     ${r.snippet.slice(0, 120)}...`);
        console.log();
      }
      console.log(`共 ${results.length} 条结果`);
    },
  },

  fetch: {
    desc: "结构化抓取网页 (fetch <url>)",
    run: async (args) => {
      const url = args[0];
      if (!url) { console.error("Usage: fetch <url>"); return; }

      const pipeline = new DataPipeline();
      console.log(`🌐 抓取: ${url}\n`);
      const result = await pipeline.crawlStructured(url);
      if (!result) { console.error("抓取失败"); return; }

      console.log(`标题: ${result.title}`);
      console.log(`站点: ${result.siteName}`);
      console.log(`语言: ${result.language}`);
      console.log(`描述: ${result.description?.slice(0, 200) || "无"}`);
      console.log(`\n结构化数据类型: ${result.structuredData.map((d: any) => d["@type"] || "Unknown").join(", ") || "无"}`);
      console.log(`标题层级: ${result.headings.length} 个`);
      console.log(`表格: ${result.tables.length} 个`);
      console.log(`代码块: ${result.codeBlocks.length} 个`);
      console.log(`图片: ${result.images.length} 个`);
      console.log(`链接: ${result.links.length} 个`);
      console.log(`内容分块: ${result.chunks.length} 个`);
      console.log(`\n--- Markdown 预览 (前 800 字符) ---\n${result.markdown.slice(0, 800)}...`);
    },
  },

  "kg:entity": {
    desc: "知识图谱: 创建实体 (kg:entity <name> <type> [json_props])",
    run: (args) => {
      const [name, type, propsJson] = args;
      if (!name || !type) { console.error("Usage: kg:entity <name> <type> [json_props]"); return; }
      const kg = new KnowledgeGraph();
      const props = propsJson ? JSON.parse(propsJson) : undefined;
      const entity = kg.createEntity(name, type as any, props);
      console.log(`✅ 创建实体: #${entity.id} ${entity.name} (${entity.type})`);
      kg.close();
    },
  },

  "kg:relate": {
    desc: "知识图谱: 创建关系 (kg:relate <source_name> <target_name> <type>)",
    run: (args) => {
      const [sourceName, targetName, relType] = args;
      if (!sourceName || !targetName || !relType) { console.error("Usage: kg:relate <source> <target> <type>"); return; }
      const kg = new KnowledgeGraph();
      const src = kg.getEntityByName(sourceName);
      const tgt = kg.getEntityByName(targetName);
      if (!src) { console.error(`实体不存在: ${sourceName}`); return; }
      if (!tgt) { console.error(`实体不存在: ${targetName}`); return; }
      const rel = kg.createRelationship(src.id, tgt.id, relType as any);
      console.log(`✅ 创建关系: #${rel.id} ${sourceName} --[${relType}]--> ${targetName}`);
      kg.close();
    },
  },

  "kg:search": {
    desc: "知识图谱: 搜索实体 (kg:search <query>)",
    run: (args) => {
      const query = args[0];
      if (!query) { console.error("Usage: kg:search <query>"); return; }
      const kg = new KnowledgeGraph();
      const results = kg.searchEntities(query, 20);
      console.log(`找到 ${results.length} 个实体:\n`);
      for (const e of results) {
        console.log(`  #${e.id} ${e.name} [${e.type}]`);
      }
      kg.close();
    },
  },

  "kg:stats": {
    desc: "知识图谱: 统计信息",
    run: () => {
      const kg = new KnowledgeGraph();
      const stats = kg.stats();
      console.log(`实体数: ${stats.entityCount}`);
      console.log(`关系数: ${stats.relationCount}`);
      console.log("类型分布:");
      for (const [type, count] of Object.entries(stats.typeDistribution)) {
        console.log(`  ${type}: ${count}`);
      }
      kg.close();
    },
  },

  "kg:centrality": {
    desc: "知识图谱: 中心性分析 (度中心性 Top N)",
    run: (args) => {
      const limit = Number(args[0]) || 20;
      const kg = new KnowledgeGraph();
      const results = kg.centrality(limit);
      console.log("度中心性排名:\n");
      for (const { entity, degree } of results) {
        console.log(`  ${degree.toString().padStart(3)}  #${entity.id} ${entity.name} [${entity.type}]`);
      }
      kg.close();
    },
  },

  "vault:search": {
    desc: "Vault 确定性记忆搜索 (vault:search <query> [--limit=10] [--para=resources])",
    run: (args) => {
      const query = args[0];
      if (!query) { console.error("Usage: vault:search <query>"); return; }
      const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 10;
      const para = args.find((a) => a.startsWith("--para="))?.slice(7);
      const vault = new VaultManager();
      const results = vault.search(query, { limit, paraCategory: para });
      console.log(`🔍 Vault 搜索结果: "${query}" (${results.length} 条)\n`);
      for (const r of results) {
        console.log(`  [${r.score.toFixed(1)}] ${r.note.title}`);
        console.log(`      📁 ${r.note.path}`);
        console.log(`      🏷️  ${r.note.tags.join(", ") || "无标签"}`);
        console.log(`      💡 ${r.reasons.join("; ")}`);
        console.log(`      📝 ${r.excerpt.slice(0, 120)}...`);
        console.log();
      }
    },
  },

  "vault:read": {
    desc: "读取 Vault 笔记 (vault:read <path>)",
    run: (args) => {
      const notePath = args[0];
      if (!notePath) { console.error("Usage: vault:read <path>"); return; }
      const vault = new VaultManager();
      const note = vault.readNote(notePath);
      if (!note) { console.error("笔记不存在:"); return; }
      console.log(`--- ${notePath} ---\n`);
      console.log("frontmatter:", JSON.stringify(note.frontmatter, null, 2));
      console.log("\n--- 内容 ---\n");
      console.log(note.content.slice(0, 3000));
      if (note.content.length > 3000) console.log("\n... (截断)");
    },
  },

  "vault:para": {
    desc: "PARA 分类浏览 (vault:para <projects|areas|resources|archives>)",
    run: (args) => {
      const category = args[0];
      if (!category) { console.error("Usage: vault:para <category>"); return; }
      const vault = new VaultManager();
      const notes = vault.browsePara(category);
      console.log(`📂 PARA / ${category} (${notes.length} 条)\n`);
      for (const n of notes.slice(0, 30)) {
        console.log(`  ${n.title} — ${n.path} [${n.tags.join(", ") || "无标签"}]`);
      }
      if (notes.length > 30) console.log(`  ... 还有 ${notes.length - 30} 条`);
    },
  },

  "vault:stats": {
    desc: "Vault 记忆库统计",
    run: () => {
      const vault = new VaultManager();
      const stats = vault.stats();
      console.log("📊 Vault 统计:\n");
      console.log(`  总笔记数: ${stats.totalNotes}`);
      console.log(`  总词数: ${stats.totalWords}`);
      console.log(`  总标签数: ${stats.totalTags}`);
      console.log(`  总 wiki-link: ${stats.totalLinks}`);
      console.log("  PARA 分布:");
      for (const [type, count] of Object.entries(stats.paraDistribution)) {
        console.log(`    ${type}: ${count}`);
      }
    },
  },

  "vault:index-code": {
    desc: "索引项目代码到 Vault",
    run: async () => {
      const vault = new VaultManager();
      console.log("🔄 正在索引代码...");
      const result = await vault.indexCode();
      console.log(`✅ 索引完成: ${result.indexed} 个文件`);
      if (result.errors.length) console.log(`❌ 错误: ${result.errors.join(", ")}`);
    },
  },

  "db:query": {
    desc: "执行 SQLite 查询 (db:query <sql>)",
    run: (args) => {
      const sql = args.join(" ");
      if (!sql) { console.error("Usage: db:query <sql>"); return; }
      const db = new Database(dbPath);
      try {
        const rows = db.query(sql).all();
        console.log(JSON.stringify(rows, null, 2));
      } catch (e: any) {
        console.error("查询错误:", e.message);
      }
      db.close();
    },
  },

  health: {
    desc: "执行平台健康检查",
    run: async () => {
      const platforms = [
        { name: "siliconflow", url: "https://api.siliconflow.cn/v1/models", key: process.env.SILICONFLOW_API_KEY },
        { name: "ofoxai", url: "https://api.ofox.ai/v1/models", key: process.env.OFOXAI_API_KEY },
        { name: "openrouter", url: "https://openrouter.ai/api/v1/models", key: process.env.OPENROUTER_API_KEY },
        { name: "deepseek", url: "https://api.deepseek.com/v1/models", key: process.env.DEEPSEEK_API_KEY },
      ];

      console.log("🏥 平台健康检查:\n");
      for (const p of platforms) {
        if (!p.key) { console.log(`  🔴 ${p.name.padEnd(12)} 未配置 API Key`); continue; }
        try {
          const res = await fetch(p.url, {
            headers: { Authorization: `Bearer ${p.key}` },
            signal: AbortSignal.timeout(5000),
          });
          console.log(`  ${res.ok ? "🟢" : "🔴"} ${p.name.padEnd(12)} ${res.status} ${res.statusText}`);
        } catch (e: any) {
          console.log(`  🔴 ${p.name.padEnd(12)} ${e.message}`);
        }
      }
    },
  },

  help: {
    desc: "显示帮助信息",
    run: () => {
      console.log("🦅 Axiom AI Agent CLI\n");
      console.log("用法: bun run src/cli.ts <command> [args...]\n");
      console.log("命令:");
      const maxLen = Math.max(...Object.keys(commands).map((k) => k.length));
      for (const [name, cmd] of Object.entries(commands)) {
        console.log(`  ${name.padEnd(maxLen)}  ${cmd.desc}`);
      }
    },
  },
};

// ===== 入口 =====

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    commands.help.run([]);
    return;
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`未知命令: ${cmd}`);
    console.error(`运行 "bun run src/cli.ts help" 查看可用命令`);
    process.exit(1);
  }

  try {
    await handler.run(args);
  } catch (e: any) {
    logger.error(`CLI command "${cmd}" failed`, e);
    console.error(`\n❌ 错误: ${e.message}`);
    process.exit(1);
  }
}

main();

```