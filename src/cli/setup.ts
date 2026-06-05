import { createInterface } from "readline";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

interface ProviderConfig {
  key: string;
  name: string;
  description: string;
  baseUrl?: string;
  required: boolean;
}

const providers: ProviderConfig[] = [
  {
    key: "DEEPSEEK_API_KEY",
    name: "DeepSeek",
    description: "DeepSeek V4 Pro/Flash, R1 - 高性价比中文模型",
    baseUrl: "https://api.deepseek.com",
    required: true,
  },
  {
    key: "SILICONFLOW_API_KEY",
    name: "SiliconFlow",
    description: "SiliconFlow - 国内聚合平台 (Qwen3, DeepSeek, GLM 等)",
    baseUrl: "https://api.siliconflow.cn/v1",
    required: true,
  },
  {
    key: "OFOXAI_API_KEY",
    name: "OFOX AI",
    description: "OFOX AI - 海外聚合平台 (GPT-5.5, Claude 4.7, Gemini 3.1)",
    baseUrl: "https://api.ofoxai.com/v1",
    required: true,
  },
  {
    key: "OPENROUTER_API_KEY",
    name: "OpenRouter",
    description: "OpenRouter - 全球模型路由 (627+ 模型)",
    baseUrl: "https://openrouter.ai/api/v1",
    required: true,
  },
  {
    key: "OFOXAI_ANTHROPIC_API_KEY",
    name: "OFOX AI (Anthropic)",
    description: "OFOX AI Anthropic 专用通道 (Claude Opus 4.7, Claude Sonnet 4.6)",
    baseUrl: "https://api.ofoxai.com/anthropic",
    required: false,
  },
  {
    key: "OFOXAI_GEMINI_API_KEY",
    name: "OFOX AI (Gemini)",
    description: "OFOX AI Gemini 专用通道 (Gemini 3.1 Pro, Gemini 3.5 Flash)",
    baseUrl: "https://api.ofoxai.com/gemini",
    required: false,
  },
  {
    key: "OPENCODE_API_KEY",
    name: "OpenCode",
    description: "OpenCode - 代码专用模型",
    baseUrl: "https://api.opencode.gg/v1",
    required: false,
  },
  {
    key: "KIMI_API_KEY",
    name: "Kimi (Moonshot)",
    description: "Kimi - Moonshot AI (超长上下文 256K+)",
    baseUrl: "https://api.moonshot.cn/v1",
    required: false,
  },
  {
    key: "MINIMAX_API_KEY",
    name: "MiniMax",
    description: "MiniMax - 海螺AI (M2.7, M3)",
    baseUrl: "https://api.minimax.chat/v1",
    required: false,
  },
  {
    key: "TOGETHER_AI_API_KEY",
    name: "Together AI",
    description: "Together AI - 开源模型专用推理 (Llama 4, Qwen3 等)",
    baseUrl: "https://api.together.xyz/v1",
    required: false,
  },
  {
    key: "FIREWORKS_AI_API_KEY",
    name: "Fireworks AI",
    description: "Fireworks AI - 超低延迟推理 (Llama 4, 提示缓存)",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    required: false,
  },
  {
    key: "REPLICATE_API_KEY",
    name: "Replicate",
    description: "Replicate - 社区模型 (按时间计费)",
    baseUrl: "https://api.replicate.com/v1",
    required: false,
  },
];

const optionalConfigs = [
  {
    key: "SERPAPI_KEY",
    name: "SerpAPI",
    description: "Google 搜索 API (用于知识检索增强)",
    required: false,
  },
  {
    key: "GITHUB_TOKEN",
    name: "GitHub Token",
    description: "GitHub Personal Access Token (用于代码仓库操作)",
    required: false,
  },
];

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           OpenClaw AI Agent - 交互式配置向导                  ║
║                        v2.2.0                                ║
╚══════════════════════════════════════════════════════════════╝
`);
}

function printSection(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}\n`);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

function validateKey(key: string, provider: string): boolean {
  if (!key || key.length < 8) return false;

  // 基本格式验证
  if (provider === "OPENROUTER_API_KEY" && !key.startsWith("sk-or-")) {
    return false;
  }
  if (provider === "DEEPSEEK_API_KEY" && !key.startsWith("sk-")) {
    return false;
  }

  return true;
}

function generateEnvContent(configs: Record<string, string>): string {
  const lines: string[] = [
    "# OpenClaw AI Agent - 环境变量配置",
    "# 生成时间: " + new Date().toISOString(),
    "",
    "# ══════════════════════════════════════════════════════════════",
    "# 核心模型提供商 (至少配置 2-3 个以确保冗余)",
    "# ══════════════════════════════════════════════════════════════",
    "",
  ];

  // 必需和主要提供商
  const mainProviders = providers.filter((p) => p.required || ["DEEPSEEK_API_KEY", "SILICONFLOW_API_KEY", "OFOXAI_API_KEY", "OPENROUTER_API_KEY"].includes(p.key));
  for (const provider of mainProviders) {
    const value = configs[provider.key] || "";
    lines.push(`# ${provider.name}`);
    lines.push(`# ${provider.description}`);
    if (provider.baseUrl) {
      lines.push(`${provider.key.replace("_API_KEY", "_BASE_URL")}=${provider.baseUrl}`);
    }
    lines.push(`${provider.key}=${value}`);
    lines.push("");
  }

  // 可选提供商
  lines.push("# ══════════════════════════════════════════════════════════════");
  lines.push("# 可选模型提供商 (按需配置)");
  lines.push("# ══════════════════════════════════════════════════════════════");
  lines.push("");

  const optionalProviders = providers.filter((p) => !mainProviders.includes(p));
  for (const provider of optionalProviders) {
    const value = configs[provider.key] || "";
    lines.push(`# ${provider.name}`);
    lines.push(`# ${provider.description}`);
    if (provider.baseUrl) {
      lines.push(`${provider.key.replace("_API_KEY", "_BASE_URL")}=${provider.baseUrl}`);
    }
    lines.push(`${provider.key}=${value}`);
    lines.push("");
  }

  // 其他可选配置
  lines.push("# ══════════════════════════════════════════════════════════════");
  lines.push("# 其他可选配置");
  lines.push("# ══════════════════════════════════════════════════════════════");
  lines.push("");

  for (const config of optionalConfigs) {
    const value = configs[config.key] || "";
    lines.push(`# ${config.name}`);
    lines.push(`# ${config.description}`);
    lines.push(`${config.key}=${value}`);
    lines.push("");
  }

  lines.push("# ══════════════════════════════════════════════════════════════");
  lines.push("# 高级配置 (可选)");
  lines.push("# ══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("# 日志级别: debug | info | warn | error");
  lines.push("LOG_LEVEL=info");
  lines.push("");
  lines.push("# 上下文窗口最大使用率 (0.0-1.0, 超过将触发分割)");
  lines.push("CONTEXT_MAX_USAGE=0.6");
  lines.push("");
  lines.push("# 并行读取线程数");
  lines.push("PARALLEL_READ_THREADS=3");
  lines.push("");
  lines.push("# 是否启用优雅降级");
  lines.push("ENABLE_GRACEFUL_DEGRADATION=true");
  lines.push("");
  lines.push("# CodeGraph 自动索引间隔 (毫秒)");
  lines.push("CODEGRAPH_REINDEX_INTERVAL=30000");
  lines.push("");

  return lines.join("\n");
}

export async function runSetupWizard(args: string[]) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const configs: Record<string, string> = {};
  const envPath = join(process.cwd(), ".env");

  // 尝试读取现有的 .env 文件
  if (existsSync(envPath)) {
    printSection("检测到现有配置");
    const existingContent = readFileSync(envPath, "utf-8");
    const lines = existingContent.split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !match[1].endsWith("_BASE_URL")) {
        configs[match[1]] = match[2];
      }
    }
    console.log("已加载现有配置，您可以更新或添加新的 API Key。\n");
  }

  printBanner();

  console.log("欢迎使用 OpenClaw AI Agent 配置向导！");
  console.log("本向导将帮助您配置所有支持的 LLM 厂商 API Key。\n");
  console.log("💡 提示:");
  console.log("   - 至少配置 2-3 个厂商以确保系统冗余和降级能力");
  console.log("   - 按 Ctrl+C 可随时退出，已输入的内容不会保存");
  console.log("   - 留空表示跳过该项配置\n");

  // 主要提供商
  printSection("主要模型提供商 (推荐配置)");

  for (const provider of providers.filter((p) => p.required)) {
    const currentValue = configs[provider.key];
    const currentHint = currentValue ? ` [当前: ${maskKey(currentValue)}]` : "";

    console.log(`${provider.name}`);
    console.log(`  ${provider.description}`);

    if (currentValue) {
      const update = await prompt(rl, `  是否更新? (y/n/q): `);
      if (update.toLowerCase() === "q") {
        console.log("\n配置已取消。");
        rl.close();
        return;
      }
      if (update.toLowerCase() !== "y") {
        console.log("");
        continue;
      }
    }

    let valid = false;
    while (!valid) {
      const key = await prompt(rl, `  请输入 ${provider.name} API Key${currentHint}: `);

      if (!key && !currentValue) {
        console.log(`  ⚠️  ${provider.name} 是推荐配置的厂商，确定跳过吗?`);
        const skip = await prompt(rl, `  跳过? (y/n): `);
        if (skip.toLowerCase() === "y") {
          break;
        }
        continue;
      }

      if (!key && currentValue) {
        configs[provider.key] = currentValue;
        break;
      }

      if (key.length < 8) {
        console.log("  ❌ API Key 格式不正确，请重新输入。");
        continue;
      }

      configs[provider.key] = key;
      valid = true;
      console.log(`  ✅ ${provider.name} 配置成功\n`);
    }
  }

  // 可选提供商
  printSection("可选模型提供商");
  console.log("以下厂商为可选配置，可根据需求选择:\n");

  for (const provider of providers.filter((p) => !p.required)) {
    const currentValue = configs[provider.key];
    const currentHint = currentValue ? ` [当前: ${maskKey(currentValue)}]` : "";

    console.log(`${provider.name}`);
    console.log(`  ${provider.description}`);

    const key = await prompt(rl, `  请输入 API Key (留空跳过)${currentHint}: `);

    if (key) {
      if (key.length < 8) {
        console.log("  ⚠️  Key 格式似乎不正确，但仍已保存。\n");
      } else {
        console.log(`  ✅ ${provider.name} 配置成功\n`);
      }
      configs[provider.key] = key;
    } else if (currentValue) {
      configs[provider.key] = currentValue;
    }
  }

  // 其他可选配置
  printSection("其他可选配置");

  for (const config of optionalConfigs) {
    const currentValue = configs[config.key];
    const currentHint = currentValue ? ` [当前: ${maskKey(currentValue)}]` : "";

    console.log(`${config.name}`);
    console.log(`  ${config.description}`);

    const key = await prompt(rl, `  请输入 (留空跳过)${currentHint}: `);

    if (key) {
      configs[config.key] = key;
      console.log(`  ✅ ${config.name} 配置成功\n`);
    } else if (currentValue) {
      configs[config.key] = currentValue;
    }
  }

  // 配置总结
  printSection("配置总结");

  const configuredProviders = providers.filter((p) => configs[p.key]);
  const configuredOptional = optionalConfigs.filter((c) => configs[c.key]);

  console.log(`已配置厂商: ${configuredProviders.length}/${providers.length}`);
  for (const provider of configuredProviders) {
    console.log(`  ✅ ${provider.name}: ${maskKey(configs[provider.key])}`);
  }

  if (configuredOptional.length > 0) {
    console.log(`\n其他配置: ${configuredOptional.length}`);
    for (const config of configuredOptional) {
      console.log(`  ✅ ${config.name}: ${maskKey(configs[config.key])}`);
    }
  }

  // 保存确认
  console.log("\n");
  const confirm = await prompt(rl, "确认保存配置到 .env 文件? (y/n): ");

  if (confirm.toLowerCase() !== "y") {
    console.log("\n配置未保存。");
    rl.close();
    return;
  }

  // 生成并保存 .env 文件
  const envContent = generateEnvContent(configs);
  writeFileSync(envPath, envContent, "utf-8");

  console.log("\n✅ 配置已成功保存到 .env 文件!");
  console.log(`📁 文件路径: ${envPath}`);
  console.log("\n🚀 您现在可以运行以下命令启动 OpenClaw:");
  console.log("   bun run openclaw    # 启动主程序");
  console.log("   bun run cli         # 启动 CLI 工具");
  console.log("\n📖 更多信息请查看文档: https://github.com/ListenJ/openclaw-fusion\n");

  rl.close();
}

// 如果直接运行此文件
if (import.meta.main) {
  runSetupWizard(process.argv.slice(2)).catch((err) => {
    console.error("配置向导出错:", err);
    process.exit(1);
  });
}
