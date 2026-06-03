/**
 * 自动知识桥接器
 * 拦截 Agent 输入输出，自动检测知识缺口并触发搜索
 */

import { gapDetector } from "./knowledge-gap-detector.js";
import { DataPipeline } from "../crawl/data-pipeline.js";
import { VaultManager } from "../memory/vault-manager.js";
import { logger } from "../utils/logger.js";

export interface BridgeContext {
  originalInput: string;
  detectedGap: boolean;
  searchQuery?: string;
  searchResults?: Array<{ title: string; link: string; snippet: string }>;
  savedToVault?: boolean;
  vaultPath?: string;
  enrichedContext?: string;
}

/** 会话频率控制 */
const sessionSearchCount = new Map<string, number>();
const MAX_SEARCHES_PER_SESSION = 3;

export class AutoKnowledgeBridge {
  private pipeline = new DataPipeline();

  /**
   * 拦截用户输入，检测是否需要搜索
   */
  async interceptInput(userInput: string, sessionId: string): Promise<BridgeContext> {
    const context: BridgeContext = {
      originalInput: userInput,
      detectedGap: false,
    };

    // 频率控制
    const count = sessionSearchCount.get(sessionId) || 0;
    if (count >= MAX_SEARCHES_PER_SESSION) {
      logger.debug("[AutoBridge] 会话搜索次数已达上限", { sessionId, count });
      return context;
    }

    // 检测知识缺口
    const detection = await gapDetector.detect(userInput);
    if (!detection.hasGap || detection.confidence < 0.5) {
      return context;
    }

    context.detectedGap = true;
    context.searchQuery = detection.suggestedQueries[0];

    // 执行搜索
    try {
      const results = await this.executePrivacySearch(context.searchQuery!);
      context.searchResults = results;

      // 保存到 Vault
      const vault = new VaultManager();
      const vaultPath = await vault.writeSearchResult(
        context.searchQuery!,
        ["duckduckgo"],
        results
      );
      context.savedToVault = true;
      context.vaultPath = vaultPath;

      // 构建增强上下文
      context.enrichedContext = this.buildEnrichedContext(results);

      // 更新频率计数
      sessionSearchCount.set(sessionId, count + 1);

      logger.info("[AutoBridge] 自动搜索完成", {
        query: context.searchQuery,
        results: results.length,
        vaultPath,
      });
    } catch (error) {
      logger.warn("[AutoBridge] 自动搜索失败", { error: (error as Error).message });
    }

    return context;
  }

  /**
   * 拦截模型输出，检测是否需要补充
   */
  async interceptOutput(
    agentResponse: string,
    sessionId: string,
    originalInput: string
  ): Promise<BridgeContext> {
    const context: BridgeContext = {
      originalInput: originalInput,
      detectedGap: false,
    };

    // 检测模型输出中的不确定性
    const detection = await gapDetector.detect(originalInput, agentResponse);
    if (!detection.hasGap) {
      return context;
    }

    context.detectedGap = true;
    context.searchQuery = detection.suggestedQueries[0];

    // 执行搜索并保存
    try {
      const results = await this.executePrivacySearch(context.searchQuery!);
      context.searchResults = results;

      const vault = new VaultManager();
      const vaultPath = await vault.writeSearchResult(
        context.searchQuery!,
        ["duckduckgo"],
        results
      );
      context.savedToVault = true;
      context.vaultPath = vaultPath;

      logger.info("[AutoBridge] 输出补充搜索完成", {
        query: context.searchQuery,
        results: results.length,
      });
    } catch (error) {
      logger.warn("[AutoBridge] 输出补充搜索失败", { error: (error as Error).message });
    }

    return context;
  }

  /**
   * 隐私保护搜索
   */
  private async executePrivacySearch(query: string): Promise<Array<{ title: string; link: string; snippet: string }>> {
    // 使用 DataPipeline 的搜索（已集成隐私保护）
    const results = await this.pipeline.searchMulti(query, {
      num: 5,
      engines: ["duckduckgo"],
    });

    return results.map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    }));
  }

  /**
   * 构建增强上下文
   */
  private buildEnrichedContext(results: Array<{ title: string; link: string; snippet: string }>): string {
    const lines = results.map((r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.snippet.slice(0, 200)}`
    );
    return `## 相关搜索结果\n\n${lines.join("\n\n")}`;
  }

  /** 重置会话计数 */
  resetSession(sessionId: string): void {
    sessionSearchCount.delete(sessionId);
  }
}

export const autoBridge = new AutoKnowledgeBridge();
