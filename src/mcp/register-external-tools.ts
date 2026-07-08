/**
 * External MCP tool registrations (MiniMax, filesystem, terminal, git, code-analysis).
 *
 * These tools are self-contained — each wraps a handler from mcp/tools/. They
 * do not depend on server-local closures and are safe to extract.
 *
 * Originally inlined in mcp/server.ts; extracted to reduce the serving module
 * from ~3500 to ~2300 lines and demonstrate the grouping pattern. The
 * remaining ~100+ internal tools (memory, scene, pipeline, dre, kg, persona,
 * etc.) should follow the same pattern in a follow-up.
 */
import { z } from "zod";
import type { ToolRegistry } from "./tool-registry.js";

import {
  minimaxWebSearch,
  minimaxImageUnderstand,
  checkMiniMaxHealth,
  getMiniMaxInfo,
} from "./tools/minimax.js";

import {
  readFile,
  writeFile,
  listDirectory,
  searchFiles,
  deleteFile,
  moveFile,
} from "./tools/filesystem.js";

import {
  executeCommand,
  listProcesses,
  getSystemInfo,
} from "./tools/terminal.js";

import {
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitBlame,
} from "./tools/git.js";

import {
  findSymbols,
  findReferences,
  getDiagnostics,
  getFileOutline,
  analyzeCode,
} from "./tools/code-analysis.js";

/**
 * Register all self-contained external tools on the given registry.
 * Called once from mcp/server.ts after the registry is created.
 */
export function registerExternalTools(registry: ToolRegistry): void {
  // ── MiniMax ──────────────────────────────────────────────────────
  registry.add({
    name: "minimax_web_search",
    description: "MiniMax 网络搜索（实时搜索结果，支持中文优化）",
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      num: z.number().optional().default(10).describe("返回结果数量"),
      lang: z.string().optional().default("zh").describe("搜索语言"),
    },
    handler: async (args) => {
      const result = await minimaxWebSearch(args.query as string, {
        num: args.num as number,
        lang: args.lang as string,
      });
      return {
        success: result.success,
        query: result.query,
        total_results: result.totalResults,
        results: result.results.map((r) => ({
          title: r.title,
          link: r.link,
          snippet: r.snippet,
          displayed_url: r.displayedUrl,
          date: r.date,
        })),
      };
    },
  });

  registry.add({
    name: "minimax_image_understand",
    description: "MiniMax 图像识别（分析图像内容，支持 URL 或 base64）",
    inputSchema: {
      image: z.string().describe("图像 URL 或 base64 编码数据"),
      prompt: z.string().optional().describe("自定义提示词（可选）"),
    },
    handler: async (args) => {
      const result = await minimaxImageUnderstand(args.image as string, {
        prompt: args.prompt as string,
      });
      return {
        success: result.success,
        description: result.result?.description,
        objects: result.result?.objects,
        text: result.result?.text,
        scenes: result.result?.scenes,
        error: result.error,
      };
    },
  });

  registry.add({
    name: "minimax_health",
    description: "检查 MiniMax API 连接状态",
    inputSchema: {},
    handler: async () => {
      const health = await checkMiniMaxHealth();
      const info = getMiniMaxInfo();
      return {
        ok: health.ok,
        latency_ms: health.latency,
        error: health.error,
        configured: info.configured,
        base_url: info.baseUrl,
        has_token_plan: info.hasTokenPlan,
      };
    },
  });

  // ── File System ──────────────────────────────────────────────────
  registry.add({
    name: "fs_read",
    description: "读取文件内容（支持偏移和限制）",
    inputSchema: {
      path: z.string().describe("文件路径"),
      offset: z.number().optional().describe("起始行偏移"),
      limit: z.number().optional().describe("最大读取行数"),
    },
    handler: async (args) =>
      readFile(args.path as string, {
        offset: args.offset as number,
        limit: args.limit as number,
      }),
  });

  registry.add({
    name: "fs_write",
    description: "写入或追加文件内容",
    inputSchema: {
      path: z.string().describe("文件路径"),
      content: z.string().describe("写入内容"),
      append: z.boolean().optional().describe("是否追加模式"),
    },
    handler: async (args) =>
      writeFile(args.path as string, args.content as string, {
        append: args.append as boolean,
      }),
  });

  registry.add({
    name: "fs_list",
    description: "列出目录内容",
    inputSchema: {
      path: z.string().optional().describe("目录路径，默认当前目录"),
    },
    handler: async (args) => listDirectory((args.path as string) || "."),
  });

  registry.add({
    name: "fs_search",
    description: "在文件中搜索内容",
    inputSchema: {
      query: z.string().describe("搜索关键词或正则表达式"),
      path: z.string().optional().describe("搜索目录，默认当前目录"),
      maxResults: z.number().optional().describe("最大结果数"),
    },
    handler: async (args) =>
      searchFiles(args.query as string, {
        path: args.path as string,
        maxResults: args.maxResults as number,
      }),
  });

  registry.add({
    name: "fs_delete",
    description: "删除文件或目录",
    inputSchema: {
      path: z.string().describe("要删除的路径"),
    },
    handler: async (args) => deleteFile(args.path as string),
  });

  registry.add({
    name: "fs_move",
    description: "移动或重命名文件",
    inputSchema: {
      source: z.string().describe("源路径"),
      destination: z.string().describe("目标路径"),
    },
    handler: async (args) =>
      moveFile(args.source as string, args.destination as string),
  });

  // ── Terminal ─────────────────────────────────────────────────────
  registry.add({
    name: "terminal_exec",
    description: "执行终端命令（有安全检查）",
    inputSchema: {
      command: z.string().describe("要执行的命令"),
      cwd: z.string().optional().describe("工作目录"),
      timeout: z.number().optional().describe("超时毫秒数"),
    },
    handler: async (args) =>
      executeCommand(args.command as string, {
        cwd: args.cwd as string,
        timeout: args.timeout as number,
      }),
  });

  registry.add({
    name: "terminal_list",
    description: "列出当前进程",
    inputSchema: {},
    handler: async () => listProcesses(),
  });

  registry.add({
    name: "terminal_info",
    description: "获取系统信息",
    inputSchema: {},
    handler: async () => getSystemInfo(),
  });

  // ── Git ───────────────────────────────────────────────────────────
  registry.add({
    name: "git_status",
    description: "获取 Git 仓库状态",
    inputSchema: {
      repoPath: z.string().optional().describe("仓库路径，默认当前目录"),
    },
    handler: async (args) => gitStatus(args.repoPath as string),
  });

  registry.add({
    name: "git_diff",
    description: "获取 Git diff",
    inputSchema: {
      repoPath: z.string().optional().describe("仓库路径"),
      target: z.string().optional().describe("对比目标（commit/branch）"),
      filePath: z.string().optional().describe("指定文件路径"),
      staged: z.boolean().optional().describe("是否只看 staged"),
    },
    handler: async (args) =>
      gitDiff(args.repoPath as string, {
        since: args.target as string,
        file: args.filePath as string,
        staged: args.staged as boolean,
      }),
  });

  registry.add({
    name: "git_log",
    description: "获取 Git 提交历史",
    inputSchema: {
      repoPath: z.string().optional().describe("仓库路径"),
      maxCount: z.number().optional().describe("最大提交数"),
      filePath: z.string().optional().describe("指定文件"),
    },
    handler: async (args) =>
      gitLog(args.repoPath as string, {
        maxCount: args.maxCount as number,
        file: args.filePath as string,
      }),
  });

  registry.add({
    name: "git_branch",
    description: "获取 Git 分支信息",
    inputSchema: {
      repoPath: z.string().optional().describe("仓库路径"),
    },
    handler: async (args) => gitBranch(args.repoPath as string),
  });

  registry.add({
    name: "git_blame",
    description: "获取文件 Git blame 信息",
    inputSchema: {
      filePath: z.string().describe("文件路径"),
      repoPath: z.string().optional().describe("仓库路径"),
    },
    handler: async (args) =>
      gitBlame((args.repoPath as string) || ".", args.filePath as string),
  });

  // ── Code Analysis ────────────────────────────────────────────────
  registry.add({
    name: "code_symbols",
    description: "查找代码中的符号（函数、类、接口等）",
    inputSchema: {
      filePath: z.string().describe("文件路径"),
      type: z
        .enum(["function", "class", "interface", "type", "variable", "export"])
        .optional()
        .describe("符号类型过滤"),
    },
    handler: async (args) => {
      const result = await findSymbols(args.filePath as string);
      const filterType = args.type as string;
      if (filterType && result.success && result.symbols) {
        result.symbols = result.symbols.filter(
          (s: any) => s.type === filterType,
        );
      }
      return result;
    },
  });

  registry.add({
    name: "code_references",
    description: "查找符号引用",
    inputSchema: {
      symbol: z.string().describe("符号名称"),
      path: z.string().optional().describe("搜索目录"),
    },
    handler: async (args) =>
      findReferences(args.symbol as string, args.path as string),
  });

  registry.add({
    name: "code_diagnostics",
    description: "获取 TypeScript 诊断信息",
    inputSchema: {
      filePath: z.string().optional().describe("指定文件路径，默认全项目"),
    },
    handler: async (args) => getDiagnostics(args.filePath as string),
  });

  registry.add({
    name: "code_outline",
    description: "获取文件代码大纲",
    inputSchema: {
      filePath: z.string().describe("文件路径"),
    },
    handler: async (args) => getFileOutline(args.filePath as string),
  });

  registry.add({
    name: "code_analyze",
    description: "分析代码复杂度、依赖和 TODO",
    inputSchema: {
      filePath: z.string().describe("文件路径"),
    },
    handler: async (args) => analyzeCode(args.filePath as string),
  });
}
