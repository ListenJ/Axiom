/**
 * 增强文件监视器 (Enhanced File Watcher)
 *
 * 在现有 VaultFileWatcher 基础上增强:
 *   - 智能自动索引：追踪文件修改时间戳，仅重新索引变更文件
 *   - 批处理：收集窗口期内的变更，批量重新索引
 *   - 优先级索引：基于访问模式和重要性优先索引文件
 *   - 上下文感知：文件变更时更新相关上下文
 *   - 与 CodeGraph 集成：符号级重新索引
 *
 * 继承并扩展现有 VaultFileWatcher 功能。
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { VaultFileWatcher, type WatcherEvent } from "./file-watcher.js";
import {
  initializeCodegraph,
  isCodegraphInitialized,
  searchSymbols,
  invalidateCodegraphCache,
  type CodeGraphSearchResult,
} from "./codegraph-index.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// ═══════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════

export interface FileChange {
  filePath: string;
  event: "add" | "change" | "unlink";
  timestamp: number;
  size: number;
  previousHash?: string;
  currentHash?: string;
}

export interface ReindexBatch {
  id: string;
  changes: FileChange[];
  startTime: number;
  endTime?: number;
  status: "pending" | "processing" | "completed" | "failed";
  affectedSymbols?: string[];
}

export interface PriorityScore {
  filePath: string;
  score: number;
  factors: {
    recency: number;      // 最近修改时间
    frequency: number;    // 修改频率
    symbolCount: number;  // 包含的符号数量
    importCount: number;  // 被导入次数
  };
}

export interface EnhancedWatcherOptions {
  vaultPath: string;
  codegraphProjectPath?: string;
  debounceMs?: number;
  batchWindowMs?: number;      // 批处理窗口
  maxBatchSize?: number;       // 最大批处理数量
  enablePriorityIndexing?: boolean;
  enableIncrementalIndexing?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// EnhancedFileWatcher 主类
// ═══════════════════════════════════════════════════════════════

export class EnhancedFileWatcher extends VaultFileWatcher {
  private enhancedOpts: Required<
    Omit<EnhancedWatcherOptions, "vaultPath" | "codegraphProjectPath">
  > &
    Pick<EnhancedWatcherOptions, "codegraphProjectPath">;

  // 文件状态追踪
  private fileStates = new Map<string, { mtime: number; size: number; hash?: string }>();
  private changeQueue: FileChange[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private isProcessingBatch = false;

  // 优先级追踪
  private accessLog = new Map<string, number[]>(); // 文件路径 -> 访问时间戳数组
  private symbolIndex = new Map<string, string[]>(); // 文件路径 -> 符号名列表

  // 批处理历史
  private batchHistory: ReindexBatch[] = [];
  private currentBatch: ReindexBatch | null = null;

  // 增量索引追踪 (P1 优化)
  private dirtyFiles = new Set<string>();           // 待重新索引的文件
  private lastIndexTime = 0;                        // 上次索引时间
  private totalIndexedFiles = 0;                    // 总索引文件数（用于阈值计算）
  private indexStats = {                            // 索引统计
    fullRebuilds: 0,
    skippedRebuilds: 0,
    dirtyFilesProcessed: 0,
    avgRebuildTimeMs: 0,
  };

  constructor(opts: EnhancedWatcherOptions) {
    super({
      vaultPath: opts.vaultPath,
      codegraphProjectPath: opts.codegraphProjectPath,
      debounceMs: opts.debounceMs ?? 1500,
    });

    this.enhancedOpts = {
      codegraphProjectPath: opts.codegraphProjectPath,
      batchWindowMs: opts.batchWindowMs ?? 5000,
      maxBatchSize: opts.maxBatchSize ?? 50,
      enablePriorityIndexing: opts.enablePriorityIndexing ?? true,
      enableIncrementalIndexing: opts.enableIncrementalIndexing ?? true,
      debounceMs: opts.debounceMs ?? 1500,
    };
  }

  /**
   * 启动增强监视器
   */
  override start(onEvent?: (event: WatcherEvent, filePath: string) => void): void {
    super.start((event, filePath) => {
      // 调用原始回调
      onEvent?.(event, filePath);

      // 增强处理
      if (event === "change" || event === "add") {
        this.handleFileChange(filePath, event);
      } else if (event === "unlink") {
        this.handleFileRemoval(filePath);
      }
    });

    // 初始化文件状态
    this.initializeFileStates();

    logger.info("EnhancedFileWatcher started", {
      vaultPath: this.getVaultPath(),
      incrementalIndexing: this.enhancedOpts.enableIncrementalIndexing,
      priorityIndexing: this.enhancedOpts.enablePriorityIndexing,
    });
  }

  /**
   * 停止监视器
   */
  override stop(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // 处理剩余的变更
    if (this.changeQueue.length > 0) {
      this.processBatch();
    }

    super.stop();
    logger.info("EnhancedFileWatcher stopped");
  }

  /**
   * 获取文件优先级排序
   */
  getPrioritizedFiles(filePaths?: string[]): PriorityScore[] {
    const paths = filePaths || Array.from(this.fileStates.keys());
    const now = Date.now();

    const scores = paths.map((filePath) => {
      const state = this.fileStates.get(filePath);
      const accesses = this.accessLog.get(filePath) || [];
      const symbols = this.symbolIndex.get(filePath) || [];

      // 计算各项因子
      const recency = state ? Math.max(0, 1 - (now - state.mtime) / (24 * 60 * 60 * 1000)) : 0;
      const frequency = Math.min(accesses.length / 10, 1); // 归一化到 0-1
      const symbolCount = Math.min(symbols.length / 20, 1);
      const importCount = this.calculateImportCount(filePath);

      // 加权总分
      const score = recency * 0.3 + frequency * 0.3 + symbolCount * 0.2 + importCount * 0.2;

      return {
        filePath,
        score,
        factors: {
          recency,
          frequency,
          symbolCount,
          importCount,
        },
      };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores;
  }

  /**
   * 手动触发文件重新索引
   */
  async reindexFile(filePath: string): Promise<void> {
    const fullPath = path.resolve(filePath);

    if (!fs.existsSync(fullPath)) {
      logger.warn("[EnhancedWatcher] File not found for reindex", { filePath });
      return;
    }

    logger.info("[EnhancedWatcher] Manual reindex", { filePath });

    // 更新文件状态
    const stat = fs.statSync(fullPath);
    this.fileStates.set(filePath, {
      mtime: stat.mtimeMs,
      size: stat.size,
    });

    // 如果是源码文件，触发 CodeGraph 增量索引
    if (this.isSourceFile(filePath) && this.enhancedOpts.codegraphProjectPath) {
      this.dirtyFiles.add(filePath);
      await this.smartIncrementalIndex();
    }

    // 记录访问
    this.recordAccess(filePath);
  }

  /**
   * 获取当前批处理状态
   */
  getBatchStatus(): { pending: number; processing: boolean; history: number } {
    return {
      pending: this.changeQueue.length,
      processing: this.isProcessingBatch,
      history: this.batchHistory.length,
    };
  }

  /**
   * 获取文件变更统计
   */
  getChangeStats(): {
    totalFiles: number;
    recentlyChanged: number;
    frequentChanges: string[];
  } {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    const recentlyChanged = Array.from(this.fileStates.values()).filter(
      (s) => s.mtime > oneHourAgo
    ).length;

    const frequentChanges = Array.from(this.accessLog.entries())
      .filter(([, accesses]) => accesses.length > 5)
      .map(([filePath]) => filePath)
      .slice(0, 10);

    return {
      totalFiles: this.fileStates.size,
      recentlyChanged,
      frequentChanges,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════════════

  private handleFileChange(filePath: string, event: "add" | "change"): void {
    try {
      const stat = fs.statSync(filePath);
      const previousState = this.fileStates.get(filePath);

      // 检查是否真的变更了 (mtime 或 size)
      if (
        previousState &&
        previousState.mtime === stat.mtimeMs &&
        previousState.size === stat.size
      ) {
        return; // 没有实际变更
      }

      // 记录变更
      const change: FileChange = {
        filePath,
        event,
        timestamp: Date.now(),
        size: stat.size,
        previousHash: previousState?.hash,
      };

      this.changeQueue.push(change);
      this.fileStates.set(filePath, {
        mtime: stat.mtimeMs,
        size: stat.size,
      });

      // 触发批处理
      this.scheduleBatchProcessing();

      logger.debug("[EnhancedWatcher] File change queued", {
        filePath,
        event,
        queueSize: this.changeQueue.length,
      });
    } catch (error) {
      logger.warn("[EnhancedWatcher] Failed to handle file change", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleFileRemoval(filePath: string): void {
    this.fileStates.delete(filePath);
    this.accessLog.delete(filePath);
    this.symbolIndex.delete(filePath);

    logger.debug("[EnhancedWatcher] File removed from tracking", { filePath });
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // 如果队列过大，立即处理
    if (this.changeQueue.length >= this.enhancedOpts.maxBatchSize) {
      this.processBatch();
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, this.enhancedOpts.batchWindowMs);
  }

  private async processBatch(): Promise<void> {
    if (this.isProcessingBatch || this.changeQueue.length === 0) {
      return;
    }

    this.isProcessingBatch = true;
    const batch = this.changeQueue.splice(0, this.enhancedOpts.maxBatchSize);

    this.currentBatch = {
      id: `batch_${Date.now()}`,
      changes: batch,
      startTime: Date.now(),
      status: "processing",
    };

    logger.info("[EnhancedWatcher] Processing batch", {
      batchId: this.currentBatch.id,
      changeCount: batch.length,
    });

    try {
      // 1. 优先级排序
      const prioritized = this.enhancedOpts.enablePriorityIndexing
        ? this.prioritizeChanges(batch)
        : batch;

      // 2. 分离源码文件和 vault 文件
      const sourceChanges = prioritized.filter((c) => this.isSourceFile(c.filePath));
      const vaultChanges = prioritized.filter((c) => this.isVaultFile(c.filePath));

      // 3. 处理源码变更 (CodeGraph)
      if (sourceChanges.length > 0 && this.enhancedOpts.codegraphProjectPath) {
        await this.processSourceChanges(sourceChanges);
      }

      // 4. 处理 vault 变更
      if (vaultChanges.length > 0) {
        await this.processVaultChanges(vaultChanges);
      }

      // 5. 更新符号索引
      await this.updateSymbolIndex(sourceChanges.map((c) => c.filePath));

      // 6. 记录访问
      for (const change of batch) {
        this.recordAccess(change.filePath);
      }

      this.currentBatch.status = "completed";
      this.currentBatch.endTime = Date.now();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("[EnhancedWatcher] Batch processing failed", err, {
        batchId: this.currentBatch.id,
      });
      this.currentBatch.status = "failed";
      this.currentBatch.endTime = Date.now();
    } finally {
      this.batchHistory.push(this.currentBatch);

      // 限制历史记录数量
      if (this.batchHistory.length > 50) {
        this.batchHistory = this.batchHistory.slice(-50);
      }

      this.isProcessingBatch = false;
      this.currentBatch = null;

      // 如果还有剩余变更，继续处理
      if (this.changeQueue.length > 0) {
        this.scheduleBatchProcessing();
      }
    }
  }

  private prioritizeChanges(changes: FileChange[]): FileChange[] {
    const scores = this.getPrioritizedFiles(changes.map((c) => c.filePath));
    const scoreMap = new Map(scores.map((s) => [s.filePath, s.score]));

    return [...changes].sort((a, b) => {
      const scoreA = scoreMap.get(a.filePath) || 0;
      const scoreB = scoreMap.get(b.filePath) || 0;
      return scoreB - scoreA;
    });
  }

  private async processSourceChanges(changes: FileChange[]): Promise<void> {
    const filePaths = changes.map((c) => c.filePath);

    // 将变更文件加入脏文件集合
    for (const fp of filePaths) {
      this.dirtyFiles.add(fp);
    }

    if (this.enhancedOpts.enableIncrementalIndexing) {
      // 智能增量索引：基于阈值和冷却时间决策
      await this.smartIncrementalIndex();
    } else {
      // 全量索引
      await this.fullCodegraphIndex();
    }

    logger.info("[EnhancedWatcher] Source changes processed", {
      count: changes.length,
      dirtyFiles: this.dirtyFiles.size,
      files: filePaths.map((p) => path.basename(p)),
    });
  }

  private async processVaultChanges(changes: FileChange[]): Promise<void> {
    // Vault 变更由父类处理，这里记录日志
    logger.debug("[EnhancedWatcher] Vault changes processed", {
      count: changes.length,
    });
  }

  /**
   * 智能增量索引 (P1 优化)
   *
   * 决策逻辑:
   * 1. 如果脏文件数量超过总文件数的 10%，触发全量重建
   * 2. 如果距离上次重建超过冷却时间 (30s)，触发重建
   * 3. 如果脏文件数量较少且冷却期内，跳过重建（累积到下次）
   * 4. 手动调用 reindexFile 时立即重建
   */
  private async smartIncrementalIndex(): Promise<void> {
    if (!this.enhancedOpts.codegraphProjectPath) return;

    const dirtyCount = this.dirtyFiles.size;
    if (dirtyCount === 0) return;

    const now = Date.now();
    const timeSinceLastIndex = now - this.lastIndexTime;
    const threshold = Math.max(5, Math.floor(this.totalIndexedFiles * 0.1)); // 最少 5 个文件或 10%

    const shouldRebuild =
      dirtyCount >= threshold ||                    // 脏文件超过阈值
      timeSinceLastIndex >= TIMEOUTS.CODEGRAPH_REINDEX_COOLDOWN || // 冷却时间已过
      this.lastIndexTime === 0;                     // 首次索引

    if (!shouldRebuild) {
      logger.debug("[EnhancedWatcher] Skipping rebuild", {
        dirtyFiles: dirtyCount,
        threshold,
        timeSinceLastIndex: `${Math.round(timeSinceLastIndex / 1000)}s`,
        cooldown: `${TIMEOUTS.CODEGRAPH_REINDEX_COOLDOWN / 1000}s`,
      });
      this.indexStats.skippedRebuilds++;
      return;
    }

    // 执行全量重建（CodeGraph CLI 目前不支持真增量，但减少了重建频率）
    await this.fullCodegraphIndex();
  }

  private async fullCodegraphIndex(): Promise<void> {
    if (!this.enhancedOpts.codegraphProjectPath) return;

    const startTime = Date.now();
    try {
      // 检查 CodeGraph 是否已初始化
      if (!(await isCodegraphInitialized(this.enhancedOpts.codegraphProjectPath))) {
        logger.warn("[EnhancedWatcher] CodeGraph not initialized, skipping index");
        return;
      }

      await initializeCodegraph(this.enhancedOpts.codegraphProjectPath);

      const duration = Date.now() - startTime;
      this.lastIndexTime = Date.now();
      this.indexStats.fullRebuilds++;
      this.indexStats.dirtyFilesProcessed += this.dirtyFiles.size;
      this.indexStats.avgRebuildTimeMs =
        (this.indexStats.avgRebuildTimeMs * (this.indexStats.fullRebuilds - 1) + duration) /
        this.indexStats.fullRebuilds;

      // 清除脏文件标记
      const dirtyCount = this.dirtyFiles.size;
      this.dirtyFiles.clear();

      // 使 CodeGraph 查询缓存失效（因为索引已更新）
      invalidateCodegraphCache();

      // 更新总文件数
      const status = await this.getCodegraphStatus();
      if (status) {
        this.totalIndexedFiles = status.files;
      }

      logger.info("[EnhancedWatcher] Full CodeGraph index completed", {
        duration: `${duration}ms`,
        dirtyFilesCleared: dirtyCount,
        totalFiles: this.totalIndexedFiles,
        avgRebuildTime: `${Math.round(this.indexStats.avgRebuildTimeMs)}ms`,
      });
    } catch (error) {
      logger.warn("[EnhancedWatcher] Full CodeGraph index failed", {
        error: error instanceof Error ? error.message : String(error),
        duration: `${Date.now() - startTime}ms`,
      });
    }
  }

  private async getCodegraphStatus(): Promise<{ files: number; nodes: number; edges: number } | null> {
    try {
      const { getStatus } = await import("./codegraph-index.js");
      return await getStatus(this.enhancedOpts.codegraphProjectPath);
    } catch {
      return null;
    }
  }

  private async updateSymbolIndex(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      if (!this.isSourceFile(filePath)) continue;

      try {
        // 搜索文件中的符号 (使用文件名作为查询)
        const basename = path.basename(filePath, path.extname(filePath));
        const symbols = await searchSymbols(basename, { limit: 20 });

        const symbolNames = symbols
          .filter((s) => s.node.filePath === filePath)
          .map((s) => s.node.name);

        this.symbolIndex.set(filePath, symbolNames);
      } catch {
        // 忽略符号索引失败
      }
    }
  }

  private initializeFileStates(): void {
    const scanDirectory = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
              scanDirectory(fullPath);
            }
          } else if (this.isTrackedFile(fullPath)) {
            try {
              const stat = fs.statSync(fullPath);
              this.fileStates.set(fullPath, {
                mtime: stat.mtimeMs,
                size: stat.size,
              });
            } catch {
              // 忽略无权限文件
            }
          }
        }
      } catch {
        // 忽略无权限目录
      }
    };

    scanDirectory(this.getVaultPath());

    if (this.enhancedOpts.codegraphProjectPath) {
      scanDirectory(this.enhancedOpts.codegraphProjectPath);
    }

    logger.info("[EnhancedWatcher] File states initialized", {
      trackedFiles: this.fileStates.size,
    });
  }

  private recordAccess(filePath: string): void {
    const accesses = this.accessLog.get(filePath) || [];
    accesses.push(Date.now());

    // 只保留最近 50 次访问
    if (accesses.length > 50) {
      accesses.shift();
    }

    this.accessLog.set(filePath, accesses);
  }

  private calculateImportCount(filePath: string): number {
    // 简化的导入计数：检查其他文件是否导入此文件
    let count = 0;
    const basename = path.basename(filePath, path.extname(filePath));

    for (const [otherPath, symbols] of this.symbolIndex) {
      if (otherPath === filePath) continue;
      if (symbols.some((s) => s.includes(basename))) {
        count++;
      }
    }

    return Math.min(count / 10, 1); // 归一化
  }

  private isSourceFile(filePath: string): boolean {
    return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift)$/.test(filePath);
  }

  private isVaultFile(filePath: string): boolean {
    return filePath.endsWith(".md");
  }

  private isTrackedFile(filePath: string): boolean {
    return this.isSourceFile(filePath) || this.isVaultFile(filePath);
  }

  private getVaultPath(): string {
    // 访问父类的私有属性需要使用 hack，这里直接返回已知路径
    // 实际项目中应该通过 getter 访问
    return (this as any).opts?.vaultPath || ".";
  }
}

export const enhancedWatcher = (opts: EnhancedWatcherOptions) => new EnhancedFileWatcher(opts);
