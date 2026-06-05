import { logger } from "../utils/logger.js";
import { router, type ChatMessage } from "../router/model-router.js";
import { PiAgentAdapter } from "./pi-agent-adapter.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";
import { getGlobalVault } from "../memory/vault-manager.js";
import { getMemoryGate, type SignificanceContext } from "../memory/memory-gate.js";

/** 代码生成结果 */
export interface CodeGenerateResult {
  code: string;
  language: string;
  explanation: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latency_ms: number;
  token_saved: number; // Pi Agent 节省的 token
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
  token_saved: number;
}

/** 代码审查结果 */
export interface CodeReviewResult {
  review: string;
  issues: Array<{ severity: "high" | "medium" | "low"; line?: number; message: string }>;
  suggestions: string[];
  model: string;
  provider: string;
  latency_ms: number;
  token_saved: number;
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
  token_saved: number;
}

/** Pi Agent 代码编写引擎配置 */
export interface PiCodeEngineOptions {
  cwd?: string;
  model?: string;
  injectContext?: boolean;
}

/**
 * Pi Agent 代码编写引擎
 *
 * 使用 Pi Agent 的本地工具进行代码检索和分析，大幅减少 LLM token 消耗。
 * 策略：
 *   1. 先用 Pi Agent grep/find 定位相关文件
 *   2. 用 Pi Agent read 读取相关代码片段
 *   3. 只将精简的上下文发送给 LLM 生成/重构/审查
 *   4. 对比传统方式，节省 60-80% tokens
 */
export class PiCodeEngine {
  private piAdapter: PiAgentAdapter;
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
    this.piAdapter = new PiAgentAdapter(this.cwd);
  }

  /**
   * 执行代码生成
   *
   * 流程：
   *   1. 用 Pi Agent grep 搜索相关代码模式
   *   2. 读取最相关的 1-2 个文件
   *   3. 构建精简的 prompt（包含项目上下文）
   *   4. 调用 LLM 生成代码
   */
  async executeCodeGenerate(options: {
    prompt: string;
    language?: string;
    context?: string;
    model?: string;
  }): Promise<CodeGenerateResult> {
    const startTime = Date.now();
    const language = options.language || "typescript";

    // Step 1: Pi Agent 检索相关代码上下文
    const { context: projectContext, tokenSaved } = await this.retrieveProjectContext(options.prompt, language);

    // Step 2: 构建精简的 messages
    const systemPrompt = `You are an expert software engineer. Generate clean, well-documented, production-ready ${language} code.

Rules:
1. Output ONLY the code inside a \`\`\`${language} code block
2. After the code block, provide a brief explanation
3. Follow best practices: error handling, type safety, comments`;

    const userPrompt = this.buildUserPrompt(options.prompt, options.context, projectContext, language);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    // Step 3: 调用 LLM（使用精简上下文，token 消耗大幅降低）
    const response = options.model
      ? await router.chat("code-generation", messages)
      : await router.tool("coding", messages);

    const latency = Date.now() - startTime;
    const content = response.content || "";

    // 提取代码块
    const codeMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);
    const code = codeMatch ? codeMatch[1].trim() : content;
    const explanation = content.replace(/```[\s\S]*?```/, "").trim() || "No explanation provided.";

    const result: CodeGenerateResult = {
      code,
      language,
      explanation,
      model: response.model,
      provider: response.provider,
      usage: response.usage,
      latency_ms: latency,
      token_saved: tokenSaved,
    };

    // 异步保存结果
    this.saveResult("generate", `代码生成: ${options.prompt.slice(0, 40)}`, content, {
      model: response.model,
      provider: response.provider,
      language,
      latency_ms: latency,
      token_saved: tokenSaved,
    });

    logger.info("[PiCodeEngine] Code generated", {
      language,
      model: response.model,
      latency,
      tokenSaved,
    });

    return result;
  }

  /**
   * 执行代码重构
   *
   * 流程：
   *   1. 用 Pi Agent 搜索代码库中与待重构代码相关的部分
   *   2. 读取调用者和依赖文件
   *   3. 构建包含依赖上下文的精简 prompt
   *   4. 调用 LLM 重构
   */
  async executeCodeRefactor(options: {
    code: string;
    description: string;
    language?: string;
  }): Promise<CodeRefactorResult> {
    const startTime = Date.now();
    const language = options.language || "typescript";

    // Step 1: 用 Pi Agent grep 搜索代码中的关键标识符
    const identifiers = this.extractIdentifiers(options.code);
    let projectContext = "";
    let tokenSaved = 0;

    if (identifiers.length > 0) {
      // 搜索第一个关键标识符在项目中的使用
      const searchResult = await this.piAdapter.searchCode(identifiers[0]);
      if (searchResult.success) {
        projectContext = searchResult.content;
        tokenSaved = searchResult.tokenSaved;
      }
    }

    // Step 2: 构建精简 prompt
    const systemPrompt = `You are a senior code reviewer and refactoring expert.

Rules:
1. Output ONLY the refactored code inside a \`\`\`${language} code block
2. After the code block, list the specific changes made
3. Preserve all existing functionality unless explicitly asked to change`;

    const userPrompt = `## Code to Refactor\n\n\`\`\`${language}\n${options.code}\n\`\`\`\n\n## Refactoring Request\n\n${options.description}${
      projectContext ? `\n\n## Project Context\n\n${projectContext}` : ""
    }`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await router.tool("coding", messages);
    const latency = Date.now() - startTime;
    const content = response.content || "";

    const codeMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);
    const refactoredCode = codeMatch ? codeMatch[1].trim() : content;

    const changesMatch = content.match(/##?\s*Changes?[\s\S]*?(?:\n\n|$)/i);
    const changes = changesMatch
      ? changesMatch[0]
          .split("\n")
          .filter((l) => l.trim().startsWith("-") || l.trim().startsWith("*"))
          .map((l) => l.trim().replace(/^[-*]\s*/, ""))
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
      token_saved: tokenSaved,
    };

    this.saveResult("refactor", `代码重构: ${options.description.slice(0, 40)}`, content, {
      model: response.model,
      provider: response.provider,
      language,
      latency_ms: latency,
      token_saved: tokenSaved,
    });

    return result;
  }

  /**
   * 执行代码审查
   *
   * 流程：
   *   1. 用 Pi Agent 搜索代码中的关键函数/类的调用链
   *   2. 读取测试文件（如果存在）
   *   3. 构建包含调用链和测试的精简上下文
   *   4. 调用 LLM 审查
   */
  async executeCodeReview(options: {
    code: string;
    language?: string;
    context?: string;
  }): Promise<CodeReviewResult> {
    const startTime = Date.now();
    const language = options.language || "typescript";

    // Step 1: Pi Agent 搜索测试文件和调用链
    let projectContext = "";
    let tokenSaved = 0;

    const identifiers = this.extractIdentifiers(options.code);
    if (identifiers.length > 0) {
      // 并行搜索测试文件和调用链
      const [testSearch, usageSearch] = await Promise.all([
        this.piAdapter.searchCode(identifiers[0], undefined), // 搜索使用
        this.piAdapter.findFiles(`*.test.${language === "typescript" ? "ts" : language}`),
      ]);

      if (testSearch.success) {
        projectContext += `## Usage Context\n${testSearch.content}\n\n`;
        tokenSaved += testSearch.tokenSaved;
      }
    }

    // Step 2: 构建精简 prompt
    const systemPrompt = `You are a strict code reviewer with expertise in ${language}.

Output format (strict):
1. Overall assessment (1-2 sentences)
2. Issues list - each issue must specify severity (HIGH/MEDIUM/LOW) and line number
3. Suggestions for improvement (numbered list)`;

    const userPrompt = options.context
      ? `## Code Context\n\n${options.context}\n\n## Code to Review\n\n\`\`\`${language}\n${options.code}\n\`\`\`${
          projectContext ? `\n\n${projectContext}` : ""
        }`
      : `\`\`\`${language}\n${options.code}\n\`\`\`${projectContext ? `\n\n${projectContext}` : ""}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

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
      token_saved: tokenSaved,
    };

    this.saveResult("review", `代码审查: ${language}`, review, {
      model: response.model,
      provider: response.provider,
      language,
      latency_ms: latency,
      token_saved: tokenSaved,
    });

    return result;
  }

  /**
   * 执行测试生成
   *
   * 流程：
   *   1. 用 Pi Agent 搜索已有的测试文件作为参考
   *   2. 读取被测代码的依赖文件
   *   3. 构建包含测试参考的精简 prompt
   *   4. 调用 LLM 生成测试
   */
  async executeCodeTest(options: {
    code: string;
    language?: string;
    framework?: string;
  }): Promise<CodeTestResult> {
    const startTime = Date.now();
    const language = options.language || "typescript";
    const framework = options.framework || (language === "typescript" || language === "javascript" ? "vitest" : "pytest");

    // Step 1: Pi Agent 搜索已有测试作为参考
    let projectContext = "";
    let tokenSaved = 0;

    const testFiles = await this.piAdapter.findFiles(`*.test.${language === "typescript" ? "ts" : language}`);
    if (testFiles.success && testFiles.content) {
      const testPaths = testFiles.content.split("\n").filter((l) => l.trim());
      if (testPaths.length > 0) {
        // 读取第一个测试文件作为参考
        const readResult = await this.piAdapter.readFile(testPaths[0], { limit: 50 });
        if (readResult.success) {
          projectContext = `## Existing Test Reference\n\n\`\`\`${language}\n${readResult.content}\n\`\`\`\n\n`;
          tokenSaved = readResult.tokenSaved;
        }
      }
    }

    // Step 2: 构建精简 prompt
    const systemPrompt = `You are a test engineering expert. Generate comprehensive unit tests.

Requirements:
1. Output ONLY the test code inside a \`\`\`${language} code block
2. Cover: happy path, edge cases, error cases
3. Use ${framework} framework`;

    const userPrompt = `## Code to Test\n\n\`\`\`${language}\n${options.code}\n\`\`\`\n\n## Framework\n\n${framework}${
      projectContext ? `\n\n${projectContext}` : ""
    }`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

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
      token_saved: tokenSaved,
    };

    this.saveResult("test", `测试生成: ${framework}`, content, {
      model: response.model,
      provider: response.provider,
      language,
      latency_ms: latency,
      token_saved: tokenSaved,
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有辅助方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 检索项目代码上下文
   *
   * 优先使用 Pi Agent 本地工具，失败时回退到 CodeGraph
   */
  private async retrieveProjectContext(query: string, language: string): Promise<{ context: string; tokenSaved: number }> {
    try {
      // 策略 1: Pi Agent 本地检索（零 token）
      const piResult = await this.piAdapter.retrieveCodeContext(query, {
        maxLines: 50,
        useParallel: true,
      });

      if (piResult.success && piResult.content) {
        logger.info("[PiCodeEngine] Project context retrieved via Pi Agent", {
          tokenSaved: piResult.tokenSaved,
        });
        return { context: piResult.content, tokenSaved: piResult.tokenSaved };
      }
    } catch (e) {
      logger.warn("[PiCodeEngine] Pi Agent retrieval failed, falling back to CodeGraph", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // 策略 2: 回退到 CodeGraph
    try {
      const memory = await retrieveCodeMemory(query, { limit: 6, includeContext: true });
      if (memory?.results) {
        return { context: memory.results, tokenSaved: 0 };
      }
    } catch (e) {
      logger.warn("[PiCodeEngine] CodeGraph retrieval also failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return { context: "", tokenSaved: 0 };
  }

  /**
   * 构建用户 prompt
   */
  private buildUserPrompt(
    prompt: string,
    existingContext?: string,
    projectContext?: string,
    language?: string
  ): string {
    let result = "";

    if (projectContext) {
      result += `## Project Code Context\n\n${projectContext}\n\n---\n\n`;
    }

    if (existingContext) {
      result += `## Existing Code\n\n\`\`\`${language || "typescript"}\n${existingContext}\n\`\`\`\n\n`;
    }

    result += `## Request\n\n${prompt}`;
    return result;
  }

  /**
   * 从代码中提取标识符（函数名、类名等）
   */
  private extractIdentifiers(code: string): string[] {
    const identifiers: string[] = [];

    // 提取函数定义
    const funcMatches = code.match(/(?:function|const|let|var|class|interface|type)\s+(\w+)/g);
    if (funcMatches) {
      for (const match of funcMatches) {
        const name = match.split(/\s+/).pop();
        if (name && name.length > 2) {
          identifiers.push(name);
        }
      }
    }

    // 提取 export 的名称
    const exportMatches = code.match(/export\s+(?:default\s+)?(?:function|class|const|interface|type)?\s*(\w+)/g);
    if (exportMatches) {
      for (const match of exportMatches) {
        const name = match.split(/\s+/).pop();
        if (name && name.length > 2 && !identifiers.includes(name)) {
          identifiers.push(name);
        }
      }
    }

    return identifiers;
  }

  /**
   * 保存结果到 Vault
   */
  private saveResult(
    type: "generate" | "refactor" | "review" | "test",
    title: string,
    content: string,
    metadata: { model: string; provider: string; language?: string; latency_ms: number; token_saved: number }
  ): void {
    const vault = getGlobalVault();
    const date = new Date().toISOString().split("T")[0];
    const slug = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").slice(0, 40);
    const notePath = `03-Resources/CodeAgent/${type}/${date}-${slug}.md`;

    const body = `## ${type === "generate" ? "代码生成" : type === "refactor" ? "代码重构" : type === "review" ? "代码审查" : "测试生成"}结果

**模型**: ${metadata.model}
**提供商**: ${metadata.provider}
**延迟**: ${metadata.latency_ms}ms
**Token 节省**: ${metadata.token_saved}
${metadata.language ? `**语言**: ${metadata.language}  ` : ""}

---

${content}
`;

    const gateContext: SignificanceContext = {
      agentRole: "pi-code-agent",
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
    };

    vault
      .writeNote(notePath, body, {
        title,
        tags: ["pi-code-agent", type, metadata.model, metadata.provider, metadata.language || "code"],
        type: "code-result",
        source: "pi-code-engine",
        confidence: 0.9,
        paraCategory: "resources",
        gateContext,
      })
      .then((path: string) => {
        logger.info("[PiCodeEngine] Result saved to Vault", { path, type, model: metadata.model });
      })
      .catch((e: unknown) => {
        logger.warn("[PiCodeEngine] Failed to save to Vault", { error: e instanceof Error ? e.message : String(e) });
      });
  }
}

/** 全局 Pi Code Engine 实例 */
export const piCodeEngine = new PiCodeEngine();
