/**
 * Hermes Agent 集成模块 v1.0
 * 通过子进程调用 hermes CLI 执行项目管理、深度研究等任务
 * Hermes 支持 MCP，可连接 Axiom 的 MCP Server 共享记忆
 *
 * 所有 API Key 通过环境变量注入，本模块不包含任何密钥
 */
import { spawn } from "bun";
import { statSync } from "fs";
import { logger } from "../utils/logger.js";
import { getGlobalVault } from "../memory/vault-manager.js";
import { internalAgent } from "./internal-agent.js";

export interface HermesTask {
  /** 任务描述 */
  prompt: string;
  /** 工作目录 */
  cwd?: string;
  /** 模型名称 */
  model?: string;
  /** 是否使用 Docker 后端（更安全） */
  docker?: boolean;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 附加环境变量 */
  env?: Record<string, string>;
}

export interface HermesResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  model?: string;
}

/** Hermes 可执行文件路径探测 */
function getHermesCommand(): string[] {
  const candidates = [
    "hermes",
    ".venv/Scripts/hermes",
    ".venv/Scripts/hermes.exe",
    ".venv/bin/hermes",
  ];
  for (const c of candidates) {
    try {
      const stat = statSync(c);
      if (stat.isFile()) return [c];
    } catch {}
  }
  return ["hermes"];
}

/** 检测 Hermes 是否已安装 */
export async function checkHermes(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: [...getHermesCommand(), "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** 获取 Hermes 安装引导信息 */
export function getHermesInstallGuide(): string {
  return `
Hermes Agent 未安装。安装方式（选择一种）：

1. 一键安装（推荐）:
   curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

2. Docker 部署:
   docker run -d --name hermes \
     -e OPENROUTER_API_KEY=\${OPENROUTER_API_KEY} \
     -v ~/.hermes:/root/.hermes \
     nousresearch/hermes-agent

3. pip 安装:
   pip install hermes-agent

安装后运行 hermes doctor 检查配置。
`;
}

/** 检测终端环境是否兼容 Hermes */
function checkHermesTerminal(): { ok: boolean; reason?: string } {
  // Git Bash / MSYS / Cygwin 环境下 prompt_toolkit 会报错
  const term = process.env.TERM || "";
  const msys = process.env.MSYSTEM || "";
  if (term.includes("xterm") && msys) {
    return {
      ok: false,
      reason: "Hermes 在当前终端 (Git Bash / MSYS) 中有兼容性问题。请在 Windows PowerShell 或 cmd.exe 中运行：\n\n  hermes chat -q \"你的问题\"\n\n或配置 Hermes MCP 服务器在后台运行。",
    };
  }
  return { ok: true };
}

/** 运行 Hermes 任务 */
export async function runHermesTask(task: HermesTask): Promise<HermesResult> {
  const available = await checkHermes();
  if (!available) {
    return {
      success: false,
      stdout: "",
      stderr: getHermesInstallGuide(),
      exitCode: 127,
    };
  }

  const termCheck = checkHermesTerminal();
  if (!termCheck.ok) {
    return {
      success: false,
      stdout: "",
      stderr: termCheck.reason || "Terminal not compatible with Hermes",
      exitCode: 126,
    };
  }

  const cwd = task.cwd || process.cwd();
  const timeoutMs = task.timeoutMs || 600_000; // 默认 10 分钟（研究任务可能较长）

  const args = ["chat", "-q", task.prompt, "-Q"];
  if (task.model) {
    args.push("--model", task.model);
  }

  logger.info("[Hermes] Starting task", { cwd, promptPreview: task.prompt.slice(0, 100) });

  const hermesCmd = getHermesCommand()[0];
  const proc = spawn({
    cmd: [hermesCmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY,
      ...task.env,
    },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
    logger.warn("[Hermes] Task timed out", { timeoutMs });
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  const textDecoder = new TextDecoder();

  const reader = proc.stdout.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += textDecoder.decode(value, { stream: true });
    }
  } catch (e: unknown) {
    logger.warn("[Hermes] stdout read error", { error: e instanceof Error ? e.message : String(e) });
  }

  const errReader = proc.stderr.getReader();
  try {
    while (true) {
      const { done, value } = await errReader.read();
      if (done) break;
      stderr += textDecoder.decode(value, { stream: true });
    }
  } catch (e: unknown) {
    logger.warn("[Hermes] stderr read error", { error: e instanceof Error ? e.message : String(e) });
  }

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const success = exitCode === 0;
  logger.info("[Hermes] Task finished", { success, exitCode, stdoutLength: stdout.length });

  return {
    success,
    stdout: stdout.slice(0, 50_000),
    stderr: stderr.slice(0, 10_000),
    exitCode,
  };
}

/** 深度研究（自动读取历史上下文 + 结果沉淀） */
export async function deepResearch(topic: string, cwd?: string): Promise<HermesResult> {
  // 1. 读取历史研究上下文
  const { context } = getResearchContext(topic);
  const fullPrompt = context
    ? `对以下主题进行深度研究，搜索网络资料，整理关键发现、数据来源和结论。\n\n${context}\n\n## 研究主题\n${topic}`
    : `对以下主题进行深度研究，搜索网络资料，整理关键发现、数据来源和结论。\n\n${topic}`;

  const result = await runHermesTask({
    prompt: fullPrompt,
    cwd,
    timeoutMs: 600_000,
  });

  // 2. 成功后沉淀到 Vault（非阻塞）
  if (result.success && result.stdout.length > 500) {
    learnFromResearch(topic, result.stdout, "deep-research")
      .catch(e => logger.warn("Failed to save deep-research result", { topic, error: (e as Error).message }));
  }

  return result;
}

/**
 * 代码审查 - 使用 GLM-5.1 模型
 * 通过 InternalAgent 走 model-router 路由，享受重试/降级/超时/追踪
 * （之前直接调用 SiliconFlow endpoint；现在由路由器按 `code-review` role 分派）
 */
export async function codeReview(
  code: string,
  language: string = "unknown",
  context?: string,
): Promise<{ success: boolean; review: string; model: string }> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      review: "SILICONFLOW_API_KEY 未设置，无法使用 GLM-5.1 进行代码审查。",
      model: "THUDM/GLM-5.1",
    };
  }

  const reviewPrompt = `你是一位资深代码审查专家。请对以下${language}代码进行全面审查：

1. **代码质量**: 可读性、命名规范、代码结构
2. **潜在Bug**: 逻辑错误、边界条件、空指针、类型安全
3. **性能问题**: 时间/空间复杂度、不必要的计算、内存泄漏
4. **安全风险**: SQL注入、XSS、敏感信息泄露
5. **最佳实践**: 设计模式、SOLID原则、DRY原则
6. **改进建议**: 具体的重构方案和优化建议

${context ? `**项目上下文**: ${context}\n\n` : ""}**待审查代码**:
\`\`\`${language}
${code}
\`\`\`

请用中文输出结构化的审查报告，包含严重程度（🔴严重/🟡中等/🟢建议）和具体修改建议。`;

  try {
    // 走 model-router，由其按 role="code-review" 选择模型并接管重试/降级
    const result = await internalAgent.executeWithRole("code-review", [
      { role: "user", content: reviewPrompt },
    ], { maxTokens: 4096, temperature: 0.3 });

    const review = result.content || "未获得审查结果";

    // 审查结果沉淀到 Vault（非阻塞）
    const reviewTopic = context
      ? `代码审查: ${context.slice(0, 50)}`
      : `代码审查 (${language})`;
    learnFromResearch(reviewTopic, review, "code-review")
      .catch(e => logger.warn("Failed to save code-review result", { topic: reviewTopic, error: (e as Error).message }));

    return { success: true, review, model: result.model || "THUDM/GLM-5.1" };
  } catch (e: unknown) {
    return {
      success: false,
      review: `代码审查请求失败: ${e instanceof Error ? e.message : String(e)}`,
      model: "THUDM/GLM-5.1",
    };
  }
}

/** 获取 VaultManager 实例（惰性初始化） */
function getVault() {
  return getGlobalVault();
}

/** 读取历史研究上下文 — 启动前调用 */
export function getResearchContext(topic: string): {
  relatedNotes: Array<{ title: string; path: string; excerpt: string }>;
  context: string;
} {
  try {
    const vault = getVault();
    const results = vault.search(topic, { limit: 5, tags: ["research", "hermes"] });
    const relatedNotes = results.map((r) => ({
      title: r.note.title,
      path: r.note.path,
      excerpt: r.excerpt.slice(0, 200),
    }));

    if (relatedNotes.length === 0) {
      return { relatedNotes: [], context: "" };
    }

    const context = `## 相关历史研究\n\n${relatedNotes
      .map((n, i) => `${i + 1}. **${n.title}**\n   ${n.excerpt}`)
      .join("\n\n")}\n\n请在以上研究基础上继续深入，避免重复已有结论。`;

    return { relatedNotes, context };
  } catch (e: unknown) {
    logger.warn("[Hermes] Failed to get research context", { error: e instanceof Error ? e.message : String(e) });
    return { relatedNotes: [], context: "" };
  }
}

/** 将研究结果沉淀到 Vault — 研究完成后调用 */
export async function learnFromResearch(
  topic: string,
  result: string,
  type: "deep-research" | "code-review" = "deep-research",
): Promise<{ success: boolean; path: string }> {
  try {
    const vault = getVault();
    const timestamp = new Date().toISOString().slice(0, 10);
    const slug = topic
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);

    const notePath = `03-Resources/Hermes/${type}/${timestamp}-${slug}.md`;

    const content = `# ${topic}\n\n## 类型\n${type === "deep-research" ? "深度研究" : "代码审查"}\n\n## 时间\n${timestamp}\n\n## 结果\n\n${result}\n\n---\n\n*由 Hermes Agent 自动生成并沉淀到记忆库*`;

    await vault.writeNote(notePath, content, {
      title: topic,
      tags: ["hermes", type, "research", "auto-generated"],
      type: "research-note",
      source: "hermes-agent",
      paraCategory: "resources",
      gateContext: {
        agentRole: "hermes",
        taskType: "research",
        responseLength: result.length,
        hasCode: result.includes("```"),
        hasCitations: result.includes("http"),
        hasErrors: false,
        userMessageLength: topic.length,
        isFirstTurn: false,
        hasStructuredData: result.includes("## "),
        hasTechnicalTerms: /\b(API|SDK|framework|library|model|dataset)\b/i.test(result),
      },
    });

    logger.info("[Hermes] Research learned to vault", { path: notePath, topic, type });
    return { success: true, path: notePath };
  } catch (e: unknown) {
    logger.warn("[Hermes] Failed to learn from research", { error: e instanceof Error ? e.message : String(e), topic });
    return { success: false, path: "" };
  }
}

/** 生成 MCP 配置以连接 Axiom */
export function generateHermesMcpConfig(): string {
  return `
# 在 ~/.hermes/config.yaml 中添加以下内容，使 Hermes 可以访问 Axiom 的 MCP 工具

mcp_servers:
  axiom:
    command: "bun"
    args: ["run", "src/mcp/server.ts", "--stdio"]
    env:
      DATABASE_PATH: "${process.env.DATABASE_PATH || "./data/agent.db"}"
      OBSIDIAN_VAULT_PATH: "${process.env.OBSIDIAN_VAULT_PATH || "./axiom-memory"}"
`;
}
