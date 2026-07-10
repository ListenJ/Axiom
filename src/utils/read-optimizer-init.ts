/**
 * 读取优化管道初始化 — 注册所有数据源执行器
 *
 * 将 CodeGraph、Pi Agent 工具、Vault 等数据源注册到 ReadOptimizerFacade，
 * 使所有读取操作都经过统一的优化管道：
 *   - 黑板优先 (Blackboard-First)
 *   - 缓存层
 *   - 字段投影 (列裁剪)
 *   - 限流
 *   - 降级
 */

import { logger } from "./logger.js";
import { getReadOptimizer } from "./read-optimizer.js";

export interface ReadOptimizerDeps {
  searchSymbols: (query: string, opts?: any) => Promise<any[]>;
  searchFiles: (pattern: string, opts?: any) => Promise<any[]>;
  buildContext: (task: string, opts?: any) => Promise<any>;
  getCallers: (symbol: string, opts?: any) => Promise<any[]>;
  getCallees: (symbol: string, opts?: any) => Promise<any[]>;
  getImpact: (symbol: string, opts?: any) => Promise<any>;
  getStatus: (projectPath?: string) => Promise<any>;
  PiCodeToolsAdapter: new (workDir: string) => any;
}

let initialized = false;

export function initializeReadOptimizers(cwd?: string, deps?: ReadOptimizerDeps): void {
  if (initialized) return;
  if (!deps) {
    throw new Error(
      "ReadOptimizerDeps required — see src/main.ts for the dependency wiring"
    );
  }
  const facade = getReadOptimizer();
  const workDir = cwd ?? process.cwd();

  // ═══════════════════════════════════════════════════════════════
  // 1. CodeGraph 执行器
  // ═══════════════════════════════════════════════════════════════

  facade.registerExecutor("codegraph", async (req) => {
    const { action, params } = req;
    const projectPath = String(params.projectPath ?? workDir);

    switch (action) {
      case "searchSymbols": {
        const query = String(params.query ?? "");
        const kind = params.kind ? String(params.kind) : undefined;
        const limit = Number(params.limit ?? 10);
        const results = await deps.searchSymbols(query, { kind, limit, projectPath });
        // 字段投影已在 facade 中处理
        return results;
      }

      case "searchFiles": {
        const pattern = String(params.pattern ?? "*");
        const path = params.path ? String(params.path) : undefined;
        const limit = Number(params.limit ?? 100);
        return deps.searchFiles(pattern, { path, limit, projectPath });
      }

      case "buildContext": {
        const task = String(params.task ?? "");
        const maxNodes = Number(params.maxNodes ?? 10);
        return deps.buildContext(task, { maxNodes, includeCode: true, format: "markdown", projectPath });
      }

      case "getCallers": {
        const symbol = String(params.symbol ?? "");
        const limit = Number(params.limit ?? 10);
        return deps.getCallers(symbol, { limit, projectPath });
      }

      case "getCallees": {
        const symbol = String(params.symbol ?? "");
        const limit = Number(params.limit ?? 10);
        return deps.getCallees(symbol, { limit, projectPath });
      }

      case "getImpact": {
        const symbol = String(params.symbol ?? "");
        const depth = Number(params.depth ?? 2);
        return deps.getImpact(symbol, { depth, projectPath });
      }

      case "getStatus": {
        return deps.getStatus(projectPath);
      }

      default:
        throw new Error(`Unknown CodeGraph action: ${action}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. Pi Agent 工具执行器
  // ═══════════════════════════════════════════════════════════════

  const piTools = new deps.PiCodeToolsAdapter(workDir);

  facade.registerExecutor("pi-tools", async (req) => {
    const { action, params } = req;

    switch (action) {
      case "grep": {
        const query = String(params.query ?? "");
        const path = params.path ? String(params.path) : workDir;
        const result = await piTools.grep(query, { path });
        return { content: result.content, success: result.success };
      }

      case "find": {
        const pattern = String(params.pattern ?? "*");
        const path = params.path ? String(params.path) : workDir;
        const limit = params.limit ? Number(params.limit) : undefined;
        const result = await piTools.findFiles(pattern, { path, limit });
        return { content: result.content, success: result.success };
      }

      case "read": {
        const filePath = String(params.filePath ?? "");
        const offset = params.offset ? Number(params.offset) : undefined;
        const limit = params.limit ? Number(params.limit) : undefined;
        const result = await piTools.readFile(filePath, { offset, limit });
        return { content: result.content, success: result.success };
      }

      case "ls": {
        const path = String(params.path ?? workDir);
        const result = await piTools.listDirectory(path);
        return { content: result.content, success: result.success };
      }

      default:
        throw new Error(`Unknown Pi Tool action: ${action}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. Vault 执行器
  // ═══════════════════════════════════════════════════════════════

  const vaultEngineCache = new Map<string, import("../memory/deterministic-search.js").DeterministicSearchEngine>();

  facade.registerExecutor("vault", async (req) => {
    const { action, params } = req;
    const vaultPath = String(params.vaultPath ?? process.env.OBSIDIAN_VAULT_PATH ?? "./axiom-memory");

    switch (action) {
      case "search": {
        const { DeterministicSearchEngine } = await import("../memory/deterministic-search.js");
        let engine = vaultEngineCache.get(vaultPath);
        if (!engine) {
          engine = new DeterministicSearchEngine(vaultPath);
          vaultEngineCache.set(vaultPath, engine);
        }
        const query = String(params.query ?? "");
        return engine.search(query, {
          limit: Number(params.limit ?? 10),
          tags: params.tags ? (params.tags as string[]) : undefined,
        });
      }

      case "getNote": {
        const { DeterministicSearchEngine } = await import("../memory/deterministic-search.js");
        let engine = vaultEngineCache.get(vaultPath);
        if (!engine) {
          engine = new DeterministicSearchEngine(vaultPath);
          vaultEngineCache.set(vaultPath, engine);
        }
        const notePath = String(params.notePath ?? "");
        return engine.getNote(notePath);
      }

      case "browseByTag": {
        const { DeterministicSearchEngine } = await import("../memory/deterministic-search.js");
        let engine = vaultEngineCache.get(vaultPath);
        if (!engine) {
          engine = new DeterministicSearchEngine(vaultPath);
          vaultEngineCache.set(vaultPath, engine);
        }
        const tag = String(params.tag ?? "");
        return engine.browseByTag(tag);
      }

      case "browseByPara": {
        const { DeterministicSearchEngine } = await import("../memory/deterministic-search.js");
        let engine = vaultEngineCache.get(vaultPath);
        if (!engine) {
          engine = new DeterministicSearchEngine(vaultPath);
          vaultEngineCache.set(vaultPath, engine);
        }
        const category = String(params.category ?? "");
        return engine.browseByPara(category);
      }

      default:
        throw new Error(`Unknown Vault action: ${action}`);
    }
  });

  initialized = true;
  logger.info("[ReadOptimizerInit] All executors registered", {
    executors: ["codegraph", "pi-tools", "vault"],
  });
}

export function isReadOptimizerInitialized(): boolean {
  return initialized;
}
