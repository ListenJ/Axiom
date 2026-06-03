/**
 * OpenCode Agent 集成模块 v1.1
 * OpenCode 是交互式 TUI 编码 Agent，本模块提供快捷启动和状态查询
 * 支持免费模型: opencode/deepseek-v4-flash-free, opencode/big-pickle, opencode/nemotron-3-super-free
 *
 * 所有 API Key 通过环境变量注入，本模块不包含任何密钥
 */
import { spawn } from "bun";
import { logger } from "../utils/logger.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";
import { router, type ChatMessage } from "../router/model-router.js";
import { getGlobalVault } from "../memory/vault-manager.js";
import { getMemoryGate, type SignificanceContext } from "../memory/memory-gate.js";

/** 检测任务是否涉及代码 */
function isCodeTask(prompt: string): boolean {
  const codeKeywords = /\b(function|class|const|let|var|import|export|async|await|=>|\.ts|\.js|\.tsx|\.jsx|\.py|\.go|\.rs|bug|fix|refactor|implement|code|编码|函数|类|修复|重构|实现)\b/i;
  return codeKeywords.test(prompt);
}

/** 免费模型列表（按推荐度排序） */
export const OPENCODE_FREE_MODELS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/big-pickle",
  "opencode/nemotron-3-super-free",
];

/** 默认编码模型（免费） */
export const DEFAULT_CODE_MODEL = process.env.OPENCODE_DEFAULT_MODEL || OPENCODE_FREE_MODELS[0];

/** 检测 opencode 是否可用 */
export async function checkOpenCode(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["opencode", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** 启动 OpenCode 交互式编码会话（直接连接用户终端） */
export function openCodeSession(options?: {
  cwd?: string;
  model?: string;
  prompt?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const model = options?.model || DEFAULT_CODE_MODEL;
    const cwd = options?.cwd || process.cwd();

    const args = ["run", "--model", model];
    if (options?.prompt) {
      args.push(options.prompt);
    }

    logger.info("[OpenCode] Starting interactive session", { model, cwd });

    const proc = spawn({
      cmd: ["opencode", ...args],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      cwd,
      env: { ...process.env },
    });

    proc.exited.then(resolve).catch(reject);
  });
}

/** 启动 OpenCode 后台服务 */
export function startOpenCodeServer(options?: {
  cwd?: string;
  port?: number;
}): { stop: () => void; port: number } {
  const cwd = options?.cwd || process.cwd();
  const port = options?.port || 0; // 0 = random port

  logger.info("[OpenCode] Starting headless server", { cwd, port });

  const proc = spawn({
    cmd: ["opencode", "serve", "--port", String(port)],
    stdout: "inherit",
    stderr: "inherit",
    cwd,
    env: { ...process.env },
  });

  return {
    stop: () => {
      try { proc.kill(); } catch {}
    },
    port,
  };
}

/** 列出 OpenCode 可用模型 */
export async function listOpenCodeModels(): Promise<string[]> {
  try {
    const proc = spawn({
      cmd: ["opencode", "models"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const textDecoder = new TextDecoder();
    let output = "";
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += textDecoder.decode(value, { stream: true });
    }
    await proc.exited;
    return output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("["));
  } catch {
    return OPENCODE_FREE_MODELS;
  }
}

/**
 * 运行 OpenCode 编码任务，自动注入 CodeGraph 代码上下文
 * 当任务涉及代码时，先检索 CodeGraph 符号和调用关系，
 * 将相关代码片段注入 prompt，减少模型幻觉和不必要的文件读取
 */
export async function runWithCodeContext(options: {
  prompt: string;
  cwd?: string;
  model?: string;
  codeContext?: boolean; // 默认 true，设为 false 禁用
}): Promise<{ command: string[]; enhancedPrompt: string; injectedContext: string }> {
  const prompt = options.prompt;
  let enhancedPrompt = prompt;
  let injectedContext = "";

  // 自动检测是否需要代码上下文
  const needsCode = options.codeContext !== false && isCodeTask(prompt);

  if (needsCode) {
    logger.info("[OpenCode] CodeGraph context injection triggered", { prompt: prompt.slice(0, 80) });
    const memory = await retrieveCodeMemory(prompt, { limit: 8, includeContext: true });
    if (memory && memory.results) {
      injectedContext = memory.results;
      enhancedPrompt = `## 项目代码上下文 (来自 CodeGraph 索引)\n\n${injectedContext}\n\n---\n\n## 任务\n\n${prompt}`;
      logger.info("[OpenCode] CodeGraph context injected", {
        symbols: memory.symbols.length,
        contextLength: injectedContext.length,
      });
    } else {
      logger.warn("[OpenCode] CodeGraph not available, running without context");
    }
  }

  const model = options.model || DEFAULT_CODE_MODEL;
  const cwd = options.cwd || process.cwd();

  return {
    command: ["opencode", "run", "--model", model, enhancedPrompt],
    enhancedPrompt,
    injectedContext,
  };
}

/** 获取 OpenCode 安装引导 */
export function getOpenCodeInstallGuide(): string {
  return `
OpenCode CLI 未安装。安装方式（选择一种）：

1. 官方脚本（推荐）:
   curl -fsSL https://opencode.ai/install.sh | bash

2. npm 安装:
   npm install -g opencode

3. 直接下载:
   https://github.com/opencode-ai/opencode/releases

安装后运行 opencode --version 验证。
`;
}

// ========== 编码任务执行引擎 ==========

/** 代码生成结果 */
export interface CodeGenerateResult {
  code: string;
  language: string;
  explanation: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latency_ms: number;
}

/** 代码重构结果 */
export interface CodeRefactorResult {
  code: string;
  changes: string[];
  explanation: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latency_ms: number;
}

/** 代码审查结果 */
export interface CodeReviewResult {
  review: string;
  issues: Array<{ severity: "high" | "medium" | "low"; line?: number; message: string }>;
  suggestions: string[];
  model: string;
  provider: string;
  latency_ms: number;
}

/** 代码测试结果 */
export interface CodeTestResult {
  tests: string;
  language: string;
  coverage: string;
  explanation: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latency_ms: number;
}

function getVault() {
  return getGlobalVault();
}

/** 保存编码结果到 Vault */
async function saveCodeResult(
  type: "generate" | "refactor" | "review" | "test",
  title: string,
  content: string,
  metadata: { model: string; provider: string; language?: string; latency_ms: number },
  gateCtx?: Partial<SignificanceContext>
): Promise<string> {
  const vault = getVault();
  const date = new Date().toISOString().split("T")[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").slice(0, 40);
  const notePath = `03-Resources/CodeAgent/${type}/${date}-${slug}.md`;

  const body = `## ${type === "generate" ? "代码生成" : type === "refactor" ? "代码重构" : type === "review" ? "代码审查" : "测试生成"}结果

**模型**: ${metadata.model}  
**提供商**: ${metadata.provider}  
**延迟**: ${metadata.latency_ms}ms  
${metadata.language ? `**语言**: ${metadata.language}  ` : ""}

---

${content}
`;

  const gateContext: SignificanceContext = {
    agentRole: "code-agent",
    taskType: "coding",
    responseLength: content.length,
    hasCode: true,
    hasCitations: false,
    hasErrors: false,
    responseTimeMs: metadata.latency_ms,
    userMessageLength: title.length,
    isFirstTurn: true,
    hasStructuredData: true,
    hasTechnicalTerms: true,
    ...gateCtx,
  };

  try {
    const path = await vault.writeNote(notePath, body, {
      title,
      tags: ["code-agent", type, metadata.model, metadata.provider, metadata.language || "code"],
      type: "code-result",
      source: "opencode-agent",
      confidence: 0.85,
      paraCategory: "resources",
      gateContext,
    });
    logger.info("[CodeAgent] Result saved to Vault", { path, type, model: metadata.model });
    return path;
  } catch (e: unknown) {
    logger.warn("[CodeAgent] Failed to save to Vault", { error: e instanceof Error ? e.message : String(e) });
    return notePath;
  }
}

/** 构建带 CodeGraph 上下文的 messages */
async function buildCodeMessages(
  systemPrompt: string,
  userPrompt: string,
  injectContext = true
): Promise<ChatMessage[]> {
  let enhancedPrompt = userPrompt;

  if (injectContext && isCodeTask(userPrompt)) {
    try {
      const memory = await retrieveCodeMemory(userPrompt, { limit: 6, includeContext: true });
      if (memory?.results) {
        enhancedPrompt = `## 项目代码上下文 (CodeGraph)\n\n${memory.results}\n\n---\n\n## 任务\n\n${userPrompt}`;
      }
    } catch (e) {
      logger.warn("[CodeAgent] CodeGraph context injection failed", { error: (e as Error).message });
    }
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: enhancedPrompt },
  ];
}

/** 执行代码生成 */
export async function executeCodeGenerate(options: {
  prompt: string;
  language?: string;
  context?: string; // 额外上下文（如已有代码）
  model?: string; // 可指定特定模型
}): Promise<CodeGenerateResult> {
  const startTime = Date.now();
  const language = options.language || "typescript";

  const systemPrompt = `You are an expert software engineer. Generate clean, well-documented, production-ready ${language} code based on the user's request.

Rules:
1. Output ONLY the code inside a \`\`\`${language} code block
2. After the code block, provide a brief explanation of the implementation
3. Follow best practices: error handling, type safety, comments
4. If the task is unclear, ask clarifying questions instead of guessing`;

  const userPrompt = options.context
    ? `## Existing Code Context\n\n\`\`\`${language}\n${options.context}\n\`\`\`\n\n## Request\n\n${options.prompt}`
    : options.prompt;

  const messages = await buildCodeMessages(systemPrompt, userPrompt);

  // 优先使用 code-generation 路由（免费模型池）
  const response = options.model
    ? await router.chat("code-generation", messages)
    : await router.tool("coding", messages);

  const latency = Date.now() - startTime;
  const content = response.content || "";

  // 提取代码块
  const codeMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  const code = codeMatch ? codeMatch[1].trim() : content;

  // 提取解释（代码块之后的文本）
  const explanation = content.replace(/```[\s\S]*?```/, "").trim() || "No explanation provided.";

  const result: CodeGenerateResult = {
    code,
    language,
    explanation,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    latency_ms: latency,
  };

  // 异步保存到 Vault（不阻塞响应）
  const title = `代码生成: ${options.prompt.slice(0, 40)}`;
  saveCodeResult("generate", title, content, { model: response.model, provider: response.provider, language, latency_ms: latency })
    .catch(e => logger.warn("Failed to save code generation result", { title, error: (e as Error).message }));

  return result;
}

/** 执行代码重构 */
export async function executeCodeRefactor(options: {
  code: string;
  description: string;
  language?: string;
}): Promise<CodeRefactorResult> {
  const startTime = Date.now();
  const language = options.language || "typescript";

  const systemPrompt = `You are a senior code reviewer and refactoring expert. Refactor the provided code according to the user's description.

Rules:
1. Output ONLY the refactored code inside a \`\`\`${language} code block
2. After the code block, list the specific changes made (bullet points)
3. Preserve all existing functionality unless explicitly asked to change behavior
4. Improve: readability, performance, type safety, error handling`;

  const userPrompt = `## Code to Refactor\n\n\`\`\`${language}\n${options.code}\n\`\`\`\n\n## Refactoring Request\n\n${options.description}`;

  const messages = await buildCodeMessages(systemPrompt, userPrompt);
  const response = await router.tool("coding", messages);

  const latency = Date.now() - startTime;
  const content = response.content || "";

  const codeMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  const refactoredCode = codeMatch ? codeMatch[1].trim() : content;

  // 提取变更列表
  const changesMatch = content.match(/##?\s*Changes?[\s\S]*?(?:\n\n|$)/i);
  const changes = changesMatch
    ? changesMatch[0].split("\n").filter((l) => l.trim().startsWith("-") || l.trim().startsWith("*")).map((l) => l.trim().replace(/^[-*]\s*/, ""))
    : [];

  const explanation = content.replace(/```[\s\S]*?```/, "").trim();

  const result: CodeRefactorResult = {
    code: refactoredCode,
    changes,
    explanation,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    latency_ms: latency,
  };

  const title = `代码重构: ${options.description.slice(0, 40)}`;
  saveCodeResult("refactor", title, content, { model: response.model, provider: response.provider, language, latency_ms: latency })
    .catch(e => logger.warn("Failed to save code refactor result", { title, error: (e as Error).message }));

  return result;
}

/** 执行代码审查 */
export async function executeCodeReview(options: {
  code: string;
  language?: string;
  context?: string;
}): Promise<CodeReviewResult> {
  const startTime = Date.now();
  const language = options.language || "typescript";

  const systemPrompt = `You are a strict code reviewer with expertise in ${language}. Review the provided code thoroughly.

Output format (strict):
1. Overall assessment (1-2 sentences)
2. Issues list - each issue must specify severity (HIGH/MEDIUM/LOW) and line number if applicable
3. Suggestions for improvement (numbered list)

Be specific, cite line numbers, and prioritize security and correctness.`;

  const userPrompt = options.context
    ? `## Code Context\n\n${options.context}\n\n## Code to Review\n\n\`\`\`${language}\n${options.code}\n\`\`\``
    : `\`\`\`${language}\n${options.code}\n\`\`\``;

  const messages = await buildCodeMessages(systemPrompt, userPrompt, false);

  // 代码审查使用 code-review 路由（GLM-5.1 优先）
  const response = await router.chat("code-review", messages);

  const latency = Date.now() - startTime;
  const review = response.content || "";

  // 解析 issues
  const issues: Array<{ severity: "high" | "medium" | "low"; line?: number; message: string }> = [];
  const issuePattern = /(?:HIGH|MEDIUM|LOW)\s*[:：-]?\s*(?:Line\s*(\d+)[:：-]?\s*)?([\s\S]*?)(?=(?:HIGH|MEDIUM|LOW)\s*[:：]|$)/gi;
  let m;
  while ((m = issuePattern.exec(review)) !== null) {
    const severityMatch = m[0].match(/^(HIGH|MEDIUM|LOW)/i);
    if (severityMatch) {
      issues.push({
        severity: severityMatch[1].toLowerCase() as "high" | "medium" | "low",
        line: m[1] ? parseInt(m[1], 10) : undefined,
        message: m[2]?.trim() || "",
      });
    }
  }

  // 解析 suggestions
  const suggestions = review
    .split("\n")
    .filter((l) => /^\d+\.\s+/.test(l.trim()))
    .map((l) => l.trim().replace(/^\d+\.\s*/, ""));

  const result: CodeReviewResult = {
    review,
    issues,
    suggestions,
    model: response.model,
    provider: response.provider,
    latency_ms: latency,
  };

  const title = `代码审查: ${language}`;
  saveCodeResult("review", title, review, { model: response.model, provider: response.provider, language, latency_ms: latency }, { hasCode: true, hasStructuredData: true })
    .catch(e => logger.warn("Failed to save code review result", { title, error: (e as Error).message }));

  return result;
}

/** 执行测试生成 */
export async function executeCodeTest(options: {
  code: string;
  language?: string;
  framework?: string;
}): Promise<CodeTestResult> {
  const startTime = Date.now();
  const language = options.language || "typescript";
  const framework = options.framework || (language === "typescript" || language === "javascript" ? "vitest" : "pytest");

  const systemPrompt = `You are a test engineering expert. Generate comprehensive unit tests for the provided code.

Requirements:
1. Output ONLY the test code inside a \`\`\`${language} code block
2. Cover: happy path, edge cases, error cases
3. Use ${framework} framework
4. Include mock/stub setup if needed
5. After the code block, briefly describe test coverage`;

  const userPrompt = `## Code to Test\n\n\`\`\`${language}\n${options.code}\n\`\`\`\n\n## Framework\n\n${framework}`;

  const messages = await buildCodeMessages(systemPrompt, userPrompt);
  const response = await router.tool("coding", messages);

  const latency = Date.now() - startTime;
  const content = response.content || "";

  const codeMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  const tests = codeMatch ? codeMatch[1].trim() : content;

  const explanation = content.replace(/```[\s\S]*?```/, "").trim() || `Tests generated using ${framework}.`;

  const result: CodeTestResult = {
    tests,
    language,
    coverage: "Generated based on code analysis",
    explanation,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    latency_ms: latency,
  };

  const title = `测试生成: ${framework}`;
  saveCodeResult("test", title, content, { model: response.model, provider: response.provider, language, latency_ms: latency })
    .catch(e => logger.warn("Failed to save code test result", { title, error: (e as Error).message }));

  return result;
}
