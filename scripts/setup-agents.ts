#!/usr/bin/env bun
/**
 * Agent 检测与自动安装引导脚本
 *
 * 功能：
 * 1. 检测系统已安装的外部 Agent/CLI 工具
 * 2. 检测版本信息
 * 3. 为未安装的工具提供安装引导
 * 4. 检测 OpenClaw 项目依赖是否完整
 * 5. 生成环境配置报告
 *
 * 检测的 Agent：
 *   - kimi (Kimi Code CLI)
 *   - claude (Claude Code)
 *   - opencode (OpenCode CLI)
 *   - code (VS Code CLI)
 *   - cursor (Cursor)
 *   - gh (GitHub CLI)
 *   - git
 *   - node / bun
 *
 * 使用：bun run scripts/setup-agents.ts
 */

import { spawn } from "bun";
import { logger } from "../src/utils/logger.js";

interface AgentInfo {
  name: string;
  command: string;
  description: string;
  installUrl?: string;
  installCommand?: string;
  optional: boolean;
  category: "ai-agent" | "ide" | "vcs" | "runtime" | "tool";
}

interface AgentStatus {
  info: AgentInfo;
  installed: boolean;
  version?: string;
  path?: string;
}

// ─── Agent 定义 ───

const AGENTS: AgentInfo[] = [
  {
    name: "kimi",
    command: "kimi",
    description: "Kimi Code CLI - Kimi 智能编程服务",
    installUrl: "https://code.kimi.com",
    installCommand:
      'curl -LsSf https://code.kimi.com/install.sh | bash  # macOS/Linux\nInvoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression  # Windows',
    optional: true,
    category: "ai-agent",
  },
  {
    name: "claude",
    command: "claude",
    description: "Claude Code - Anthropic 的 AI 编程助手",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/install",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    optional: true,
    category: "ai-agent",
  },
  {
    name: "opencode",
    command: "opencode",
    description: "OpenCode CLI - OpenCode AI 编程助手",
    installUrl: "https://opencode.ai",
    installCommand: "npm install -g opencode-ai",
    optional: true,
    category: "ai-agent",
  },
  {
    name: "code",
    command: "code",
    description: "VS Code CLI - Visual Studio Code 命令行工具",
    installUrl: "https://code.visualstudio.com/docs/editor/command-line",
    optional: true,
    category: "ide",
  },
  {
    name: "cursor",
    command: "cursor",
    description: "Cursor - AI-first 代码编辑器",
    installUrl: "https://cursor.com",
    optional: true,
    category: "ide",
  },
  {
    name: "gh",
    command: "gh",
    description: "GitHub CLI - GitHub 命令行工具",
    installUrl: "https://cli.github.com",
    installCommand:
      'brew install gh  # macOS\nwinget install --id GitHub.cli  # Windows\nsudo apt install gh  # Ubuntu/Debian',
    optional: true,
    category: "vcs",
  },
  {
    name: "git",
    command: "git",
    description: "Git - 分布式版本控制系统",
    installUrl: "https://git-scm.com/downloads",
    optional: false,
    category: "vcs",
  },
  {
    name: "bun",
    command: "bun",
    description: "Bun - JavaScript 运行时与包管理器",
    installUrl: "https://bun.sh",
    installCommand: "curl -fsSL https://bun.sh/install | bash",
    optional: false,
    category: "runtime",
  },
  {
    name: "node",
    command: "node",
    description: "Node.js - JavaScript 运行时",
    installUrl: "https://nodejs.org",
    optional: false,
    category: "runtime",
  },
  {
    name: "tesseract",
    command: "tesseract",
    description: "Tesseract OCR - 开源 OCR 引擎",
    installUrl: "https://github.com/tesseract-ocr/tesseract",
    optional: true,
    category: "tool",
  },
];

// ─── 检测函数 ───

async function detectAgent(agent: AgentInfo): Promise<AgentStatus> {
  const status: AgentStatus = {
    info: agent,
    installed: false,
  };

  try {
    // 尝试获取版本
    const versionArgs = ["--version"];
    if (agent.name === "git") versionArgs[0] = "--version";

    const proc = spawn({
      cmd: [agent.command, ...versionArgs],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      status.installed = true;
      status.version = (stdout || stderr).trim().split("\n")[0];

      // 尝试获取路径
      try {
        const whichProc = spawn({
          cmd: process.platform === "win32" ? ["where", agent.command] : ["which", agent.command],
          stdout: "pipe",
          stderr: "pipe",
        });
        const pathOutput = await new Response(whichProc.stdout).text();
        if (pathOutput) {
          status.path = pathOutput.trim().split("\n")[0];
        }
      } catch {
        // 忽略路径检测错误
      }
    }
  } catch {
    // 命令不存在
  }

  return status;
}

async function detectBunVersion(): Promise<string | undefined> {
  try {
    const proc = spawn({
      cmd: ["bun", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return output.trim();
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function checkProjectDeps(): Promise<{
  installed: boolean;
  missing: string[];
}> {
  const result = { installed: false, missing: [] as string[] };

  try {
    // 检查 node_modules 是否存在
    const nodeModulesExists = await Bun.file("node_modules/.package-lock.json").exists();
    if (!nodeModulesExists) {
      result.missing.push("node_modules (未安装依赖)");
    }

    // 检查关键依赖
    const criticalDeps = ["drizzle-orm", "zod", "yaml", "blessed"];
    for (const dep of criticalDeps) {
      try {
        await import(dep);
      } catch {
        result.missing.push(dep);
      }
    }

    result.installed = result.missing.length === 0;
  } catch {
    // ignore
  }

  return result;
}

// ─── 输出格式化 ───

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🤖 OpenClaw Agent 检测与配置向导                   ║
║                                                              ║
║  本脚本检测系统上已安装的 AI Agent 和开发工具，              ║
║  并提供缺失工具的安装引导。                                  ║
╚══════════════════════════════════════════════════════════════╝
`);
}

function printCategoryHeader(category: string): void {
  const icons: Record<string, string> = {
    "ai-agent": "🧠",
    ide: "💻",
    vcs: "📦",
    runtime: "⚡",
    tool: "🔧",
  };
  const names: Record<string, string> = {
    "ai-agent": "AI Agent",
    ide: "IDE 编辑器",
    vcs: "版本控制",
    runtime: "运行时",
    tool: "工具",
  };
  console.log(`\n${icons[category] || "📋"} ${names[category] || category}`);
  console.log("─".repeat(60));
}

function printAgentStatus(status: AgentStatus): void {
  const icon = status.installed ? "✅" : status.info.optional ? "⚪" : "❌";
  const name = status.info.name.padEnd(12);
  const desc = status.info.description;

  if (status.installed) {
    console.log(`${icon} ${name} ${desc}`);
    if (status.version) {
      console.log(`   版本: ${status.version}`);
    }
    if (status.path) {
      console.log(`   路径: ${status.path}`);
    }
  } else {
    console.log(`${icon} ${name} ${desc}`);
    if (!status.info.optional) {
      console.log(`   ⚠️  必需组件，缺少将影响功能`);
    }
  }
}

function printInstallGuide(status: AgentStatus): void {
  const agent = status.info;
  console.log(`\n📥 安装 ${agent.name}`);
  console.log(`   说明: ${agent.description}`);

  if (agent.installCommand) {
    console.log(`   命令:`);
    agent.installCommand.split("\n").forEach((line) => {
      console.log(`     ${line}`);
    });
  }

  if (agent.installUrl) {
    console.log(`   文档: ${agent.installUrl}`);
  }
}

// ─── 交互式引导 ───

async function askYesNo(question: string, defaultValue = true): Promise<boolean> {
  process.stdout.write(`${question} ${defaultValue ? "[Y/n]" : "[y/N]"} `);
  return new Promise((resolve) => {
    const reader = Bun.stdin.stream().getReader();
    let result = "";
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) {
          resolve(defaultValue);
          return;
        }
        const text = new TextDecoder().decode(value);
        for (const char of text) {
          if (char === "\n" || char === "\r") {
            reader.releaseLock();
            resolve(result.trim().toLowerCase().startsWith("y") || (result.trim() === "" && defaultValue));
            return;
          }
          result += char;
        }
        read();
      });
    }
    read();
  });
}

// ─── 主流程 ───

async function main(): Promise<void> {
  printBanner();

  // 检测系统平台
  const platform = process.platform;
  console.log(`📋 系统平台: ${platform} (${process.arch})`);

  // 检测 Bun 版本
  const bunVersion = await detectBunVersion();
  if (bunVersion) {
    console.log(`📦 Bun 版本: ${bunVersion}`);
  }

  console.log("\n🔍 正在检测已安装的 Agent 和工具...\n");

  // 并行检测所有 Agent
  const statuses = await Promise.all(AGENTS.map((agent) => detectAgent(agent)));

  // 按类别分组显示
  const categories = ["ai-agent", "ide", "vcs", "runtime", "tool"] as const;
  const installed: AgentStatus[] = [];
  const missing: AgentStatus[] = [];

  for (const category of categories) {
    const categoryStatuses = statuses.filter((s) => s.info.category === category);
    if (categoryStatuses.length === 0) continue;

    printCategoryHeader(category);
    for (const status of categoryStatuses) {
      printAgentStatus(status);
      if (status.installed) {
        installed.push(status);
      } else {
        missing.push(status);
      }
    }
  }

  // 统计
  console.log(`\n${"═".repeat(60)}`);
  console.log(`📊 检测结果: ${installed.length}/${statuses.length} 已安装`);

  // 检查项目依赖
  console.log("\n🔍 检查项目依赖...");
  const deps = await checkProjectDeps();
  if (deps.installed) {
    console.log("✅ 项目依赖完整");
  } else {
    console.log("⚠️ 项目依赖不完整:");
    deps.missing.forEach((m) => console.log(`   - ${m}`));
    console.log("\n💡 请运行: bun install");
  }

  // 未安装 Agent 的安装引导
  const optionalMissing = missing.filter((m) => m.info.optional);
  if (optionalMissing.length > 0) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`📥 可选 Agent 安装引导 (${optionalMissing.length} 个未安装)`);

    for (const status of optionalMissing) {
      printInstallGuide(status);
      const installNow = await askYesNo(`是否现在安装 ${status.info.name}?`, false);
      if (installNow && status.info.installCommand) {
        console.log(`\n🚀 正在安装 ${status.info.name}...`);
        try {
          const lines = status.info.installCommand.split("\n");
          const firstCommand = lines[0].trim();
          const parts = firstCommand.split(" ");
          const proc = spawn({
            cmd: parts,
            stdout: "inherit",
            stderr: "inherit",
          });
          const exitCode = await proc.exited;
          if (exitCode === 0) {
            console.log(`✅ ${status.info.name} 安装成功`);
          } else {
            console.log(`⚠️ ${status.info.name} 安装退出码: ${exitCode}`);
          }
  } catch (e: unknown) {
        logger.error(
          `安装 ${status.info.name} 失败`,
          e instanceof Error ? e : new Error(String(e))
        );
        }
      }
    }
  }

  // 必需组件检查
  const requiredMissing = missing.filter((m) => !m.info.optional);
  if (requiredMissing.length > 0) {
    console.log(`\n${"═".repeat(60)}`);
    console.log("❌ 必需组件缺失:");
    requiredMissing.forEach((s) => {
      console.log(`   - ${s.info.name}: ${s.info.description}`);
      if (s.info.installUrl) {
        console.log(`     安装指南: ${s.info.installUrl}`);
      }
    });
    console.log("\n⚠️  请安装以上必需组件后重新运行本脚本。");
  }

  // 总结
  console.log(`\n${"═".repeat(60)}`);
  console.log("✨ 检测完成！");
  console.log(`\n已安装的 AI Agent: ${installed.filter((s) => s.info.category === "ai-agent").length}/${AGENTS.filter((a) => a.category === "ai-agent").length}`);

  if (installed.some((s) => s.info.name === "kimi")) {
    console.log("\n🌙 Kimi Code 已就绪，运行以下命令开始使用:");
    console.log("   bun run src/cli.ts kimi:chat \"你好\"");
    console.log("   bun run src/cli.ts kimi:open");
  } else {
    console.log("\n💡 建议安装 Kimi Code 以获得最佳编程体验:");
    console.log("   curl -LsSf https://code.kimi.com/install.sh | bash");
  }

  // 推荐配置 Kimi Code
  if (!installed.some((s) => s.info.name === "kimi")) {
    const setupKimi = await askYesNo("是否运行 Kimi Code 配置向导?");
    if (setupKimi) {
      console.log("\n🚀 启动 Kimi Code 配置向导...\n");
      try {
        const proc = spawn({
          cmd: ["bun", "run", "scripts/setup-kimi-code.ts"],
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
        });
        await proc.exited;
      } catch (e: unknown) {
        logger.error(
          "启动 Kimi Code 配置向导失败",
          e instanceof Error ? e : new Error(String(e))
        );
      }
    }
  }
}

main().catch((e: unknown) => {
  logger.error("Agent setup failed", e instanceof Error ? e : new Error(String(e)));
  process.exit(1);
});
