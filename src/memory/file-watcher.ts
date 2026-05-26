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

interface WatcherOptions {
  vaultPath: string;
  debounceMs?: number;
  ignored?: RegExp;
}

type WatcherEvent = "add" | "change" | "unlink" | "ready";

export class VaultFileWatcher {
  private opts: Required<WatcherOptions>;
  private engine: DeterministicSearchEngine;
  private watchers = new Map<string, fs.FSWatcher>();
  private pendingReload = false;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private isReady = false;
  private onEvent?: (event: WatcherEvent, filePath: string) => void;

  constructor(opts: WatcherOptions) {
    this.opts = {
      vaultPath: opts.vaultPath,
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
    this.isReady = true;
    this.onEvent?.("ready", this.opts.vaultPath);
    logger.info("VaultFileWatcher ready");
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
          // rename 事件在添加和删除时都会触发
          if (fs.existsSync(fullPath)) {
            this.handleEvent("add", fullPath);
          } else {
            this.handleEvent("unlink", fullPath);
          }
        } else {
          // change 事件
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
    } catch (e: any) {
      logger.warn("Failed to watch directory", { dir: dirPath, error: e.message });
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
