/**
 * Scene Router — 场景驱动的工具调用系统
 * 
 * 无需 LLM，根据输入文本快速匹配场景并调用 MCP 工具。
 * 用于高频、确定性任务，降低延迟和 Token 消耗。
 */

import { ToolRegistry } from "./tool-registry.js";

/** 场景匹配函数 */
type SceneMatcher = (input: string) => boolean;

/** 场景定义 */
export interface Scene {
  id: string;
  name: string;
  description: string;
  /** 匹配规则：关键词列表或自定义匹配函数 */
  match: string[] | SceneMatcher;
  /** 该场景需要调用的工具列表 */
  tools: string[];
  /** 工具参数映射（从输入提取参数） */
  paramMap?: Record<string, string>;
  /** 是否并行执行工具 */
  parallel?: boolean;
  /** 优先级（数字越大越优先） */
  priority?: number;
}

/** 场景执行结果 */
export interface SceneResult {
  sceneId: string;
  sceneName: string;
  executed: Array<{
    tool: string;
    success: boolean;
    result: unknown;
    error?: string;
  }>;
  duration: number;
}

/** 场景路由器 */
export class SceneRouter {
  private scenes: Scene[] = [];
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** 注册场景 */
  addScene(scene: Scene): this {
    this.scenes.push({ priority: 0, parallel: false, ...scene });
    // 按优先级排序（高优先级在前）
    this.scenes.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return this;
  }

  /** 批量注册场景 */
  addScenes(scenes: Scene[]): this {
    for (const scene of scenes) this.addScene(scene);
    return this;
  }

  /** 匹配场景 */
  match(input: string): Scene | null {
    const normalized = input.toLowerCase();
    
    for (const scene of this.scenes) {
      if (Array.isArray(scene.match)) {
        // 关键词匹配
        if (scene.match.some(kw => normalized.includes(kw.toLowerCase()))) {
          return scene;
        }
      } else {
        // 自定义匹配函数
        if (scene.match(input)) {
          return scene;
        }
      }
    }
    return null;
  }

  /** 执行场景 */
  async execute(input: string, context?: Record<string, unknown>): Promise<SceneResult> {
    const start = performance.now();
    const scene = this.match(input);
    
    if (!scene) {
      return {
        sceneId: "none",
        sceneName: "未匹配",
        executed: [],
        duration: Math.round(performance.now() - start),
      };
    }

    const handlers = this.registry.buildHttpHandlers();
    const executed: SceneResult["executed"] = [];

    if (scene.parallel) {
      // 并行执行
      const results = await Promise.all(
        scene.tools.map(async (toolName) => {
          const handler = handlers[toolName];
          if (!handler) {
            return { tool: toolName, success: false, result: null, error: `Tool ${toolName} not found` };
          }
          try {
            const params = this.buildParams(input, toolName, context);
            const result = await handler(params);
            return { tool: toolName, success: true, result };
          } catch (e: unknown) {
            return { tool: toolName, success: false, result: null, error: e instanceof Error ? e.message : String(e) };
          }
        })
      );
      executed.push(...results);
    } else {
      // 串行执行
      for (const toolName of scene.tools) {
        const handler = handlers[toolName];
        if (!handler) {
          executed.push({ tool: toolName, success: false, result: null, error: `Tool ${toolName} not found` });
          continue;
        }
        try {
          const params = this.buildParams(input, toolName, context);
          const result = await handler(params);
          executed.push({ tool: toolName, success: true, result });
        } catch (e: unknown) {
          executed.push({ tool: toolName, success: false, result: null, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    return {
      sceneId: scene.id,
      sceneName: scene.name,
      executed,
      duration: Math.round(performance.now() - start),
    };
  }

  /** 构建工具参数 */
  private buildParams(input: string, toolName: string, context?: Record<string, unknown>): Record<string, unknown> {
    // 基础参数：输入文本和上下文
    const params: Record<string, unknown> = {
      input,
      ...(context || {}),
    };

    // 从输入提取常见参数
    const fileMatch = input.match(/[\w\-/]+\.(ts|js|py|json|md|txt|yml|yaml)/);
    if (fileMatch) {
      params.filePath = fileMatch[0];
    }

    const urlMatch = input.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      params.url = urlMatch[0];
    }

    return params;
  }

  /** 列出所有场景 */
  listScenes(): Array<{ id: string; name: string; description: string; tools: string[] }> {
    return this.scenes.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tools: s.tools,
    }));
  }

  /** 获取单个场景详情 */
  getScene(id: string): Scene | null {
    return this.scenes.find(s => s.id === id) || null;
  }
}

/** 预定义场景库 */
export const DEFAULT_SCENES: Scene[] = [
  {
    id: "git_ops",
    name: "Git 操作",
    description: "查看 git 状态、diff、log、branch",
    match: ["git", "提交", "分支", "diff", "status", "log", "blame"],
    tools: ["git_status", "git_diff", "git_log", "git_branch"],
    parallel: true,
    priority: 10,
  },
  {
    id: "file_read",
    name: "文件读取",
    description: "读取文件内容",
    match: ["读取", "查看", "read", "show", "content", "cat"],
    tools: ["read_file"],
    priority: 5,
  },
  {
    id: "file_write",
    name: "文件写入",
    description: "写入或修改文件",
    match: ["写入", "修改", "write", "edit", "update", "create"],
    tools: ["write_file"],
    priority: 5,
  },
  {
    id: "code_analysis",
    name: "代码分析",
    description: "分析代码结构、符号、诊断",
    match: ["分析", "符号", "诊断", "analyze", "symbol", "diagnostic", "outline"],
    tools: ["find_symbols", "get_diagnostics", "get_file_outline", "analyze_code"],
    parallel: true,
    priority: 8,
  },
  {
    id: "terminal",
    name: "终端命令",
    description: "执行终端命令",
    match: ["执行", "运行", "execute", "run", "command", "cmd", "npm", "bun"],
    tools: ["execute_command"],
    priority: 7,
  },
  {
    id: "search",
    name: "搜索",
    description: "Web 搜索或文件搜索",
    match: ["搜索", "查找", "search", "find", "google", "查询"],
    tools: ["web_search", "search_files"],
    parallel: true,
    priority: 6,
  },
  {
    id: "memory",
    name: "记忆库",
    description: "Vault 记忆库操作",
    match: ["记忆", "vault", "笔记", "note", "知识", "knowledge"],
    tools: ["memory_search", "memory_stats"],
    priority: 4,
  },
];
