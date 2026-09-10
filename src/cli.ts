/**
 * Axiom AI Agent — CLI 命令行工具
 * 提供交互式命令行接口，用于日常运维和数据操作
 *
 * 用法: bun run src/cli.ts <command> [options]
 */
import { Database } from "bun:sqlite";
import { searchAggregator } from "./crawl/search-engines.js";
import { logger } from "./utils/logger.js";
import { readString } from "./utils/env.js";
import {
  openCodeSession,
  startOpenCodeServer,
  checkOpenCode,
  listOpenCodeModels,
  OPENCODE_FREE_MODELS,
  getOpenCodeInstallGuide,
  getOpenCodeToolAgent,
  quickExecute,
  type ExecutionStrategy,
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
  deepResearch,
  checkHermes,
  getHermesInstallGuide,
} from "./agents/hermes-agent.js";
import {
  recognizeIntent,
  buildAgentMessages,
} from "./agents/intent-router.js";
import { runSetupWizard } from "./cli/setup.js";
import {
  handleSearch,
  handleESearch,
  handleSearchSuggestions,
  handleSearchStats,
  handleSearchHistory,
  handleSearchClear,
  handleFetch,
  handleVaultSearch,
  handleVaultRead,
  handleVaultPara,
  handleVaultStats,
  handleVaultIndexCode,
  handleDistill,
  handleKgBuild,
  handleKgStats,
  handleKgSearch,
  handleKgQuery,
  handleKgFeedback,
  handleEvalCommands,
} from "./cli/commands/index.js";
import {
  handleKnowledgeCollect,
  handleKnowledgePipeline,
  handleKnowledgeStats,
} from "./cli/commands/knowledge.js";

const dbPath = readString("DATABASE_PATH", "./data/agent.db");

const commands: Record<string, { desc: string; run: (args: string[]) => Promise<void> | void }> = {
  setup: {
    desc: "交互式配置向导 - 设置所有 LLM 厂商 API Key",
    run: async (args: string[]) => {
      await runSetupWizard(args);
    },
  },

  install: {
    desc: "交互式安装向导 - 选择 Local/Cloud 版本并初始化系统",
    run: async (_args: string[]) => {
      const { startInstallWizard } = await import("./tui/install-wizard.js");
      await startInstallWizard();
    },
  },

  key: {
    desc: "快速添加/更新单个厂商 API Key (key <provider> <api_key>)",
    run: async (args: string[]) => {
      const provider = args[0];
      const apiKey = args[1];

      if (!provider || !apiKey) {
        console.error("Usage: key <provider> <api_key>");
        console.error("Available providers: siliconflow, ofoxai, openrouter, deepseek, opencode, kimi, minimax");
        return;
      }

      const envPath = ".env";
      const fs = await import("fs");
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

      const providerKeyMap: Record<string, string> = {
        siliconflow: "SILICONFLOW_API_KEY",
        ofoxai: "OFOXAI_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
        opencode: "OPENCODE_API_KEY",
        kimi: "KIMI_API_KEY",
        minimax: "MINIMAX_API_KEY",
      };

      const envKey = providerKeyMap[provider.toLowerCase()];
      if (!envKey) {
        console.error(`Unknown provider: ${provider}`);
        console.error(`Supported: ${Object.keys(providerKeyMap).join(", ")}`);
        return;
      }

      // Update or add the key
      const regex = new RegExp(`^${envKey}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${envKey}=${apiKey}`);
        console.log(`[Updated] ${envKey}`);
      } else {
        envContent += `\n${envKey}=${apiKey}\n`;
        console.log(`[Added] ${envKey}`);
      }

      fs.writeFileSync(envPath, envContent);
      console.log(`[Success] API key for ${provider} saved to .env`);
    },
  },

  "key:remove": {
    desc: "移除厂商 API Key (key:remove <provider>)",
    run: async (args: string[]) => {
      const provider = args[0];
      if (!provider) {
        console.error("Usage: key:remove <provider>");
        return;
      }

      const envPath = ".env";
      const fs = await import("fs");
      if (!fs.existsSync(envPath)) {
        console.error("No .env file found");
        return;
      }

      const providerKeyMap: Record<string, string> = {
        siliconflow: "SILICONFLOW_API_KEY",
        ofoxai: "OFOXAI_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
        opencode: "OPENCODE_API_KEY",
        kimi: "KIMI_API_KEY",
        minimax: "MINIMAX_API_KEY",
      };

      const envKey = providerKeyMap[provider.toLowerCase()];
      if (!envKey) {
        console.error(`Unknown provider: ${provider}`);
        return;
      }

      let envContent = fs.readFileSync(envPath, "utf-8");
      const regex = new RegExp(`^${envKey}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `# ${envKey}=(removed)`);
        fs.writeFileSync(envPath, envContent);
        console.log(`[Removed] ${envKey}`);
      } else {
        console.log(`[Not Found] ${envKey} not in .env`);
      }
    },
  },
  status: {
    desc: "查看系统状态",
    run: () => {
      const db = new Database(dbPath);
      const tables = ["conversations", "tasks", "knowledge", "entities", "relationships", "crawl_results", "search_history", "model_usage"];
      console.log("[数据库统计]\n");
      for (const t of tables) {
        const row = db.query(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
        console.log(`  ${t.padEnd(20)} ${String(row?.c || 0).padStart(6)} 条记录`);
      }
      db.close();

      console.log("\n[搜索引擎]");
      for (const e of searchAggregator.listEngines()) {
        console.log(`  ${e.name.padEnd(15)} ${e.available ? "[可用]" : "[未配置]"}`);
      }

      console.log("\n[代理] 未配置代理池");
    },
  },

  search: {
    desc: "多引擎搜索 (search <query> [--engines=ddg,bing] [--num=10])",
    run: async (args) => { await handleSearch(args); },
  },

  esearch: {
    desc: "增强搜索 (esearch <query> [--mode=quick|deep|news|academic|code] [--num=10])",
    run: async (args) => { await handleESearch(args); },
  },

  "search:suggestions": {
    desc: "获取搜索建议 (search:suggestions <partial_query>)",
    run: async (args) => { await handleSearchSuggestions(args, dbPath); },
  },

  "search:stats": {
    desc: "搜索统计 (search:stats [--days=7])",
    run: async (args) => { await handleSearchStats(args, dbPath); },
  },

  "search:history": {
    desc: "搜索历史 (search:history [--limit=50])",
    run: async (args) => { await handleSearchHistory(args); },
  },

  "search:clear": {
    desc: "清除搜索缓存和历史",
    run: async () => { await handleSearchClear(); },
  },

  fetch: {
    desc: "结构化抓取网页 (fetch <url>)",
    run: async (args) => { await handleFetch(args); },
  },

  "vault:search": {
    desc: "Vault 确定性记忆搜索 (vault:search <query> [--limit=10] [--para=resources])",
    run: (args) => { handleVaultSearch(args); },
  },

  "vault:read": {
    desc: "读取 Vault 笔记 (vault:read <path>)",
    run: (args) => { handleVaultRead(args); },
  },

  "vault:para": {
    desc: "PARA 分类浏览 (vault:para <projects|areas|resources|archives>)",
    run: (args) => { handleVaultPara(args); },
  },

  "vault:stats": {
    desc: "Vault 记忆库统计",
    run: () => { handleVaultStats(); },
  },

  "vault:index-code": {
    desc: "索引项目代码到 Vault",
    run: async () => { await handleVaultIndexCode(); },
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
      } catch (e: unknown) {
        console.error("查询错误:", e instanceof Error ? e.message : String(e));
      }
      db.close();
    },
  },

  health: {
    desc: "执行平台健康检查",
    run: async () => {
      const platforms = [
        { name: "siliconflow", url: "https://api.siliconflow.cn/v1/models", key: readString("SILICONFLOW_API_KEY") },
        { name: "ofoxai", url: "https://api.ofox.ai/v1/models", key: readString("OFOXAI_API_KEY") },
        { name: "openrouter", url: "https://openrouter.ai/api/v1/models", key: readString("OPENROUTER_API_KEY") },
        { name: "deepseek", url: "https://api.deepseek.com/v1/models", key: readString("DEEPSEEK_API_KEY") },
        { name: "kimi-code", url: "https://api.kimi.com/coding/v1/models", key: readString("KIMI_CODE_API_KEY") },
      ];

      console.log("[健康检查] 平台健康检查:\n");
      for (const p of platforms) {
        if (!p.key) { console.log(`  [缺失] ${p.name.padEnd(12)} 未配置 API Key`); continue; }
        try {
          const res = await fetch(p.url, {
            headers: { Authorization: `Bearer ${p.key}` },
            signal: AbortSignal.timeout(5000),
          });
          console.log(`  ${res.ok ? "[正常]" : "[异常]"} ${p.name.padEnd(12)} ${res.status} ${res.statusText}`);
        } catch (e: unknown) {
          console.log(`  [错误] ${p.name.padEnd(12)} ${e instanceof Error ? e.message : String(e)}`);
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
    run: async (args) => { await handleDistill(args); },
  },

  "code:open": {
    desc: "启动 OpenCode 交互式编码会话 (code:open [prompt] [--model=opencode/deepseek-v4-flash-free])",
    run: async (args) => {
      const installed = await checkOpenCode();
      if (!installed) { console.log(getOpenCodeInstallGuide()); return; }
      const model = args.find((a) => a.startsWith("--model="))?.slice(8);
      const prompt = args.find((a) => !a.startsWith("--"));
      console.log(`[启动] OpenCode 会话 (模型: ${model || OPENCODE_FREE_MODELS[0]})...\n`);
      await openCodeSession({ cwd: process.cwd(), model, prompt });
    },
  },

  "code:models": {
    desc: "列出 OpenCode 可用模型",
    run: async () => {
      const installed = await checkOpenCode();
      if (!installed) { console.log(getOpenCodeInstallGuide()); return; }
      console.log("[OpenCode 推荐免费模型]\n");
      for (const m of OPENCODE_FREE_MODELS) console.log(`  • ${m}`);
      console.log("\n[所有可用模型]");
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
      console.log(`[启动] OpenCode 后台服务... 按 Ctrl+C 停止\n`);
      const server = startOpenCodeServer({ cwd: process.cwd(), port });
      process.on("SIGINT", () => { server.stop(); process.exit(0); });
      await new Promise(() => {}); // 永久等待
    },
  },

  "oc:tool": {
    desc: "OpenCode 工具 Agent — 轻量任务智能执行 (oc:tool <prompt> [--strategy=parallel] [--no-context])",
    run: async (args) => {
      const installed = await checkOpenCode();
      if (!installed) { console.log(getOpenCodeInstallGuide()); return; }

      const prompt = args.find((a) => !a.startsWith("--"));
      if (!prompt) { console.error("Usage: oc:tool <prompt> [--strategy=opencode-only|parallel|opencode-primary|axiom-only] [--no-context]"); return; }

      const strategyArg = args.find((a) => a.startsWith("--strategy="))?.slice(11) as ExecutionStrategy | undefined;
      const noContext = args.includes("--no-context");

      console.log(`[OpenCode Tool Agent] 分析任务并执行...\n`);

      const result = await quickExecute(prompt, {
        strategy: strategyArg,
        injectContext: !noContext,
        cwd: process.cwd(),
      });

      console.log(`\n═══════════════════════════════════════════════════════`);
      console.log(`策略: ${result.strategy}`);
      console.log(`模型: ${result.model} (${result.provider})`);
      console.log(`延迟: ${result.latencyMs}ms`);
      console.log(`节省 token: ${result.tokenSaved}`);
      console.log(`回退: ${result.fallbackUsed ? "是" : "否"}`);
      console.log(`上下文注入: ${result.contextInjected ? "是" : "否"}`);
      console.log(`工具: ${result.toolsUsed.join(", ") || "无"}`);
      console.log(`═══════════════════════════════════════════════════════\n`);
      console.log(result.content);
    },
  },

  "oc:health": {
    desc: "查看 OpenCode 工具 Agent 健康状态",
    run: async () => {
      const agent = getOpenCodeToolAgent(process.cwd());
      const report = agent.getHealthReport();
      console.log("[OpenCode Tool Agent 健康状态]\n");
      for (const [model, state] of Object.entries(report)) {
        console.log(`  ${model}:`);
        for (const [key, val] of Object.entries(state as Record<string, unknown>)) {
          console.log(`    ${key}: ${val}`);
        }
        console.log();
      }
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
      console.log(`[Kimi Code 编码中] (模型: ${KIMI_CODE_MODEL}, temp: ${temp})\n`);

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
      } catch (e: unknown) {
        console.error(`\n[错误] Kimi Code 调用失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },

  "kimi:open": {
    desc: "启动 Kimi Code CLI 交互式会话 (kimi:open [prompt])",
    run: async (args) => {
      const installed = await checkKimiCli();
      if (!installed) {
        console.log("[错误] kimi CLI 未安装。安装方式:\n");
        console.log("  macOS / Linux: curl -LsSf https://code.kimi.com/install.sh | bash");
        console.log("  Windows:       Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression\n");
        console.log(getKimiCodeGuide());
        return;
      }
      const prompt = args.find((a) => !a.startsWith("--"));
      console.log(`[启动] Kimi Code CLI 会话...\n`);
      await startKimiCliSession({ cwd: process.cwd(), prompt });
    },
  },

  "kimi:status": {
    desc: "检查 Kimi Code 配置和 CLI 状态",
    run: async () => {
      console.log("[Kimi Code 状态检查]\n");
      const apiKeyOk = checkKimiCodeApiKey();
      console.log(`  API Key:   ${apiKeyOk ? "[已配置]" : "[未配置] (KIMI_CODE_API_KEY)"}`);
      const cliOk = await checkKimiCli();
      console.log(`  CLI 工具:  ${cliOk ? "[已安装]" : "[未安装] (curl -LsSf https://code.kimi.com/install.sh | bash)"}`);
      console.log(`  模型 ID:   ${KIMI_CODE_MODEL}`);
      console.log(`  Base URL:  ${readString("KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1")}`);
      console.log(`\n使用指南: bun run src/cli.ts kimi:guide`);
    },
  },

  "kimi:guide": {
    desc: "显示 Kimi Code 安装与使用指南",
    run: () => {
      console.log(getKimiCodeGuide());
    },
  },

  "project:research": {
    desc: "使用 Hermes 深度研究 (project:research <topic>)",
    run: async (args) => {
      const topic = args.join(" ");
      if (!topic) { console.error("Usage: project:research <topic>"); return; }
      const installed = await checkHermes();
      if (!installed) { console.log("[错误] Hermes 未安装。运行: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"); return; }
      console.log(`[Hermes] 深度研究中...\n`);
      const result = await deepResearch(topic, process.cwd());
      console.log(result.stdout);
      if (result.stderr) console.error("[警告] stderr:", result.stderr);
    },
  },

  "analyze": {
    desc: "自动分析新项目 (analyze <path> [--depth=quick|standard|deep])",
    run: async (args) => {
      const projectPath = args.find((a) => !a.startsWith("--")) || ".";
      const depth = (args.find((a) => a.startsWith("--depth="))?.slice(8) || "standard") as "quick" | "standard" | "deep";
      const focusRaw = args.find((a) => a.startsWith("--focus="))?.slice(8);
      const focusAreas = focusRaw ? focusRaw.split(",") : undefined;

      console.log(`[项目分析] 路径: ${projectPath}, 深度: ${depth}\n`);
      const { indexNewProject } = await import("./agents/project-analyzer.js");
      const result = await indexNewProject({ projectPath, depth, focusAreas });

      console.log(`[分析完成] ${result.projectName}`);
      console.log(`  语言: ${Object.entries(result.structure.languages).map(([l, c]) => `${l}(${c})`).join(", ")}`);
      console.log(`  框架: ${result.structure.frameworks.map(f => f.name).join(", ") || "未检测到"}`);
      console.log(`  文件数: ${result.structure.totalFiles}`);
      console.log(`  知识图谱: ${result.kgEntities} 实体, ${result.kgRelationships} 关系`);
      console.log(`  代码图谱: ${result.codegraphNodes} 节点`);
      console.log(`  耗时: ${result.durationMs}ms\n`);
      console.log(result.architectureSummary);
      if (result.keyFindings.length > 0) {
        console.log("\n[关键发现]");
        for (const f of result.keyFindings) console.log(`  • ${f}`);
      }
      if (result.recommendations.length > 0) {
        console.log("\n[建议]");
        for (const r of result.recommendations) console.log(`  • ${r}`);
      }
    },
  },

  tui: {
    desc: "启动 TUI 终端交互界面",
    run: async () => {
      const { startTUI } = await import("./tui/app.js");
      await startTUI();
    },
  },

  diag: {
    desc: "运行系统诊断 (diag [--fix])",
    run: async (args) => {
      const autoFix = args.includes("--fix");
      const { runHealthCheck, printHealthReport } = await import("./core/health-checker.js");
      console.log("[诊断] 运行系统健康检查...\n");
      const report = await runHealthCheck();
      printHealthReport(report);

      if (autoFix) {
        console.log("[自动修复] 尝试修复可自动修复的问题...\n");
        const fixed: string[] = [];
        for (const check of report.checks) {
          if (check.autoFixable && check.fix) {
            try {
              const fs = await import("fs");
              // fix 串形如 "mkdir -p <dir>"（health-checker 内部生成）。
              // 不经 shell 直接创建目录，消除命令注入面
              if (check.fix.startsWith("mkdir")) {
                const dir = check.fix.replace(/^mkdir\s+(?:-p\s+)?/, "").trim();
                fs.mkdirSync(dir, { recursive: true });
                fixed.push(check.component);
              }
            } catch {
              // ignore
            }
          }
        }
        if (fixed.length > 0) {
          console.log(`✅ 已自动修复: ${fixed.join(", ")}\n`);
        } else {
          console.log("ℹ️ 没有可自动修复的问题\n");
        }
      }
    },
  },

  config: {
    desc: "配置管理 (config [get|set|list|validate] [key] [value])",
    run: async (args) => {
      const sub = args[0] || "list";
      const { getConfigCenter } = await import("./core/config-center.js");
      const center = getConfigCenter();

      switch (sub) {
        case "list": {
          const all = center.getAll();
          console.log("[配置列表]\n");
          for (const [key, val] of Object.entries(all)) {
            console.log(`  ${key.padEnd(35)} ${val.masked.padEnd(30)} [${val.source}]`);
          }
          break;
        }
        case "get": {
          const key = args[1];
          if (!key) { console.error("Usage: config get <key>"); return; }
          const value = center.getString(key);
          console.log(`${key} = ${value || "(not set)"}`);
          break;
        }
        case "set": {
          const key = args[1];
          const value = args[2];
          if (!key || value === undefined) { console.error("Usage: config set <key> <value>"); return; }
          center.set(key, value, "cli", true);
          console.log(`✅ ${key} = ${value}`);
          break;
        }
        case "validate": {
          const result = center.validate();
          console.log("[配置验证]\n");
          console.log(`状态: ${result.valid ? "✅ 有效" : "❌ 无效"}\n`);
          if (result.missing.length > 0) {
            console.log("缺失配置:");
            for (const m of result.missing) console.log(`  ❌ ${m.key} — ${m.description}`);
          }
          if (result.errors.length > 0) {
            console.log("错误:");
            for (const e of result.errors) console.log(`  ❌ ${e.key} — ${e.message}`);
          }
          if (result.warnings.length > 0) {
            console.log("警告:");
            for (const w of result.warnings) console.log(`  ⚠️ ${w.key} — ${w.message}`);
          }
          if (result.valid && result.errors.length === 0 && result.warnings.length === 0) {
            console.log("✅ 所有配置项有效");
          }
          break;
        }
        case "diagnose": {
          const results = center.diagnose();
          console.log("[配置诊断]\n");
          for (const r of results) {
            const icon = r.status === "ok" ? "✅" : r.status === "warning" ? "⚠️" : "❌";
            console.log(`  ${icon} ${r.component.padEnd(15)} ${r.message}`);
            if (r.fix) console.log(`     💡 ${r.fix}`);
          }
          break;
        }
        default:
          console.error("Usage: config [get|set|list|validate|diagnose]");
      }
    },
  },

  chat: {
    desc: "AI 聊天 (chat <message> [--no-intent])",
    run: async (args) => {
      const message = args.find((a) => !a.startsWith("--"));
      if (!message) { console.error("Usage: chat <message>"); return; }
      const noIntent = args.includes("--no-intent");

      let intent: ReturnType<typeof buildAgentMessages>["intent"] | null = null;
      let messages: ReturnType<typeof buildAgentMessages>["messages"] = [];

      if (!noIntent) {
        console.log(`[意图识别] 正在识别...\n`);
        const { buildAgentMessages } = await import("./agents/intent-router.js");
        const result = buildAgentMessages(message);
        intent = result.intent;
        messages = result.messages;

        if (intent) {
          console.log(`[意图] ${intent.agentName} (${intent.intent})`);
          console.log(`   置信度: ${(intent.confidence * 100).toFixed(0)}%`);
          console.log(`   匹配词: ${intent.matchedKeywords.join(", ") || "无"}\n`);
        } else {
          console.log(`[意图] 通用助手\n`);
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
        console.log(`[调用] 决策层 (DeepSeek-V4 Pro)...\n`);
        result = await router.decide(messages);
      } else if (["architecture", "system-design", "infra"].includes(intentType || "")) {
        console.log(`[调用] 架构层 (GLM-5.1)...\n`);
        result = await router.architect(messages);
      } else if (["engineering", "game-development", "integrations", "testing"].includes(intentType || "")) {
        console.log(`[调用] 工具层 (编码免费模型)...\n`);
        result = await router.tool("coding", messages);
      } else if (["english", "translation", "localization"].includes(intentType || "")) {
        console.log(`[调用] 工具层 (英文处理)...\n`);
        result = await router.tool("english", messages);
      } else if (["rl", "reasoning", "optimization"].includes(intentType || "")) {
        console.log(`[调用] 工具层 (RL/推理)...\n`);
        result = await router.tool("rl", messages);
      } else {
        const taskType = ["academic", "product", "project-management"].includes(intentType || "")
          ? "code-generation"
          : "general-chat";
        result = await router.chat(taskType, messages);
      }

      console.log(`[AI] ${result.provider} / ${result.model}\n`);
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
      console.log("[初始化] CodeGraph...\n");
      await initializeCodegraph();
      const status = await getStatus();
      console.log("[完成] CodeGraph 初始化完成");
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
      console.log(`[搜索] CodeGraph 搜索结果: "${query}" (${results.length} 个符号)\n`);
      for (const r of results.slice(0, limit)) {
        console.log(`  ${r.node.kind} ${r.node.name}`);
        console.log(`     [文件] ${r.node.filePath}:${r.node.startLine}`);
        console.log(`     [签名] ${r.node.signature ?? "no signature"}`);
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
      console.log("[构建] CodeGraph 上下文...\n");
      const context = await buildContext(task, { maxNodes: 15, includeCode: true });
      console.log(context);
    },
  },

  "model:status": {
    desc: "查看模型路由状态和工具池健康度",
    run: async () => {
      const { toolPool } = await import("./router/tool-pool.js");
      const stats = toolPool.getStats() as Record<string, { role?: string; [key: string]: unknown }>;
      console.log("[模型路由] 分层状态\n");
      console.log("  L1 决策层:    DeepSeek-V4 Pro (paid)");
      console.log("  L2 架构层:    GLM-5.1 (paid)");
      console.log("  L3 工具层:    免费模型池（带限流）");
      console.log("  L4 评估层:    Tencent hy3-preview ($5额度) + DeepSeek-V4 Pro\n");

      console.log("[工具池] 健康度:\n");
      interface ToolModel {
        id: string;
        role?: string;
        health: string;
        rpmThisMinute: number;
        rpmLimit: number;
        activeRequests: number;
        totalCalls: number;
        totalFailures: number;
      }
      const grouped: Record<string, ToolModel[]> = {};
      for (const [id, s] of Object.entries(stats)) {
        const role = s.role as string;
        if (!grouped[role]) grouped[role] = [];
        grouped[role].push({ id, ...s } as ToolModel);
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
      console.log("[Agent 状态检查]\n");
      const opencodeOk = await checkOpenCode();
      console.log(`  OpenCode: ${opencodeOk ? "[已安装]" : "[未安装] (curl -fsSL https://opencode.ai/install.sh | bash)"}`);
      if (opencodeOk) {
        console.log(`  [OpenCode 免费模型]`);
        for (const m of OPENCODE_FREE_MODELS) console.log(`    • ${m}`);
      }
      const hermesOk = await checkHermes();
      console.log(`  Hermes:    ${hermesOk ? "[已安装]" : "[未安装] (curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash)"}`);
      const kimiApiOk = checkKimiCodeApiKey();
      const kimiCliOk = await checkKimiCli();
      console.log(`  Kimi Code: ${kimiApiOk || kimiCliOk ? "[OK]" : "[缺失]"} API Key ${kimiApiOk ? "已配置" : "未配置"} | CLI ${kimiCliOk ? "已安装" : "未安装"}`);

      // Prompt Engineer 状态
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      const templates = promptEngineer.listTemplates();
      const skills = promptEngineer.listSkills();
      console.log(`\n  Prompt Engineer:`);
      console.log(`    模板数: ${templates.length}`);
      console.log(`    Skill数: ${skills.length}`);
      console.log(`    匹配模式: 确定性关键词计数（共享 cosineSimilarity 仅可选语义层）`);
    },
  },

  "computer:use": {
    desc: "Computer Use — 视觉模型分析截图并返回操作指令 (computer:use <task> [--image=path.png] [--model=gpt-5.5])",
    run: async (args) => {
      const task = args.find((a) => !a.startsWith("--"));
      if (!task) { console.error("Usage: computer:use <task> [--image=path.png] [--model=gpt-5.5] [--url=https://...]"); return; }

      const imagePath = args.find((a) => a.startsWith("--image="))?.slice(8);
      const imageUrl = args.find((a) => a.startsWith("--url="))?.slice(6);
      const modelId = args.find((a) => a.startsWith("--model="))?.slice(8);

      let imageBase64: string | undefined;
      if (imagePath) {
        const fs = await import("fs");
        if (!fs.existsSync(imagePath)) { console.error(`图片不存在: ${imagePath}`); return; }
        const buffer = fs.readFileSync(imagePath);
        imageBase64 = buffer.toString("base64");
      }

      const { analyzeScreenshot } = await import("./agents/computer-use-agent.js");
      console.log(`[Computer Use] 分析中... (任务: ${task})\n`);
      const result = await analyzeScreenshot({
        task,
        imageBase64,
        imageUrl,
        modelId,
      });

      console.log(`模型: ${result.model} (${result.provider})`);
      console.log(`延迟: ${result.latencyMs}ms`);
      console.log(`完成: ${result.completed ? "是" : "否"}\n`);
      console.log(`思考: ${result.reasoning}\n`);
      console.log("建议操作:");
      for (const action of result.actions) {
        console.log(`  [${action.type}] ${JSON.stringify(action)}`);
      }
    },
  },

  "computer:models": {
    desc: "列出可用的 Computer Use 视觉模型",
    run: async () => {
      const { getComputerUseAgent } = await import("./agents/computer-use-agent.js");
      const agent = getComputerUseAgent();
      const models = agent.listVisionModels();
      console.log("[Computer Use 可用视觉模型]\n");
      for (const m of models) {
        console.log(`  ${m.id.padEnd(25)} ${m.provider.padEnd(15)} ctx=${m.contextWindow}`);
      }
      console.log(`\n共 ${models.length} 个模型`);
    },
  },

  "agents:discover": {
    desc: "自动发现并更新 Agent 索引",
    run: async () => {
      const { discoverAgents, listAgentSources } = await import("./agents/agent-discovery.js");
      const sources = listAgentSources();
      console.log("[Agent 自动发现]\n");
      if (sources.length === 0) {
        console.log("[警告] 未找到 Agent 源目录");
        console.log("  将 Agent .md 文件放入 ./data/agents/ 目录，或设置 AGENTS_DIR 环境变量");
        console.log("  例如: AGENTS_DIR=./agency-agents-main bun run src/cli.ts agents:discover");
        return;
      }
      console.log(`  发现 ${sources.length} 个源目录:`);
      for (const s of sources) console.log(`    • ${s}`);
      console.log("");
      for (const sourceDir of sources) {
        const result = discoverAgents({ sourceDir, force: false });
        console.log(`  [完成] ${sourceDir}`);
        console.log(`     总计: ${result.count} 个 Agent`);
        console.log(`     新增: ${result.newCount} | 更新: ${result.updatedCount} | 跳过: ${result.skippedCount}`);
        console.log(`     分类: ${result.categories.join(", ")}`);
        console.log("");
      }
      console.log("  索引已保存到 ./data/agents-index.json");
    },
  },

  "prompt:list": {
    desc: "列出所有提示词模板 (prompt:list [--category=engineering])",
    run: async (args) => {
      const category = args.find((a) => a.startsWith("--category="))?.slice(11);
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      const templates = promptEngineer.listTemplates(category);
      console.log(`[提示词模板] (${category || "全部"})\n`);
      for (const t of templates) {
        console.log(`  [${t.category}] ${t.name} (${t.id})`);
        console.log(`     描述: ${t.description}`);
        console.log(`     思考强度: ${t.thinkingIntensity}`);
        console.log(`     标签: ${t.tags.join(", ")}`);
        console.log(`     变量: ${t.variables.join(", ")}`);
        console.log();
      }
      console.log(`共 ${templates.length} 个模板`);
    },
  },

  "prompt:match": {
    desc: "匹配提示词模板 (prompt:match <task_description> [--intensity=low|medium|high])",
    run: async (args) => {
      const desc = args.find((a) => !a.startsWith("--"));
      if (!desc) { console.error("Usage: prompt:match <task_description>"); return; }
      const intensity = args.find((a) => a.startsWith("--intensity="))?.slice(12) as "low" | "medium" | "high" | undefined;
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      const match = promptEngineer.matchTemplate(desc, { thinkingIntensity: intensity });
      if (!match) {
        console.log("[错误] 未找到匹配的模板");
        return;
      }
      console.log(`[匹配] 模板: ${match.template.name}`);
      console.log(`   分数: ${match.score}`);
      console.log(`   原因: ${match.reasons.join(", ")}`);
      console.log(`   思考强度: ${match.template.thinkingIntensity}`);
      console.log(`\n--- 模板内容 ---\n`);
      console.log(match.template.template.slice(0, 500));
      if (match.template.template.length > 500) console.log("...");
    },
  },

  "prompt:fill": {
    desc: "填充提示词模板 (prompt:fill <template_id> <json_variables>)",
    run: async (args) => {
      const templateId = args[0];
      const varsJson = args[1];
      if (!templateId || !varsJson) { console.error("Usage: prompt:fill <template_id> <json_variables>"); return; }
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      const template = promptEngineer.listTemplates().find((t) => t.id === templateId);
      if (!template) { console.error(`模板不存在: ${templateId}`); return; }
      const variables = JSON.parse(varsJson);
      const filled = promptEngineer.fillTemplate(template, variables);
      console.log(`[填充] 模板: ${template.name}\n`);
      console.log(filled);
    },
  },

  "prompt:skill": {
    desc: "匹配 Skill (prompt:skill <trigger>)",
    run: async (args) => {
      const trigger = args.join(" ");
      if (!trigger) { console.error("Usage: prompt:skill <trigger>"); return; }
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      const skill = promptEngineer.matchSkill(trigger);
      if (!skill) {
        console.log("[错误] 未找到匹配的 Skill");
        return;
      }
      console.log(`[匹配] Skill: ${skill.name}`);
      console.log(`   描述: ${skill.description}`);
      console.log(`   触发词: ${skill.triggers.join(", ")}`);
      console.log(`   所需工具: ${skill.requiredTools.join(", ")}`);
      console.log(`   输出格式: ${skill.outputFormat}`);
    },
  },

  "prompt:generate": {
    desc: "使用 Hermes 生成新提示词模板 (prompt:generate <description> <category> [var1,var2,...])",
    run: async (args) => {
      const description = args[0];
      const category = args[1];
      const vars = args[2]?.split(",") || [];
      if (!description || !category) { console.error("Usage: prompt:generate <description> <category> [var1,var2,...]"); return; }
      const { checkHermes } = await import("./agents/hermes-agent.js");
      const installed = await checkHermes();
      if (!installed) { console.log("[错误] Hermes 未安装"); return; }
      console.log(`[Hermes] 生成提示词模板...\n`);
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      const template = await promptEngineer.generateTemplateWithHermes(description, category, vars);
      if (!template) { console.log("[错误] 生成失败"); return; }
      console.log(`[生成] 模板: ${template.name}`);
      console.log(`   ID: ${template.id}`);
      console.log(`   思考强度: ${template.thinkingIntensity}`);
      console.log(`\n--- 模板内容 ---\n`);
      console.log(template.template);
    },
  },

  "prompt:optimize": {
    desc: "使用 Hermes 优化提示词 (prompt:optimize <goal>)",
    run: async (args) => {
      const goal = args.join(" ");
      if (!goal) { console.error("Usage: prompt:optimize <goal>"); return; }
      // 从 stdin 读取提示词
      console.log("请粘贴要优化的提示词 (Ctrl+D 结束):\n");
      const prompt = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.on("data", (chunk) => { data += chunk; });
        process.stdin.on("end", () => resolve(data));
      });
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      console.log("[优化中]...\n");
      const optimized = await promptEngineer.optimizePromptWithHermes(prompt, goal);
      if (!optimized) { console.log("[错误] 优化失败"); return; }
      console.log(`[优化完成]\n\n${optimized}`);
    },
  },

  "prompt:hermes-skill": {
    desc: "使用 Hermes 生成 Skill 定义 (prompt:hermes-skill <name> <description> [trigger1,trigger2,...])",
    run: async (args) => {
      const name = args[0];
      const description = args[1];
      const triggers = args[2]?.split(",") || [];
      if (!name || !description) { console.error("Usage: prompt:hermes-skill <name> <description> [triggers]"); return; }
      const { checkHermes } = await import("./agents/hermes-agent.js");
      const installed = await checkHermes();
      if (!installed) { console.log("[错误] Hermes 未安装"); return; }
      console.log(`[Hermes] 生成 Skill...\n`);
      const { getPromptEngineer } = await import("./agents/prompt-engineer.js");
      const promptEngineer = getPromptEngineer();
      const skill = await promptEngineer.generateSkillWithHermes(name, description, triggers);
      if (!skill) { console.log("[错误] 生成失败"); return; }
      console.log(`[生成] Skill: ${skill.name}`);
      console.log(`   ID: ${skill.id}`);
      console.log(`   触发词: ${skill.triggers.join(", ")}`);
      console.log(`   所需工具: ${skill.requiredTools.join(", ")}`);
    },
  },

  "kg:build": {
    desc: "构建知识图谱 (kg:build --path=. --name=axiom [--embeddings])",
    run: async (args) => { await handleKgBuild(args); },
  },

  "kg:stats": {
    desc: "查看知识图谱统计",
    run: async () => { await handleKgStats(); },
  },

  "kg:search": {
    desc: "搜索知识图谱 (kg:search <query> [--limit=10])",
    run: async (args) => { await handleKgSearch(args); },
  },

  "kg:query": {
    desc: "自然语言查询知识图谱 (kg:query <question> [--limit=5])",
    run: async (args) => { await handleKgQuery(args); },
  },

  "kg:feedback": {
    desc: "知识图谱反馈 — 对查询结果评价以改进 (kg:feedback <query> [--relevant|--irrelevant] [--entity=<id>])",
    run: async (args) => { await handleKgFeedback(args); },
  },

  "knowledge:collect": {
    desc: "收集开放教育资源 (knowledge:collect --domain=mathematics|computer-science|philosophy|dictionary [--subdomain=<topic>] [--max=5] [--force])",
    run: async (args) => { await handleKnowledgeCollect(args); },
  },

  "knowledge:stats": {
    desc: "知识收集统计",
    run: async () => { await handleKnowledgeStats(); },
  },

  "knowledge:pipeline": {
    desc: "运行完整知识采集管道 (knowledge:pipeline --github --topics=ml,algorithms --pdf-worker=http://192.168.2.11:8000)",
    run: async (args) => { await handleKnowledgePipeline(args); },
  },

  "eval:eval": {
    desc: "运行模型评估 (eval:eval [--full] [--models=a,b] [--benchmarks])",
    run: async (args) => { await handleEvalCommands(["eval", ...args]); },
  },

  "eval:assign": {
    desc: "运行动态模型分配 (eval:assign [--force])",
    run: async (args) => { await handleEvalCommands(["assign", ...args]); },
  },

  "eval:stats": {
    desc: "查看评估统计 (eval:stats)",
    run: async (args) => { await handleEvalCommands(["stats", ...args]); },
  },

  "eval:results": {
    desc: "查看最新评估结果 (eval:results [--top=20])",
    run: async (args) => { await handleEvalCommands(["results", ...args]); },
  },

  "eval:trend": {
    desc: "查看模型评估趋势 (eval:trend <modelId> [--days=30])",
    run: async (args) => { await handleEvalCommands(["trend", ...args]); },
  },

  "advisor:recommend": {
    desc: "模型推荐 (advisor:recommend --role=coding|research|general)",
    run: async (args) => {
      const role = args.find((a) => a.startsWith("--role="))?.slice(7) || "coding";
      const { recommendModels } = await import("./router/model-advisor.js");
      console.log(`[模型推荐] 角色: ${role}\n`);
      const recs = await recommendModels(role);
      if (recs.length === 0) {
        console.log("  暂无推荐模型");
        return;
      }
      for (const r of recs.slice(0, 10)) {
        console.log(`  ${r.modelId || JSON.stringify(r).slice(0, 80)}`);
      }
    },
  },

  "advisor:free": {
    desc: "发现免费模型",
    run: async () => {
      const { discoverFreeModels } = await import("./router/model-advisor.js");
      console.log("[发现免费模型]\n");
      const models = await discoverFreeModels();
      if (models.length === 0) {
        console.log("  未发现免费模型");
        return;
      }
      for (const m of models) {
        console.log(`  ${m.id || m.name || JSON.stringify(m).slice(0, 80)}`);
      }
    },
  },

  "advisor:evolve": {
    desc: "触发模型进化周期",
    run: async () => {
      const { runEvolutionCycle } = await import("./router/model-advisor.js");
      console.log("[模型进化] 开始进化周期...\n");
      const result = await runEvolutionCycle();
      console.log("[进化完成]");
      console.log(JSON.stringify(result, null, 2));
    },
  },

  "research": {
    desc: "KG增强深度研究 (research <query> [--depth=quick|deep|exhaustive])",
    run: async (args) => {
      const query = args.filter((a) => !a.startsWith("--")).join(" ");
      if (!query) { console.error("Usage: research <query>"); return; }
      const depth = (args.find((a) => a.startsWith("--depth="))?.slice(8) || "deep") as "quick" | "deep" | "exhaustive";
      console.log(`[深度研究] "${query}" (深度: ${depth})\n`);
      const { runKnowledgeGraphResearch } = await import("./agents/kg-research-agent.js");
      const result = await runKnowledgeGraphResearch({ query, depth });
      console.log(`[研究完成] 模型: ${result.model}, 耗时: ${result.durationMs}ms, 置信度: ${result.confidence}\n`);
      console.log(`引用实体: ${result.referencedEntities.length}`);
      console.log(`新发现实体: ${result.newFindings.entities.length}\n`);
      console.log(result.conclusion);
    },
  },

  help: {
    desc: "显示帮助信息",
    run: (args) => {
      if (args.includes("--all")) {
        console.log("Axiom AI Agent CLI — 完整命令列表\n");
        const maxLen = Math.max(...Object.keys(commands).map(k => k.length));
        for (const [name, cmd] of Object.entries(commands)) {
          if (name === "help") continue;
          console.log(`  ${name.padEnd(maxLen)}  ${cmd.desc}`);
        }
        console.log("\n  help                 显示帮助信息");
        return;
      }

      console.log("Axiom AI Agent CLI\n");
      console.log("用法: axiom <命令> [子命令] [参数...]\n");

      console.log("核心命令:");
      console.log("  status              系统状态概览");
      console.log("  chat <消息>         AI 对话 (自动路由)");
      console.log("  research <主题>     深度研究 (KG增强)");
      console.log("  analyze <路径>      自动分析新项目");
      console.log("  health              平台健康检查");
      console.log("  tui                 启动终端界面\n");

      console.log("子命令组:");
      console.log("  search <query>      搜索 (search run|enhanced|history)");
      console.log("  vault <action>      记忆库 (vault search|read|stats|para)");
      console.log("  kg <action>         知识图谱 (kg build|stats|search|query|feedback)");
      console.log("  cg <action>         代码图谱 (cg init|search|context)");
      console.log("  project <action>    项目分析 (project analyze|research)");
      console.log("  code <action>       OpenCode (code open|models|serve)");
      console.log("  kimi <action>       Kimi (kimi chat|open|status)");
      console.log("  agent <action>      Agent管理 (agent status|discover)");
      console.log("  advisor <action>    模型顾问 (advisor recommend|free|evolve)");
      console.log("  prompt <action>     提示词 (prompt list|match|fill)\n");

      console.log("快捷别名:");
      console.log("  s = search, c = chat, r = research, k = kg, v = vault\n");

      console.log("示例:");
      console.log("  axiom s \"React 19 新特性\"          搜索");
      console.log("  axiom c \"帮我写HTTP服务器\"          对话");
      console.log("  axiom r \"多智能体架构分析\"          深度研究");
      console.log("  axiom p analyze ../my-project       分析新项目");
      console.log("  axiom kg build --path=. --name=x   构建知识图谱");
      console.log("  axiom vault search \"部署方案\"       记忆库搜索");
      console.log("  axiom advisor free                  发现免费模型\n");

      console.log("高级命令: axiom help --all");
    },
  },
};

// ===== 二级子命令分发 =====

const subcommands: Record<string, Record<string, { desc: string; run: (args: string[]) => Promise<void> | void }>> = {
  kg: {
    build: commands["kg:build"],
    stats: commands["kg:stats"],
    search: commands["kg:search"],
    query: commands["kg:query"],
    feedback: commands["kg:feedback"],
  },
  knowledge: {
    collect: commands["knowledge:collect"],
    stats: commands["knowledge:stats"],
    pipeline: commands["knowledge:pipeline"],
  },
  cg: {
    init: commands["cg:init"],
    search: commands["cg:search"],
    context: commands["cg:context"],
  },
  vault: {
    search: commands["vault:search"],
    read: commands["vault:read"],
    para: commands["vault:para"],
    stats: commands["vault:stats"],
    index: commands["vault:index-code"],
  },
  code: {
    open: commands["code:open"],
    models: commands["code:models"],
    serve: commands["code:serve"],
  },
  kimi: {
    chat: commands["kimi:chat"],
    open: commands["kimi:open"],
    status: commands["kimi:status"],
    guide: commands["kimi:guide"],
  },
  agent: {
    status: commands["agent:status"],
    discover: commands["agents:discover"],
    models: commands["code:models"],
  },
  advisor: {
    recommend: commands["advisor:recommend"],
    free: commands["advisor:free"],
    evolve: commands["advisor:evolve"],
    status: commands["model:status"],
  },
  prompt: {
    list: commands["prompt:list"],
    match: commands["prompt:match"],
    fill: commands["prompt:fill"],
    skill: commands["prompt:skill"],
    generate: commands["prompt:generate"],
    optimize: commands["prompt:optimize"],
  },
  project: {
    analyze: commands["analyze"],
    research: commands["project:research"],
  },
  search: {
    run: commands["search"],
    enhanced: commands["esearch"],
    suggestions: commands["search:suggestions"],
    stats: commands["search:stats"],
    history: commands["search:history"],
    clear: commands["search:clear"],
  },
  eval: {
    eval: commands["eval:eval"],
    assign: commands["eval:assign"],
    stats: commands["eval:stats"],
    results: commands["eval:results"],
    trend: commands["eval:trend"],
  },
};

// Short aliases for common commands
const aliases: Record<string, string> = {
  s: "search",        // axiom s "query" → axiom search "query"
  c: "chat",          // axiom c "message"
  r: "research",      // axiom r "topic"
  k: "kg",            // axiom k build
  v: "vault",         // axiom v search
  p: "project",       // axiom p analyze <path>
  h: "help",
};

// ===== 入口 =====

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    commands.help.run([]);
    return;
  }

  // Resolve alias
  const resolvedCmd = aliases[cmd] || cmd;

  // Check for subcommand: `axiom kg build` or `axiom kg:build`
  if (args.length > 0 && subcommands[resolvedCmd]?.[args[0]]) {
    const sub = args[0];
    try {
      await subcommands[resolvedCmd][sub].run(args.slice(1));
    } catch (e: unknown) {
      logger.error(`CLI "${resolvedCmd} ${sub}" failed`, e instanceof Error ? e : new Error(String(e)));
      console.error(`\n[错误] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return;
  }

  // Also support colon syntax: `axiom kg:build`
  const handler = commands[resolvedCmd];
  if (handler) {
    try {
      await handler.run(args);
    } catch (e: unknown) {
      logger.error(`CLI command "${resolvedCmd}" failed`, e instanceof Error ? e : new Error(String(e)));
      console.error(`\n[错误] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return;
  }

  // Check if it's a subcommand group without sub-action
  if (subcommands[resolvedCmd]) {
    console.log(`\n用法: axiom ${resolvedCmd} <子命令>\n`);
    console.log(`可用子命令:`);
    const maxLen = Math.max(...Object.keys(subcommands[resolvedCmd]).map(k => k.length));
    for (const [name, sub] of Object.entries(subcommands[resolvedCmd])) {
      console.log(`  ${name.padEnd(maxLen)}  ${sub.desc}`);
    }
    return;
  }

  console.error(`未知命令: ${cmd}`);
  console.error(`运行 "axiom help" 查看可用命令\n`);
  // Suggest closest match
  const allCmds = [...Object.keys(commands), ...Object.keys(subcommands), ...Object.keys(aliases)];
  const suggestion = allCmds.find(c => c.startsWith(cmd.slice(0, 2)) || c.includes(cmd));
  if (suggestion) console.error(`你可能想输入: ${suggestion}`);
  process.exit(1);
}

main();
