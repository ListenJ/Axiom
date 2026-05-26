/**
 * OpenClaw AI Agent — CLI 命令行工具
 * 提供交互式命令行接口，用于日常运维和数据操作
 *
 * 用法: bun run src/cli.ts <command> [options]
 */
import { Database } from "bun:sqlite";
import { KnowledgeGraph } from "./kg/graph.js";
import { searchAggregator } from "./crawl/search-engines.js";
import { enhancedSearch } from "./crawl/enhanced-search.js";
import { DataPipeline } from "./crawl/data-pipeline.js";
import { proxyManager } from "./crawl/proxy-manager.js";
import { VaultManager } from "./memory/vault-manager.js";
import { logger } from "./utils/logger.js";
import {
  openCodeSession,
  startOpenCodeServer,
  checkOpenCode,
  listOpenCodeModels,
  OPENCODE_FREE_MODELS,
  getOpenCodeInstallGuide,
} from "./agents/opencode-agent.js";
import {
  kimiCodeChat,
  checkKimiCodeApiKey,
  checkKimiCli,
  startKimiCliSession,
  getKimiCodeGuide,
  KIMI_CODE_MODEL,
} from "./agents/kimi-code-agent.js";
import {
  runHermesTask,
  planProject,
  deepResearch,
  architectureReview,
  checkHermes,
  getHermesInstallGuide,
} from "./agents/hermes-agent.js";
import {
  recognizeIntent,
  buildAgentMessages,
  listAgentCategories,
  listAgentsByCategory,
} from "./agents/intent-router.js";

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

  esearch: {
    desc: "增强搜索 (esearch <query> [--mode=quick|deep|news|academic|code] [--num=10])",
    run: async (args) => {
      const query = args[0];
      if (!query) { console.error("Usage: esearch <query> [--mode=quick|deep|news|academic|code] [--num=10]"); return; }

      const mode = args.find((a) => a.startsWith("--mode="))?.slice(7) || "quick";
      const num = Number(args.find((a) => a.startsWith("--num="))?.slice(6)) || 10;

      console.log(`🔍 增强搜索 [${mode}]: "${query}"\n`);

      let results;
      switch (mode) {
        case "deep":
          results = await enhancedSearch.deepSearch(query, num);
          break;
        case "news":
          results = await enhancedSearch.newsSearch(query, num);
          break;
        case "academic":
          results = await enhancedSearch.academicSearch(query, num);
          break;
        case "code":
          results = await enhancedSearch.codeSearch(query, num);
          break;
        default:
          results = await enhancedSearch.quickSearch(query, num);
      }

      for (const r of results) {
        console.log(`  ${r.position}. ${r.title} ${r.isAuthoritative ? "⭐" : ""}`);
        console.log(`     ${r.link}`);
        console.log(`     ${r.enhancedSnippet || r.snippet.slice(0, 120)}...`);
        console.log(`     📊 相关性: ${(r.relevanceScore * 100).toFixed(0)}% | 来源: ${r.engine}`);
        console.log();
      }
      console.log(`共 ${results.length} 条结果`);
    },
  },

  "search:suggestions": {
    desc: "获取搜索建议 (search:suggestions <partial_query>)",
    run: async (args) => {
      const partial = args[0];
      if (!partial) { console.error("Usage: search:suggestions <partial_query>"); return; }

      const suggestions = enhancedSearch.getSuggestions(partial, 10);
      console.log(`搜索建议 for "${partial}":\n`);
      suggestions.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    },
  },

  "search:stats": {
    desc: "搜索统计 (search:stats [--days=7])",
    run: async (args) => {
      const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7)) || 7;
      const stats = enhancedSearch.getStats(days);

      console.log(`📊 搜索统计 (最近 ${days} 天)\n`);
      console.log(`总搜索次数: ${stats.totalSearches}`);
      console.log(`唯一查询: ${stats.uniqueQueries}`);
      console.log(`平均结果数: ${stats.avgResults}`);
      console.log(`平均延迟: ${stats.avgLatency}ms\n`);

      console.log("🔥 热门查询:");
      stats.topQueries.forEach((q, i) => console.log(`  ${i + 1}. ${q.query} (${q.count}次)`));

      console.log("\n⚙️ 引擎使用:");
      stats.topEngines.forEach((e, i) => console.log(`  ${i + 1}. ${e.engine} (${e.count}次)`));
    },
  },

  "search:history": {
    desc: "搜索历史 (search:history [--limit=50])",
    run: async (args) => {
      const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 50;
      const history = enhancedSearch.getHistory(limit);

      console.log(`📜 最近 ${history.length} 条搜索历史:\n`);
      history.forEach((h, i) => {
        console.log(`  ${i + 1}. [${new Date(h.createdAt).toLocaleString()}] "${h.query}"`);
        console.log(`     引擎: ${h.engines} | 结果: ${h.resultCount} | 耗时: ${h.latencyMs}ms`);
      });
    },
  },

  "search:clear": {
    desc: "清除搜索缓存和历史",
    run: async () => {
      enhancedSearch.clearCache();
      enhancedSearch.clearHistory();
      console.log("✅ 搜索缓存和历史已清除");
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
        { name: "kimi-code", url: "https://api.kimi.com/coding/v1/models", key: process.env.KIMI_CODE_API_KEY },
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

  bootstrap: {
    desc: "Agent 启动记忆加载 (bootstrap [--topic=keyword] [--depth=5])",
    run: async (args) => {
      const topic = args.find((a) => a.startsWith("--topic="))?.slice(8) || "";
      const depth = Number(args.find((a) => a.startsWith("--depth="))?.slice(8)) || 5;
      const { AgentBootstrap } = await import("./memory/bootstrap.js");
      const bootstrap = new AgentBootstrap();
      const ctx = await bootstrap.run({ topic, memoryDepth: depth });
      console.log(bootstrap.toSystemPrompt(ctx));
    },
  },

  distill: {
    desc: "手动蒸馏原子笔记 (distill <title> <content>)",
    run: async (args) => {
      const title = args[0];
      const content = args.slice(1).join(" ");
      if (!title || !content) { console.error("Usage: distill <title> <content>"); return; }
      const { MemoryDistiller } = await import("./memory/distiller.js");
      const distiller = new MemoryDistiller();
      const path = await distiller.distillManual(title, content, {
        source: "cli-manual",
        sourceType: "manual",
      });
      console.log(`✅ 原子笔记已创建: ${path}`);
    },
  },

  "code:open": {
    desc: "启动 OpenCode 交互式编码会话 (code:open [prompt] [--model=opencode/deepseek-v4-flash-free])",
    run: async (args) => {
      const installed = await checkOpenCode();
      if (!installed) { console.log(getOpenCodeInstallGuide()); return; }
      const model = args.find((a) => a.startsWith("--model="))?.slice(8);
      const prompt = args.find((a) => !a.startsWith("--"));
      console.log(`🚀 启动 OpenCode 会话 (模型: ${model || OPENCODE_FREE_MODELS[0]})...\n`);
      await openCodeSession({ cwd: process.cwd(), model, prompt });
    },
  },

  "code:models": {
    desc: "列出 OpenCode 可用模型",
    run: async () => {
      const installed = await checkOpenCode();
      if (!installed) { console.log(getOpenCodeInstallGuide()); return; }
      console.log("🆓 OpenCode 推荐免费模型:\n");
      for (const m of OPENCODE_FREE_MODELS) console.log(`  • ${m}`);
      console.log("\n📋 所有可用模型:");
      const models = await listOpenCodeModels();
      for (const m of models.slice(0, 30)) console.log(`  • ${m}`);
      if (models.length > 30) console.log(`  ... 还有 ${models.length - 30} 个`);
    },
  },

  "code:serve": {
    desc: "启动 OpenCode 后台 Web 服务 (code:serve [--port=0])",
    run: async (args) => {
      const installed = await checkOpenCode();
      if (!installed) { console.log(getOpenCodeInstallGuide()); return; }
      const port = Number(args.find((a) => a.startsWith("--port="))?.slice(7)) || 0;
      console.log(`🌐 启动 OpenCode 后台服务... 按 Ctrl+C 停止\n`);
      const server = startOpenCodeServer({ cwd: process.cwd(), port });
      process.on("SIGINT", () => { server.stop(); process.exit(0); });
      await new Promise(() => {}); // 永久等待
    },
  },

  "kimi:chat": {
    desc: "使用 Kimi Code API 进行编码对话 (kimi:chat <prompt> [--temp=0.7])",
    run: async (args) => {
      const prompt = args.find((a) => !a.startsWith("--"));
      if (!prompt) { console.error("Usage: kimi:chat <prompt>"); return; }

      const configured = checkKimiCodeApiKey();
      if (!configured) {
        console.log(getKimiCodeGuide());
        return;
      }

      const temp = Number(args.find((a) => a.startsWith("--temp="))?.slice(7)) || 0.7;
      console.log(`🦅 Kimi Code 编码中... (模型: ${KIMI_CODE_MODEL}, temp: ${temp})\n`);

      try {
        const result = await kimiCodeChat({
          messages: [
            { role: "system", content: "You are Kimi Code, an expert programming assistant." },
            { role: "user", content: prompt },
          ],
          temperature: temp,
        });
        console.log(result.content);
        if (result.usage) {
          console.log(`\n--- 用量: ${result.usage.prompt_tokens} prompt + ${result.usage.completion_tokens} completion = ${result.usage.total_tokens} tokens ---`);
        }
      } catch (e: any) {
        console.error(`\n❌ Kimi Code 调用失败: ${e.message}`);
      }
    },
  },

  "kimi:open": {
    desc: "启动 Kimi Code CLI 交互式会话 (kimi:open [prompt])",
    run: async (args) => {
      const installed = await checkKimiCli();
      if (!installed) {
        console.log("❌ kimi CLI 未安装。安装方式:\n");
        console.log("  macOS / Linux: curl -LsSf https://code.kimi.com/install.sh | bash");
        console.log("  Windows:       Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression\n");
        console.log(getKimiCodeGuide());
        return;
      }
      const prompt = args.find((a) => !a.startsWith("--"));
      console.log(`🚀 启动 Kimi Code CLI 会话...\n`);
      await startKimiCliSession({ cwd: process.cwd(), prompt });
    },
  },

  "kimi:status": {
    desc: "检查 Kimi Code 配置和 CLI 状态",
    run: async () => {
      console.log("🦅 Kimi Code 状态检查\n");
      const apiKeyOk = checkKimiCodeApiKey();
      console.log(`  API Key:   ${apiKeyOk ? "✅ 已配置" : "❌ 未配置 (KIMI_CODE_API_KEY)"}`);
      const cliOk = await checkKimiCli();
      console.log(`  CLI 工具:  ${cliOk ? "✅ 已安装" : "❌ 未安装 (curl -LsSf https://code.kimi.com/install.sh | bash)"}`);
      console.log(`  模型 ID:   ${KIMI_CODE_MODEL}`);
      console.log(`  Base URL:  ${process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1"}`);
      console.log(`\n使用指南: bun run src/cli.ts kimi:guide`);
    },
  },

  "kimi:guide": {
    desc: "显示 Kimi Code 安装与使用指南",
    run: () => {
      console.log(getKimiCodeGuide());
    },
  },

  "project:plan": {
    desc: "使用 Hermes 创建项目计划 (project:plan <description>)",
    run: async (args) => {
      const description = args.join(" ");
      if (!description) { console.error("Usage: project:plan <description>"); return; }
      const installed = await checkHermes();
      if (!installed) { console.log("❌ Hermes 未安装。运行: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"); return; }
      console.log(`📋 Hermes 制定项目计划中...\n`);
      const result = await planProject(description, process.cwd());
      console.log(result.stdout);
      if (result.stderr) console.error("⚠️  stderr:", result.stderr);
    },
  },

  "project:research": {
    desc: "使用 Hermes 深度研究 (project:research <topic>)",
    run: async (args) => {
      const topic = args.join(" ");
      if (!topic) { console.error("Usage: project:research <topic>"); return; }
      const installed = await checkHermes();
      if (!installed) { console.log("❌ Hermes 未安装。运行: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"); return; }
      console.log(`🔬 Hermes 深度研究中...\n`);
      const result = await deepResearch(topic, process.cwd());
      console.log(result.stdout);
      if (result.stderr) console.error("⚠️  stderr:", result.stderr);
    },
  },

  "project:arch": {
    desc: "使用 Hermes 架构审查 (project:arch [--path=.])",
    run: async (args) => {
      const projectPath = args.find((a) => a.startsWith("--path="))?.slice(7);
      const installed = await checkHermes();
      if (!installed) { console.log("❌ Hermes 未安装。运行: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"); return; }
      console.log(`🏗️  Hermes 架构审查中...\n`);
      const result = await architectureReview(projectPath, process.cwd());
      console.log(result.stdout);
      if (result.stderr) console.error("⚠️  stderr:", result.stderr);
    },
  },

  tui: {
    desc: "启动 TUI 终端交互界面",
    run: async () => {
      const { startTUI } = await import("./tui/app.js");
      await startTUI();
    },
  },

  chat: {
    desc: "AI 聊天 (chat <message> [--no-intent])",
    run: async (args) => {
      const message = args.find((a) => !a.startsWith("--"));
      if (!message) { console.error("Usage: chat <message>"); return; }
      const noIntent = args.includes("--no-intent");

      let intent: ReturnType<typeof buildAgentMessages>["intent"] = null;
      let messages: ReturnType<typeof buildAgentMessages>["messages"] = [];

      if (!noIntent) {
        console.log(`🧠 正在识别意图...\n`);
        const { buildAgentMessages } = await import("./agents/intent-router.js");
        const result = buildAgentMessages(message);
        intent = result.intent;
        messages = result.messages;

        if (intent) {
          console.log(`🎯 识别意图: ${intent.agent.emoji} ${intent.agentName} (${intent.intent})`);
          console.log(`   置信度: ${(intent.confidence * 100).toFixed(0)}%`);
          console.log(`   匹配词: ${intent.matchedKeywords.join(", ") || "无"}\n`);
        } else {
          console.log(`🎯 识别意图: 通用助手\n`);
        }
      } else {
        messages = [{ role: "user", content: message }];
      }

      const { router } = await import("./router/model-router.js");

      // 根据意图自动选择模型层级
      const intentType = intent?.intent;
      let result;
      if (!intent) {
        result = await router.chat("general-chat", messages);
      } else if (["strategy", "evaluation", "decision"].includes(intentType || "")) {
        console.log(`🔮 调用决策层 (DeepSeek-V4 Pro)...\n`);
        result = await router.decide(messages);
      } else if (["architecture", "system-design", "infra"].includes(intentType || "")) {
        console.log(`🏛️ 调用架构层 (GLM-5.1)...\n`);
        result = await router.architect(messages);
      } else if (["engineering", "game-development", "integrations", "testing"].includes(intentType || "")) {
        console.log(`🛠️ 调用工具层 (编码免费模型)...\n`);
        result = await router.tool("coding", messages);
      } else if (["english", "translation", "localization"].includes(intentType || "")) {
        console.log(`🌐 调用工具层 (英文处理)...\n`);
        result = await router.tool("english", messages);
      } else if (["rl", "reasoning", "optimization"].includes(intentType || "")) {
        console.log(`🧠 调用工具层 (RL/推理)...\n`);
        result = await router.tool("rl", messages);
      } else {
        const taskType = ["academic", "product", "project-management"].includes(intentType || "")
          ? "code-generation"
          : "general-chat";
        result = await router.chat(taskType, messages);
      }

      console.log(`🤖 ${result.provider} / ${result.model}\n`);
      console.log(result.content);
      if (result.usage) {
        console.log(`\n--- 用量: ${result.usage.prompt_tokens} prompt + ${result.usage.completion_tokens} completion = ${result.usage.total_tokens} tokens ---`);
      }
    },
  },

  "cg:init": {
    desc: "初始化 CodeGraph 代码知识索引",
    run: async () => {
      const { initializeCodegraph, getStatus } = await import("./memory/codegraph-index.js");
      console.log("🔧 初始化 CodeGraph...\n");
      await initializeCodegraph();
      const status = await getStatus();
      console.log("✅ CodeGraph 初始化完成");
      console.log(`  文件数: ${status?.files ?? "?"}`);
      console.log(`  节点数: ${status?.nodes ?? "?"}`);
      console.log(`  边数: ${status?.edges ?? "?"}`);
    },
  },

  "cg:search": {
    desc: "搜索 CodeGraph 符号 (cg:search <query> [--limit=10])",
    run: async (args) => {
      const query = args[0];
      if (!query) { console.error("Usage: cg:search <query>"); return; }
      const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8)) || 10;
      const { searchSymbols } = await import("./memory/codegraph-index.js");
      const results = await searchSymbols(query, { limit });
      console.log(`🔍 CodeGraph 搜索结果: "${query}" (${results.length} 个符号)\n`);
      for (const r of results.slice(0, limit)) {
        console.log(`  ${r.node.kind} ${r.node.name}`);
        console.log(`     📁 ${r.node.filePath}:${r.node.startLine}`);
        console.log(`     📝 ${r.node.signature ?? "no signature"}`);
        console.log();
      }
    },
  },

  "cg:context": {
    desc: "构建 CodeGraph 上下文 (cg:context <task>)",
    run: async (args) => {
      const task = args.join(" ");
      if (!task) { console.error("Usage: cg:context <task description>"); return; }
      const { buildContext } = await import("./memory/codegraph-index.js");
      console.log("🧠 构建 CodeGraph 上下文...\n");
      const context = await buildContext(task, { maxNodes: 15, includeCode: true });
      console.log(context);
    },
  },

  "model:status": {
    desc: "查看模型路由状态和工具池健康度",
    run: async () => {
      const { toolPool } = await import("./router/tool-pool.js");
      const stats = toolPool.getStats() as Record<string, any>;
      console.log("🤖 模型路由分层状态\n");
      console.log("  L1 决策层:    DeepSeek-V4 Pro (paid)");
      console.log("  L2 架构层:    GLM-5.1 (paid)");
      console.log("  L3 工具层:    免费模型池（带限流）");
      console.log("  L4 评估层:    Tencent hy3-preview ($5额度) + DeepSeek-V4 Pro\n");

      console.log("🛠️ 工具模型池健康度:\n");
      const grouped: Record<string, any[]> = {};
      for (const [id, s] of Object.entries(stats)) {
        const role = s.role as string;
        if (!grouped[role]) grouped[role] = [];
        grouped[role].push({ id, ...s });
      }
      for (const [role, models] of Object.entries(grouped)) {
        console.log(`  [${role.toUpperCase()}]`);
        for (const m of models) {
          const rpm = `${m.rpmThisMinute}/${m.rpmLimit} RPM`;
          console.log(`    ${m.health} ${m.id.slice(0, 50)}`);
          console.log(`       并发:${m.activeRequests} | ${rpm} | 总调用:${m.totalCalls} | 失败:${m.totalFailures}`);
        }
        console.log();
      }
    },
  },

  "agent:status": {
    desc: "检查编码和项目管理 Agent 状态",
    run: async () => {
      console.log("🤖 Agent 状态检查\n");
      const opencodeOk = await checkOpenCode();
      console.log(`  OpenCode: ${opencodeOk ? "✅ 已安装" : "❌ 未安装 (curl -fsSL https://opencode.ai/install.sh | bash)"}`);
      if (opencodeOk) {
        console.log(`  OpenCode 免费模型:`);
        for (const m of OPENCODE_FREE_MODELS) console.log(`    • ${m}`);
      }
      const hermesOk = await checkHermes();
      console.log(`  Hermes:    ${hermesOk ? "✅ 已安装" : "❌ 未安装 (curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash)"}`);
      const kimiApiOk = checkKimiCodeApiKey();
      const kimiCliOk = await checkKimiCli();
      console.log(`  Kimi Code: ${kimiApiOk || kimiCliOk ? "✅" : "❌"} API Key ${kimiApiOk ? "已配置" : "未配置"} | CLI ${kimiCliOk ? "已安装" : "未安装"}`);
    },
  },

  help: {
    desc: "显示帮助信息",
    run: () => {
      console.log("🦅 OpenClaw AI Agent CLI\n");
      console.log("用法: bun run src/cli.ts <command> [args...]\n");
      console.log("命令:");
      const maxLen = Math.max(...Object.keys(commands).map((k) => k.length));
      for (const [name, cmd] of Object.entries(commands)) {
        console.log(`  ${name.padEnd(maxLen)}  ${cmd.desc}`);
      }
      console.log("\n🖥️ TUI 终端界面:");
      console.log("  bun run src/cli.ts tui");
      console.log("\n🗨️ AI 聊天（分层路由）:");
      console.log("  bun run src/cli.ts chat \"帮我写一个React组件\"     → L3 Tool Pool (coding)");
      console.log("  bun run src/cli.ts chat \"帮我写论文\"               → general-chat");
      console.log("\n🧠 CodeGraph 代码记忆:");
      console.log("  bun run src/cli.ts cg:init                          初始化索引");
      console.log("  bun run src/cli.ts cg:search recognizeIntent        搜索符号");
      console.log("  bun run src/cli.ts cg:context \"fix login bug\"       构建上下文");
      console.log("\n📊 模型状态:");
      console.log("  bun run src/cli.ts model:status                     查看工具池健康度");
      console.log("\n编码 Agent (OpenCode) — 使用免费模型:");
      console.log("  bun run src/cli.ts code:open \"写一个HTTP服务器\" --model=opencode/deepseek-v4-flash-free");
      console.log("  bun run src/cli.ts code:models");
      console.log("  bun run src/cli.ts code:serve --port=8765");
      console.log("\n编码 Agent (Kimi Code) — Kimi 会员权益:");
      console.log("  bun run src/cli.ts kimi:status                  检查配置状态");
      console.log("  bun run src/cli.ts kimi:chat \"写一个HTTP服务器\"  API 直连编码");
      console.log("  bun run src/cli.ts kimi:open                    启动 CLI 交互会话");
      console.log("  bun run src/cli.ts kimi:guide                   查看安装指南");
      console.log("\n项目管理 Agent (Hermes):")
      console.log("  bun run src/cli.ts project:plan \"构建一个电商后台\"");
      console.log("  bun run src/cli.ts project:research \"Rust vs Go 性能对比\"");
      console.log("  bun run src/cli.ts project:arch --path=.");
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
