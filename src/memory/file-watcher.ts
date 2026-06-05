/**
 * Vault 文件监视器
 *
 * 监视 Obsidian Vault 文件变更，自动刷新确定性搜索引擎索引。
 * 确保所有 Agent 始终看到最新的 Vault 状态。
 *
 * 事件类型：
 *   - add      — 新笔记创建
 *   - change   — 笔记内容修改
 *   - unlink   — 笔记删除
 *   - ready    — 初始扫描完成
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { DeterministicSearchEngine } from "./deterministic-search.js";
import { initializeCodegraph } from "./codegraph-index.js";
import { TIMEOUTS } from "../constants/timeouts.js";

interface WatcherOptions {
  vaultPath: string;
  /** 项目源码路径，用于 CodeGraph 自动重索引 */
  codegraphProjectPath?: string;
  debounceMs?: number;
  ignored?: RegExp;
}

export type WatcherEvent = "add" | "change" | "unlink" | "ready";

export class VaultFileWatcher {
  private opts: Required<Omit<WatcherOptions, "codegraphProjectPath">> & Pick<WatcherOptions, "codegraphProjectPath">;
  private engine: DeterministicSearchEngine;
  private watchers = new Map<string, fs.FSWatcher>();
  private pendingReload = false;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private isReady = false;
  private onEvent?: (event: WatcherEvent, filePath: string) => void;
  // CodeGraph 状态
  private cgTimer: ReturnType<typeof setTimeout> | null = null;
  private cgPending = false;
  private cgIndexing = false;
  private cgWatcherCount = 0;

  constructor(opts: WatcherOptions) {
    this.opts = {
      vaultPath: opts.vaultPath,
      codegraphProjectPath: opts.codegraphProjectPath,
      debounceMs: opts.debounceMs ?? 1500,
      ignored: opts.ignored ?? /(^|[\/\\])\.|~$|\.tmp$|\.swp$|\.bak$/,
    };
    this.engine = new DeterministicSearchEngine(this.opts.vaultPath);
  }

  /** 获取当前搜索引擎实例 */
  getEngine(): DeterministicSearchEngine {
    return this.engine;
  }

  /** 启动监视 */
  start(onEvent?: (event: WatcherEvent, filePath: string) => void): void {
    this.onEvent = onEvent;
    logger.info("VaultFileWatcher starting", { vaultPath: this.opts.vaultPath });

    this.watchDirectory(this.opts.vaultPath);

    // 启动 CodeGraph 源码监视
    if (this.opts.codegraphProjectPath) {
      this.watchCodegraphDirectory(this.opts.codegraphProjectPath);
      logger.info("CodeGraph watcher starting", { path: this.opts.codegraphProjectPath });
    }

    this.isReady = true;
    this.onEvent?.("ready", this.opts.vaultPath);
    logger.info("VaultFileWatcher ready", {
      vaultDirs: this.watchers.size,
      codegraphEnabled: !!this.opts.codegraphProjectPath,
    });
  }

  /** 停止所有监视 */
  stop(): void {
    for (const [dir, watcher] of this.watchers) {
      watcher.close();
      logger.debug("Stopped watching", { dir });
    }
    this.watchers.clear();
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.cgTimer) {
      clearTimeout(this.cgTimer);
      this.cgTimer = null;
    }
    this.isReady = false;
  }

  private watchDirectory(dirPath: string): void {
    if (this.watchers.has(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        if (this.opts.ignored.test(filename)) return;

        const fullPath = path.join(dirPath, filename);

        // 检查是否是目录
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            if (eventType === "rename" && fs.existsSync(fullPath)) {
              this.watchDirectory(fullPath);
            }
            return;
          }
        } catch {
          // 文件可能已被删除
        }

        // 只关注 .md 文件
        if (!filename.endsWith(".md")) return;

        if (eventType === "rename") {
          if (fs.existsSync(fullPath)) {
            this.handleEvent("add", fullPath);
          } else {
            this.handleEvent("unlink", fullPath);
          }
        } else {
          this.handleEvent("change", fullPath);
        }
      });

      this.watchers.set(dirPath, watcher);

      // 递归监视子目录
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !this.opts.ignored.test(entry.name)) {
            this.watchDirectory(path.join(dirPath, entry.name));
          }
        }
      } catch {
        // 忽略无权限目录
      }
    } catch (e) {
      logger.warn("Failed to watch directory", { dir: dirPath, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 监视项目源码目录，触发 CodeGraph 重索引 */
  private watchCodegraphDirectory(dirPath: string): void {
    if (this.watchers.has(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // 只关注源码文件
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filename)) return;
        // 忽略 node_modules 和 dist
        if (filename.includes("node_modules") || filename.includes("dist") || filename.includes(".git")) return;

        this.triggerCodegraphReload();
      });

      this.watchers.set(dirPath, watcher);
      this.cgWatcherCount++;
    } catch (e) {
      logger.warn("Failed to watch CodeGraph directory", { dir: dirPath, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 防抖触发 CodeGraph 重索引（30s debounce） */
  private triggerCodegraphReload(): void {
    if (this.cgIndexing) {
      this.cgPending = true;
      return;
    }
    if (this.cgTimer) clearTimeout(this.cgTimer);
    this.cgPending = true;
    this.cgTimer = setTimeout(() => {
      this.cgPending = false;
      this.runCodegraphIndex();
    }, TIMEOUTS.FILE_WATCHER_DEBOUNCE); // 30s debounce，全量索引较慢
  }

  private async runCodegraphIndex(): Promise<void> {
    if (this.cgIndexing || !this.opts.codegraphProjectPath) return;
    this.cgIndexing = true;
    logger.info("[CodeGraph] Auto-reindexing started", { path: this.opts.codegraphProjectPath });
    try {
      await initializeCodegraph(this.opts.codegraphProjectPath);
      logger.info("[CodeGraph] Auto-reindexing completed");
    } catch (e) {
      logger.warn("[CodeGraph] Auto-reindexing failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.cgIndexing = false;
      // 如果期间又有变更，继续触发
      if (this.cgPending) {
        this.cgPending = false;
        this.triggerCodegraphReload();
      }
    }
  }

  private handleEvent(event: WatcherEvent, filePath: string): void {
    const relPath = path.relative(this.opts.vaultPath, filePath);
    logger.debug("Vault file changed", { event, path: relPath });
    this.onEvent?.(event, relPath);

    // 防抖刷新索引
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.pendingReload = true;
    this.reloadTimer = setTimeout(() => {
      this.pendingReload = false;
      if (this.engine) {
        this.engine.reload(this.opts.vaultPath);
        logger.info("Vault index auto-reloaded", { triggeredBy: event, path: relPath });
      }
    }, this.opts.debounceMs);
  }

  get isWatching(): boolean {
    return this.isReady && this.watchers.size > 0;
  }

  get watchedCount(): number {
    return this.watchers.size;
  }
}
