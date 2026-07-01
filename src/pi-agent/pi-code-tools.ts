import { isCodegraphInitialized, searchFiles } from "../memory/codegraph-index.js";
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

/** 轻量接口 — 屏蔽 vendor 内部类型 */
interface PiAgentTool {
  execute(id: string, params: Record<string, unknown>): Promise<{ details?: unknown }>;
}

/**
 * Pi Agent 工具适配器
 *
 * 将 Pi Agent 的本地工具（read, grep, find, ls）暴露给 Axiom 使用。
 * 这些工具在本地执行，不消耗 LLM token。
 *
 * 采用动态 import 加载 vendor 工具，避免编译时追踪 vendor 目录。
 */
export class PiCodeToolsAdapter {
  private tools: Map<PiToolName, PiAgentTool> = new Map();
  private cwd: string;
  private initialized = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const vendorPath = "../../vendor/pi-agent/packages/coding-agent/src/core/tools/index.js";
      const { createReadTool, createGrepTool, createFindTool, createLsTool } = await import(
        /* @vite-ignore */ vendorPath as string
      );

      this.tools.set("read", createReadTool(this.cwd) as PiAgentTool);
      this.tools.set("grep", createGrepTool(this.cwd) as PiAgentTool);
      this.tools.set("find", createFindTool(this.cwd) as PiAgentTool);
      this.tools.set("ls", createLsTool(this.cwd) as PiAgentTool);

      this.initialized = true;
      logger.info("[PiCodeTools] Initialized", {
        cwd: this.cwd,
        tools: Array.from(this.tools.keys()),
      });
    } catch (err) {
      logger.warn("[PiCodeTools] Vendor tools unavailable, using fallback", {
        error: (err as Error).message,
      });
      this.initialized = true; // 标记为已初始化，避免反复重试
    }
  }

  /**
   * 读取文件内容
   */
  async readFile(
    filePath: string,
    options?: { offset?: number; limit?: number }
  ): Promise<PiToolResult> {
    await this.ensureInitialized();
    const tool = this.tools.get("read");
    if (!tool) throw new Error("Read tool not initialized");

    try {
      const result = await tool.execute("read-1", {
        file_path: filePath,
        offset: options?.offset,
        limit: options?.limit,
      });

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details as Record<string, unknown> | undefined,
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
    await this.ensureInitialized();
    const tool = this.tools.get("grep");
    if (!tool) throw new Error("Grep tool not initialized");

    try {
      const result = await tool.execute("grep-1", {
        query,
        path: options?.path ?? this.cwd,
        include: options?.include,
      });

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details as Record<string, unknown> | undefined,
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
   *
   * 优先使用 CodeGraph 索引查询，若未初始化则回退到原生 find 工具。
   */
  async findFiles(
    pattern: string,
    options?: { path?: string; limit?: number }
  ): Promise<PiToolResult> {
    try {
      const codegraphAvailable = await isCodegraphInitialized(this.cwd);

      if (codegraphAvailable) {
        const results = await searchFiles(pattern, {
          path: options?.path ?? this.cwd,
          limit: options?.limit ?? 1000,
          projectPath: this.cwd,
        });

        if (results.length === 0) {
          return {
            content: "No files found matching pattern",
            success: true,
          };
        }

        const paths = results.map((r) => r.path).join("\n");
        return {
          content: paths,
          success: true,
          details: { count: results.length },
        };
      }

      // Fallback: 回退到原生 find 工具
      await this.ensureInitialized();
      const tool = this.tools.get("find");
      if (!tool) throw new Error("Find tool not initialized");

      const result = await tool.execute("find-1", {
        pattern,
        path: options?.path ?? this.cwd,
        limit: options?.limit,
      });

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details as Record<string, unknown> | undefined,
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
    await this.ensureInitialized();
    const tool = this.tools.get("ls");
    if (!tool) throw new Error("Ls tool not initialized");

    try {
      const result = await tool.execute("ls-1", { path });

      return {
        content: this.extractContent(result),
        success: true,
        details: result.details as Record<string, unknown> | undefined,
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
    await this.ensureInitialized();
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
        const result = await tool.execute(`${op.tool}-batch`, op.params);
        results.push({
          content: this.extractContent(result),
          success: true,
          details: result.details as Record<string, unknown> | undefined,
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

  private extractContent(result: { details?: unknown }): string {
    if (typeof result.details === "string") return result.details;
    if (result.details && typeof result.details === "object") {
      return JSON.stringify(result.details, null, 2);
    }
    return "";
  }
}

export const piCodeTools = new PiCodeToolsAdapter(process.cwd());