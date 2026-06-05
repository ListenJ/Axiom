import { createReadTool, createGrepTool, createFindTool, createLsTool } from "../../vendor/pi-agent/packages/coding-agent/src/core/tools/index.js";
import type { AgentTool, AgentToolResult } from "../../vendor/pi-agent/packages/agent/src/index.js";
import { logger } from "../utils/logger.js";

export type PiToolName = "read" | "grep" | "find" | "ls";

export interface PiToolResult {
  content: string;
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface PiCodeRetrievalOptions {
  cwd: string;
  maxLines?: number;
  maxBytes?: number;
}

/**
 * Pi Agent 工具适配器
 *
 * 将 Pi Agent 的本地工具（read, grep, find, ls）暴露给 OpenClaw 使用。
 * 这些工具在本地执行，不消耗 LLM token。
 */
export class PiCodeToolsAdapter {
  private tools: Map<PiToolName, AgentTool<any>> = new Map();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.initializeTools();
  }

  private initializeTools(): void {
    this.tools.set("read", createReadTool(this.cwd));
    this.tools.set("grep", createGrepTool(this.cwd));
    this.tools.set("find", createFindTool(this.cwd));
    this.tools.set("ls", createLsTool(this.cwd));

    logger.info("[PiCodeTools] Initialized", {
      cwd: this.cwd,
      tools: Array.from(this.tools.keys()),
    });
  }

  /**
   * 读取文件内容
   */
  async readFile(
    filePath: string,
    options?: { offset?: number; limit?: number }
  ): Promise<PiToolResult> {
    const tool = this.tools.get("read");
    if (!tool) throw new Error("Read tool not initialized");

    try {
      const result = (await tool.execute("read-1", {
        file_path: filePath,
        offset: options?.offset,
        limit: options?.limit,
      })) as AgentToolResult<any>;

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details,
      };
    } catch (error) {
      return {
        content: "",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 在代码库中搜索文本
   */
  async grep(
    query: string,
    options?: { path?: string; include?: string }
  ): Promise<PiToolResult> {
    const tool = this.tools.get("grep");
    if (!tool) throw new Error("Grep tool not initialized");

    try {
      const result = (await tool.execute("grep-1", {
        query,
        path: options?.path ?? this.cwd,
        include: options?.include,
      })) as AgentToolResult<any>;

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details,
      };
    } catch (error) {
      return {
        content: "",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 查找文件
   */
  async findFiles(
    pattern: string,
    options?: { path?: string }
  ): Promise<PiToolResult> {
    const tool = this.tools.get("find");
    if (!tool) throw new Error("Find tool not initialized");

    try {
      const result = (await tool.execute("find-1", {
        regex: pattern,
        path: options?.path ?? this.cwd,
      })) as AgentToolResult<any>;

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details,
      };
    } catch (error) {
      return {
        content: "",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 列出目录内容
   */
  async listDirectory(path: string): Promise<PiToolResult> {
    const tool = this.tools.get("ls");
    if (!tool) throw new Error("Ls tool not initialized");

    try {
      const result = (await tool.execute("ls-1", {
        path,
      })) as AgentToolResult<any>;

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details,
      };
    } catch (error) {
      return {
        content: "",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 批量执行工具调用（用于复杂检索）
   */
  async executeBatch(
    operations: Array<{ tool: PiToolName; params: Record<string, unknown> }>
  ): Promise<PiToolResult[]> {
    const results: PiToolResult[] = [];

    for (const op of operations) {
      const tool = this.tools.get(op.tool);
      if (!tool) {
        results.push({
          content: "",
          success: false,
          error: `Tool ${op.tool} not found`,
        });
        continue;
      }

      try {
        const result = (await tool.execute(
          `${op.tool}-batch`,
          op.params
        )) as AgentToolResult<any>;
        results.push({
          content: this.extractContent(result),
          success: true,
          details: result.details,
        });
      } catch (error) {
        results.push({
          content: "",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  private extractContent(result: AgentToolResult<any>): string {
    if (typeof result.details === "string") return result.details;
    if (result.details && typeof result.details === "object") {
      return JSON.stringify(result.details, null, 2);
    }
    return "";
  }
}

export const piCodeTools = new PiCodeToolsAdapter(process.cwd());