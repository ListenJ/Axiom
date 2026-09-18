import { logger } from "../utils/logger.js";
import { PiCodeToolsAdapter, type PiToolResult } from "./pi-code-tools.js";
import type { ChatMessage } from "../router/model-router.js";

export interface PiAgentRetrievalResult {
  content: string;
  source: "pi-read" | "pi-grep" | "pi-find" | "pi-ls" | "pi-batch";
  toolUsed: string;
  success: boolean;
  executionTimeMs: number;
  tokenSaved: number; // 估算节省的 token 数
  error?: string;
}

export interface PiAgentRetrievalOptions {
  cwd?: string;
  maxLines?: number;
  maxBytes?: number;
  useParallel?: boolean;
}

/**
 * Pi Agent 代码检索适配器
 *
 * 使用 Pi Agent 的本地工具执行代码检索任务，避免消耗 LLM token。
 * 适用于：
 *   - 读取文件内容
 *   - 代码搜索（grep）
 *   - 文件查找
 *   - 目录浏览
 */
export class PiAgentAdapter {
  private tools: PiCodeToolsAdapter;
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
    this.tools = new PiCodeToolsAdapter(this.cwd);
  }

  /**
   * 检索与查询相关的代码上下文
   *
   * 策略：
   *   1. 先用 grep 搜索相关文件
   *   2. 读取最相关的文件
   *   3. 返回格式化上下文
   */
  async retrieveCodeContext(
    query: string,
    options: PiAgentRetrievalOptions = {}
  ): Promise<PiAgentRetrievalResult> {
    const startTime = Date.now();

    try {
      // Step 1: 搜索相关文件
      const grepResult = await this.tools.grep(query, {
        path: options.cwd ?? this.cwd,
      });

      if (!grepResult.success || !grepResult.content) {
      return {
        content: "",
        source: "pi-grep",
        toolUsed: "grep",
        success: false,
        executionTimeMs: Date.now() - startTime,
        tokenSaved: 0,
        error: "No grep results found",
      };
      }

      // Step 2: 提取文件路径并读取
      const filePaths = this.extractFilePaths(grepResult.content);
      let combinedContent = `## Search Results for "${query}"\n\n`;
      combinedContent += `### Matches Found\n${grepResult.content}\n\n`;

      // Step 3: 读取最相关的文件（最多 3 个）
      const topFiles = filePaths.slice(0, 3);
      for (const filePath of topFiles) {
        const readResult = await this.tools.readFile(filePath, {
          limit: options.maxLines ?? 100,
        });

        if (readResult.success) {
          combinedContent += `### File: ${filePath}\n\n${readResult.content}\n\n`;
        }
      }

      const executionTime = Date.now() - startTime;
      const tokenSaved = this.estimateTokensSaved(query, combinedContent);

      logger.info("[PiAgent] Code context retrieved", {
        query: query.slice(0, 50),
        filesRead: topFiles.length,
        executionTime,
        tokenSaved,
      });

      return {
        content: combinedContent,
        source: "pi-batch",
        toolUsed: "read+grep",
        success: true,
        executionTimeMs: executionTime,
        tokenSaved,
      };
    } catch (error) {
      logger.error(
        "[PiAgent] Retrieval failed",
        error instanceof Error ? error : new Error(String(error))
      );

      return {
        content: "",
        source: "pi-batch",
        toolUsed: "read+grep",
        success: false,
        executionTimeMs: Date.now() - startTime,
        tokenSaved: 0,
      };
    }
  }

  /**
   * 直接读取文件（用于已知路径的场景）
   */
  async readFile(
    filePath: string,
    options?: { offset?: number; limit?: number }
  ): Promise<PiAgentRetrievalResult> {
    const startTime = Date.now();

    const result = await this.tools.readFile(filePath, options);

    return {
      content: result.content,
      source: "pi-read",
      toolUsed: "read",
      success: result.success,
      executionTimeMs: Date.now() - startTime,
      tokenSaved: result.success ? this.estimateFileTokens(result.content) : 0,
    };
  }

  /**
   * 搜索代码库
   */
  async searchCode(
    query: string,
    path?: string
  ): Promise<PiAgentRetrievalResult> {
    const startTime = Date.now();

    const result = await this.tools.grep(query, { path });

    return {
      content: result.content,
      source: "pi-grep",
      toolUsed: "grep",
      success: result.success,
      executionTimeMs: Date.now() - startTime,
      tokenSaved: result.success ? this.estimateTokensSaved(query, result.content) : 0,
    };
  }

  /**
   * 查找文件
   */
  async findFiles(pattern: string): Promise<PiAgentRetrievalResult> {
    const startTime = Date.now();

    const result = await this.tools.findFiles(pattern);

    return {
      content: result.content,
      source: "pi-find",
      toolUsed: "find",
      success: result.success,
      executionTimeMs: Date.now() - startTime,
      tokenSaved: 0, // 查找操作本身不节省 token
    };
  }

  /**
   * 列出目录
   */
  async listDirectory(dirPath: string): Promise<PiAgentRetrievalResult> {
    const startTime = Date.now();

    const result = await this.tools.listDirectory(dirPath);

    return {
      content: result.content,
      source: "pi-ls",
      toolUsed: "ls",
      success: result.success,
      executionTimeMs: Date.now() - startTime,
      tokenSaved: 0,
    };
  }

  /**
   * 批量检索（并行执行多个工具）
   */
  async batchRetrieve(
    operations: Array<{
      type: "read" | "grep" | "find" | "ls";
      params: Record<string, unknown>;
    }>
  ): Promise<PiAgentRetrievalResult[]> {
    const startTime = Date.now();

    const toolOperations = operations.map((op) => ({
      tool: op.type,
      params: op.params,
    }));

    const results = await this.tools.executeBatch(toolOperations);

    return results.map((result, index) => ({
      content: result.content,
      source: `pi-${operations[index].type}` as PiAgentRetrievalResult["source"],
      toolUsed: operations[index].type,
      success: result.success,
      executionTimeMs: Date.now() - startTime,
      tokenSaved: result.success ? this.estimateTokensSaved(JSON.stringify(operations[index]), result.content) : 0,
    }));
  }

  /**
   * 将 Pi Agent 结果转换为 ChatMessage 格式
   */
  static toChatMessage(result: PiAgentRetrievalResult): ChatMessage {
    return {
      role: "system",
      content: `[${result.source}] Retrieved context:\n${result.content}`,
    };
  }

  /**
   * 将多个 Pi Agent 结果合并为单个 ChatMessage
   */
  static mergeToChatMessage(results: PiAgentRetrievalResult[]): ChatMessage {
    const successful = results.filter((r) => r.success);
    const content = successful
      .map((r) => `## ${r.source}\n${r.content}`)
      .join("\n\n---\n\n");

    return {
      role: "system",
      content: `[Pi Agent Retrieval Results]\n\n${content}`,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有辅助方法
  // ═══════════════════════════════════════════════════════════════

  private extractFilePaths(grepOutput: string): string[] {
    const lines = grepOutput.split("\n");
    const paths = new Set<string>();

    for (const line of lines) {
      // 提取文件名（格式通常是: file_path:line_number:content）
      const match = line.match(/^([^:]+):\d+:/);
      if (match) {
        paths.add(match[1]);
      }
    }

    return Array.from(paths);
  }

  private estimateTokensSaved(query: string, result: string): number {
    // 估算：如果通过 LLM 检索，需要发送查询 + 接收结果
    // 本地工具只消耗结果 tokens，不消耗查询 tokens
    const queryTokens = query.length / 4;
    const resultTokens = result.length / 4;
    return Math.floor(queryTokens + resultTokens * 0.5); // 保守估算节省 50%
  }

  private estimateFileTokens(content: string): number {
    return Math.floor(content.length / 4);
  }
}

export const piAgentAdapter = new PiAgentAdapter();