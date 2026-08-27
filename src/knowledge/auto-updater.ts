/**
 * 知识库自动更新与维护机制
 *
 * 功能:
 * - 定时触发知识收集任务 (可配置间隔)
 * - 多域名并行收集 (mathematics, computer-science, philosophy)
 * - 质量阈值过滤 + 去重
 * - 收集统计报告
 * - 可通过 CLI 或 API 启动/停止
 */

import { logger } from "../utils/logger.js";
import { collectKnowledge } from "./collector.js";
import { getKnowledgeStore } from "./store.js";
import { getSubdomainsForDomain } from "./searcher.js";

export interface UpdaterConfig {
  /** 更新间隔 (毫秒), 默认 24h */
  intervalMs: number;
  /** 要收集的域名列表 */
  domains: string[];
  /** 每个子域最大源数 */
  maxSourcesPerSubdomain: number;
  /** 质量阈值 */
  qualityThreshold: number;
  /** 是否在启动时立即执行一次 */
  runOnStart: boolean;
}

export interface UpdateReport {
  timestamp: number;
  durationMs: number;
  domain: string;
  subdomain: string;
  searched: number;
  collected: number;
  skipped: number;
  failed: number;
  errors: string[];
}

const DEFAULT_CONFIG: UpdaterConfig = {
  intervalMs: 24 * 60 * 60 * 1000, // 24 hours
  domains: ["mathematics", "computer-science", "philosophy"],
  maxSourcesPerSubdomain: 3,
  qualityThreshold: 0.3,
  runOnStart: false,
};

export class KnowledgeAutoUpdater {
  private config: UpdaterConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastReport: UpdateReport | null = null;
  private reports: UpdateReport[] = [];
  private readonly maxReports = 100;

  constructor(config?: Partial<UpdaterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启动自动更新定时器
   */
  start(): void {
    if (this.timer) {
      logger.warn("[KnowledgeUpdater] Already running");
      return;
    }

    logger.info("[KnowledgeUpdater] Started", {
      intervalMs: this.config.intervalMs,
      domains: this.config.domains,
    });

    if (this.config.runOnStart) {
      this.runUpdate().catch((err) => {
        logger.error("[KnowledgeUpdater] Initial run failed", err instanceof Error ? err : new Error(String(err)));
      });
    }

    this.timer = setInterval(() => {
      this.runUpdate().catch((err) => {
        logger.error("[KnowledgeUpdater] Scheduled run failed", err instanceof Error ? err : new Error(String(err)));
      });
    }, this.config.intervalMs);
  }

  /**
   * 停止自动更新
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("[KnowledgeUpdater] Stopped");
    }
  }

  /**
   * 手动触发一次更新 (不依赖定时器)
   */
  async runUpdate(): Promise<UpdateReport[]> {
    if (this.running) {
      logger.warn("[KnowledgeUpdater] Update already in progress, skipping");
      return [];
    }

    this.running = true;
    const allReports: UpdateReport[] = [];

    try {
      for (const domain of this.config.domains) {
        const subdomains = getSubdomainsForDomain(domain);
        for (const subdomain of subdomains) {
          const report = await this.collectOne(domain, subdomain);
          allReports.push(report);
          this.recordReport(report);
        }
      }

      const totalCollected = allReports.reduce((sum, r) => sum + r.collected, 0);
      const totalFailed = allReports.reduce((sum, r) => sum + r.failed, 0);
      logger.info("[KnowledgeUpdater] Update complete", {
        domains: this.config.domains.length,
        totalCollected,
        totalFailed,
        reports: allReports.length,
      });
    } finally {
      this.running = false;
    }

    return allReports;
  }

  /**
   * 收集单个域/子域
   */
  private async collectOne(domain: string, subdomain: string): Promise<UpdateReport> {
    const start = Date.now();
    const errors: string[] = [];

    try {
      const result = await collectKnowledge({
        domain,
        subdomain,
        maxSources: this.config.maxSourcesPerSubdomain,
        qualityThreshold: this.config.qualityThreshold,
        force: false, // respect deduplication
      });

      const report: UpdateReport = {
        timestamp: start,
        durationMs: Date.now() - start,
        domain,
        subdomain,
        searched: result.searched,
        collected: result.collected,
        skipped: result.skipped,
        failed: result.failed,
        errors,
      };

      logger.info("[KnowledgeUpdater] Collection done", {
        domain,
        subdomain,
        collected: report.collected,
        skipped: report.skipped,
        durationMs: report.durationMs,
      });

      return report;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push(errorMsg);
      logger.warn("[KnowledgeUpdater] Collection failed", { domain, subdomain, error: errorMsg });

      return {
        timestamp: start,
        durationMs: Date.now() - start,
        domain,
        subdomain,
        searched: 0,
        collected: 0,
        skipped: 0,
        failed: 1,
        errors,
      };
    }
  }

  private recordReport(report: UpdateReport): void {
    this.lastReport = report;
    this.reports.push(report);
    if (this.reports.length > this.maxReports) {
      this.reports.shift();
    }
  }

  /**
   * 获取上次更新报告
   */
  getLastReport(): UpdateReport | null {
    return this.lastReport;
  }

  /**
   * 获取历史报告
   */
  getReports(): UpdateReport[] {
    return [...this.reports];
  }

  /**
   * 获取知识库统计
   */
  getStats(): {
    totalSources: number;
    byDomain: Record<string, number>;
    totalDictionary: number;
    isRunning: boolean;
    lastUpdate: UpdateReport | null;
  } {
    const store = getKnowledgeStore();
    const stats = store.stats();
    return {
      ...stats,
      isRunning: this.running,
      lastUpdate: this.lastReport,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<UpdaterConfig>): void {
    const wasRunning = this.timer !== null;
    if (wasRunning) this.stop();
    this.config = { ...this.config, ...config };
    if (wasRunning) this.start();
    logger.info("[KnowledgeUpdater] Config updated", { ...this.config });
  }
}

// 全局单例
let _updater: KnowledgeAutoUpdater | null = null;

export function getKnowledgeUpdater(config?: Partial<UpdaterConfig>): KnowledgeAutoUpdater {
  if (!_updater) {
    _updater = new KnowledgeAutoUpdater(config);
  }
  return _updater;
}
