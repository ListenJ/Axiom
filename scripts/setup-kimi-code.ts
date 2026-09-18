#!/usr/bin/env bun
/**
 * Kimi Code CLI 交互式配置引导脚本
 *
 * 功能：
 * 1. 检测 kimi CLI 是否已安装
 * 2. 如未安装，引导用户完成安装
 * 3. 提供 OAuth 登录或 API Key 配置选项
 * 4. 验证配置有效性
 * 5. 写入 .env 文件
 *
 * 使用：bun run scripts/setup-kimi-code.ts
 */

import { spawn } from "bun";
import { logger } from "../src/utils/logger.js";

const ENV_FILE = ".env";

interface SetupState {
  cliInstalled: boolean;
  cliVersion?: string;
  authMethod: "oauth" | "apikey" | null;
  apiKey?: string;
  baseURL?: string;
}

const state: SetupState = {
  cliInstalled: false,
  authMethod: null,
};

// ─── 工具函数 ───

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🌙 Kimi Code CLI 交互式配置向导                    ║
║                                                              ║
║  Kimi Code 是 Kimi 会员权益中专为开发者提供的智能编程服务。  ║
║  支持 API 直连 和 CLI 交互式调用两种方式。                   ║
╚══════════════════════════════════════════════════════════════╝
`);
}

function printStep(step: number, total: number, title: string): void {
  console.log(`\n[${step}/${total}] ${title}`);
  console.log("─".repeat(60));
}

function ask(question: string): Promise<string> {
  process.stdout.write(`${question} `);
  return new Promise((resolve) => {
    const reader = Bun.stdin.stream().getReader();
    let result = "";
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) {
          resolve(result.trim());
          return;
        }
        const text = new TextDecoder().decode(value);
        for (const char of text) {
          if (char === "\n" || char === "\r") {
            reader.releaseLock();
            resolve(result.trim());
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

async function askYesNo(question: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${hint}`);
  if (!answer) return defaultValue;
  return answer.toLowerCase().startsWith("y");
}

async function askChoice<T extends string>(
  question: string,
  choices: { value: T; label: string }[]
): Promise<T> {
  console.log(`\n${question}`);
  choices.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.label}`);
  });
  const answer = await ask("请选择 (输入序号):");
  const index = parseInt(answer, 10) - 1;
  if (index >= 0 && index < choices.length) {
    return choices[index].value;
  }
  console.log("无效选择，默认选择第一项。");
  return choices[0].value;
}

// ─── 检测函数 ───

async function detectKimiCli(): Promise<{ installed: boolean; version?: string }> {
  try {
    const proc = spawn({
      cmd: ["kimi", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const version = output.trim();
      return { installed: true, version };
    }
  } catch {
    // CLI 未安装
  }
  return { installed: false };
}

async function detectKimiCodeApiKey(): Promise<boolean> {
  return !!process.env.KIMI_CODE_API_KEY;
}

// ─── 安装引导 ───

async function guideInstallCli(): Promise<void> {
  console.log(`
💡 Kimi Code CLI 未检测到。

Kimi Code CLI 提供原生交互式编码体验，支持：
  • 自然语言代码生成与编辑
  • 代码审查与重构建议
  • 项目级智能问答

安装方式：

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
macOS / Linux:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  curl -LsSf https://code.kimi.com/install.sh | bash

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Windows (PowerShell):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
安装完成后，请重新运行本脚本。
`);

  const openBrowser = await askYesNo("是否在浏览器中打开安装指南?");
  if (openBrowser) {
    try {
      spawn({
        cmd: ["open", "https://code.kimi.com"],
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      console.log("请手动访问: https://code.kimi.com");
    }
  }
}

// ─── 认证配置 ───

async function configureOAuth(): Promise<void> {
  console.log(`
🔐 OAuth 自动登录 (推荐)

使用官方 kimi CLI 的登录功能，自动获取访问令牌。
`);

  const ready = await askYesNo("是否现在执行 kimi /login ?");
  if (!ready) {
    console.log("您可以稍后手动运行: kimi /login");
    return;
  }

  console.log("正在启动 kimi 登录流程...\n");
  try {
    const proc = spawn({
      cmd: ["kimi", "/login"],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log("\n✅ OAuth 登录成功！");
      state.authMethod = "oauth";
    } else {
      console.log("\n⚠️ 登录流程异常退出，请检查网络或稍后重试。");
    }
  } catch (e: unknown) {
    logger.error("OAuth 登录失败", e instanceof Error ? e : new Error(String(e)));
  }
}

async function configureApiKey(): Promise<void> {
  console.log(`
🔑 API Key 配置

适用于第三方工具集成或自建应用场景。

获取步骤：
  1. 访问 https://platform.kimi.com/coding
  2. 登录 Kimi 账号
  3. 进入「开发者设置」→「API Keys」
  4. 创建新 Key 并复制
`);

  const apiKey = await ask("请输入 Kimi Code API Key (sk-...):");
  if (!apiKey || !apiKey.startsWith("sk-")) {
    console.log("⚠️ API Key 格式不正确，应以 sk- 开头。");
    const retry = await askYesNo("是否重新输入?");
    if (retry) return configureApiKey();
    return;
  }

  state.apiKey = apiKey;
  state.authMethod = "apikey";

  // 可选：自定义 baseURL
  const customURL = await askYesNo("是否需要自定义 API 端点? (通常不需要)");
  if (customURL) {
    const url = await ask("请输入自定义端点 URL:");
    if (url) state.baseURL = url;
  }

  // 验证 API Key
  console.log("\n🔍 正在验证 API Key...");
  const valid = await validateApiKey(apiKey, state.baseURL);
  if (valid) {
    console.log("✅ API Key 验证通过！");
  } else {
    console.log("⚠️ API Key 验证失败，请检查 Key 是否有效。");
    const retry = await askYesNo("是否重新输入?");
    if (retry) return configureApiKey();
  }
}

async function validateApiKey(apiKey: string, baseURL?: string): Promise<boolean> {
  try {
    const url = baseURL || "https://api.kimi.com/coding/v1";
    const res = await fetch(`${url}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── 环境变量写入 ───

async function writeEnvConfig(): Promise<void> {
  const lines: string[] = [];

  if (state.authMethod === "apikey" && state.apiKey) {
    lines.push(`# Kimi Code API Configuration`);
    lines.push(`KIMI_CODE_API_KEY=${state.apiKey}`);
    if (state.baseURL) {
      lines.push(`KIMI_CODE_BASE_URL=${state.baseURL}`);
    }
  }

  if (lines.length === 0) {
    console.log("\n⚠️ 没有可写入的配置项。");
    return;
  }

  try {
    const envPath = `${process.cwd()}/${ENV_FILE}`;
    let existing = "";
    try {
      existing = await Bun.file(envPath).text();
    } catch {
      // 文件不存在，创建新文件
    }

    // 移除旧的 Kimi Code 配置
    const cleaned = existing
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("KIMI_CODE_API_KEY=") &&
          !line.startsWith("KIMI_CODE_BASE_URL=") &&
          !line.startsWith("# Kimi Code")
      )
      .join("\n");

    const newContent = cleaned.trimEnd() + "\n\n" + lines.join("\n") + "\n";
    await Bun.write(envPath, newContent);

    console.log(`\n✅ 配置已写入 ${ENV_FILE}`);
    console.log("   请确保 .env 文件已添加到 .gitignore");
  } catch (e: unknown) {
    logger.error("写入 .env 失败", e instanceof Error ? e : new Error(String(e)));
    console.log("\n❌ 写入配置失败，请手动添加以下环境变量：");
    lines.forEach((l) => console.log(`   ${l}`));
  }
}

// ─── 主流程 ───

async function main(): Promise<void> {
  printBanner();

  // Step 1: 检测 CLI
  printStep(1, 4, "检测 Kimi Code CLI");
  const cliInfo = await detectKimiCli();
  state.cliInstalled = cliInfo.installed;

  if (cliInfo.installed) {
    console.log(`✅ 检测到 kimi CLI (版本: ${cliInfo.version || "unknown"})`);
  } else {
    console.log("⚠️ 未检测到 kimi CLI");
    const installNow = await askYesNo("是否查看安装指南?");
    if (installNow) {
      await guideInstallCli();
      // 重新检测
      const retry = await detectKimiCli();
      state.cliInstalled = retry.installed;
    }
  }

  // Step 2: 检测现有配置
  printStep(2, 4, "检测现有配置");
  const hasApiKey = await detectKimiCodeApiKey();
  if (hasApiKey) {
    console.log("✅ 已检测到 KIMI_CODE_API_KEY");
    const reconfigure = await askYesNo("是否重新配置?");
    if (!reconfigure) {
      console.log("\n✨ 配置完成，跳过后续步骤。");
      return;
    }
  } else {
    console.log("⚠️ 未检测到 KIMI_CODE_API_KEY");
  }

  // Step 3: 选择认证方式
  printStep(3, 4, "选择认证方式");
  if (state.cliInstalled) {
    const method = await askChoice<"oauth" | "apikey">("请选择认证方式:", [
      { value: "oauth", label: "OAuth 自动登录 (推荐，使用 kimi CLI)" },
      { value: "apikey", label: "API Key (适用于第三方工具/自建应用)" },
    ]);

    if (method === "oauth") {
      await configureOAuth();
    } else {
      await configureApiKey();
    }
  } else {
    console.log("由于未安装 kimi CLI，仅支持 API Key 方式。");
    await configureApiKey();
  }

  // Step 4: 写入配置
  printStep(4, 4, "保存配置");
  await writeEnvConfig();

  // 完成
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                     🎉 配置完成！                            ║
╚══════════════════════════════════════════════════════════════╝

使用方式：
  API 直连 (无需 CLI):
    bun run src/cli.ts kimi:chat "写一个 TypeScript HTTP 服务器"

  交互式 CLI (需安装 kimi CLI):
    bun run src/cli.ts kimi:open

  查看状态:
    bun run src/cli.ts kimi:status

文档: https://platform.kimi.com/coding/docs
`);
}

main().catch((e: unknown) => {
  logger.error("Setup failed", e instanceof Error ? e : new Error(String(e)));
  process.exit(1);
});
