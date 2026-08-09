import {
  RateDistortionCompressor,
  type ContextItem,
} from "../context/rate-distortion-compressor.js";
import { estimateTokens as defaultEstimateTokens } from "../context/token-estimator.js";
import type {
  ComponentBudget,
  ComponentHealth,
  ComponentLifecycle,
  ComponentMessage,
  CompressedMessages,
  TokenBudgetContract,
  TokenBudgetReport,
} from "./contracts.js";

export interface TokenBudgetOptions {
  estimator?: (text: string) => number;
  defaultMaxTokens?: number;
  preserveRecent?: number;
}

interface ScoredMessage {
  message: ComponentMessage;
  score: number;
}

export class TokenBudget implements TokenBudgetContract, ComponentLifecycle {
  readonly kind = "context" as const;
  readonly version = "1.0.0";
  readonly id = "token-budget";
  readonly dependencies: string[] = [];

  private estimator: (text: string) => number;
  private defaultMaxTokens: number;
  private defaultPreserveRecent: number;
  private lastReport: TokenBudgetReport = {
    originalTokens: 0,
    compressedTokens: 0,
    rate: 0,
    mode: "none",
    itemCount: 0,
    dropped: 0,
    truncated: 0,
    preservedRecent: 0,
  };

  constructor(options: TokenBudgetOptions = {}) {
    this.estimator = options.estimator ?? defaultEstimateTokens;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 128_000;
    this.defaultPreserveRecent = options.preserveRecent ?? 4;
  }

  estimate(text: string): number {
    return this.estimator(text);
  }

  estimateMessages(messages: ComponentMessage[]): number {
    return messages.reduce(
      (sum, message) => sum + 4 + this.estimate(message.content),
      0,
    );
  }

  trimMessage(
    message: ComponentMessage,
    maxTokens: number,
  ): ComponentMessage {
    const available = Math.max(0, maxTokens - 4);
    if (available === 0) return { ...message, content: "" };
    if (this.estimate(message.content) <= available) return message;
    return {
      ...message,
      content: this.fitContent(message.content, available),
    };
  }

  async compress(
    messages: ComponentMessage[],
    budget: number | ComponentBudget,
    options: { preserveRecent?: number; maxItems?: number } = {},
  ): Promise<CompressedMessages> {
    const maxTokens =
      typeof budget === "number"
        ? budget
        : budget.maxTokens ?? this.defaultMaxTokens;
    const preserveRecent =
      typeof budget === "number"
        ? options.preserveRecent ?? this.defaultPreserveRecent
        : budget.preserveRecent ??
          options.preserveRecent ??
          this.defaultPreserveRecent;
    const originalTokens = this.estimateMessages(messages);
    const baseReport = {
      originalTokens,
      compressedTokens: originalTokens,
      rate: originalTokens > 0 ? 1 : 0,
      mode: "none" as const,
      itemCount: messages.length,
      dropped: 0,
      truncated: 0,
      preservedRecent: 0,
    };

    if (messages.length === 0 || originalTokens <= maxTokens) {
      this.lastReport = baseReport;
      return {
        messages: [...messages],
        ...baseReport,
      };
    }

    const recentCount = Math.min(preserveRecent, messages.length);
    const recent = messages.slice(-recentCount);
    const older = messages.slice(0, -recentCount);
    let working = [...older];
    let dropped = 0;
    let truncated = 0;
    let mode: TokenBudgetReport["mode"] = "trim";

    if (older.length >= 2 && options.maxItems !== 0) {
      const items = older.map((message, index) =>
        this.toContextItem(message, index),
      );
      if (items.length <= (options.maxItems ?? 200)) {
        const compressor = new RateDistortionCompressor({
          maxDistortion: 0.25,
          minRate: 0.2,
        });
        const compressedItems = await compressor.compress(items);
        const before = this.estimateMessages(older);
        const after = this.estimateMessages(
          compressedItems.items.map((item) => ({
            role: this.itemRole(item),
            content: item.content,
          })),
        );
        if (after < before) {
          working = compressedItems.items.map((item) => ({
            role: this.itemRole(item),
            content: item.content,
          }));
          dropped += older.length - working.length;
          mode = "compress";
        }
      }
    }

    const recentTokens = this.estimateMessages(recent);
    const olderTarget = maxTokens - recentTokens;

    if (olderTarget >= 0) {
      const result = this.dropOrTrimOlder(working, olderTarget);
      dropped += result.dropped;
      truncated += result.truncated;
      working = result.messages;
      if (result.dropped > 0 && mode === "trim") mode = "drop";
      if (result.truncated > 0) mode = mode === "compress" ? "mixed" : "trim";
    } else {
      dropped += working.length;
      working = [];
    }

    let current = [...working, ...recent];
    let currentTokens = this.estimateMessages(current);
    if (currentTokens > maxTokens) {
      const recentResult = this.trimRecent(current, working.length, maxTokens);
      truncated += recentResult.truncated;
      dropped += recentResult.dropped;
      current = recentResult.messages;
      currentTokens = this.estimateMessages(current);
      mode = mode === "compress" ? "mixed" : "trim";
    }

    const compressedTokens = currentTokens;
    const report: TokenBudgetReport = {
      originalTokens,
      compressedTokens,
      rate: originalTokens > 0 ? compressedTokens / originalTokens : 0,
      mode,
      itemCount: messages.length,
      dropped,
      truncated,
      preservedRecent: recentCount,
    };
    this.lastReport = report;

    return {
      messages: current,
      ...report,
    };
  }

  report(): TokenBudgetReport {
    return { ...this.lastReport };
  }

  async init(): Promise<void> {}

  async health(): Promise<ComponentHealth> {
    return {
      id: this.id,
      ready: true,
      optional: false,
      metrics: {
        mode: this.lastReport.mode,
        rate: this.lastReport.rate,
      },
    };
  }

  async dispose(): Promise<void> {}

  private fitContent(text: string, maxTokens: number): string {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.estimate(text.slice(0, mid + 1)) <= maxTokens) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return text.slice(0, low);
  }

  private toContextItem(
    message: ComponentMessage,
    index: number,
  ): ContextItem {
    return {
      id: `msg:${index}`,
      content: message.content,
      relevance: this.relevance(message),
      tokens: this.estimate(message.content),
      metadata: { role: message.role },
    };
  }

  private itemRole(item: ContextItem): ComponentMessage["role"] {
    const role = item.metadata?.role;
    return role === "user" || role === "assistant" ? role : "system";
  }

  private relevance(message: ComponentMessage): number {
    const base =
      message.role === "system"
        ? 0.9
        : message.role === "assistant"
          ? 0.5
          : 0.7;
    const lower = message.content.toLowerCase();
    let score = base;
    if (/important|critical|decision|final|constraint/i.test(lower)) score += 0.15;
    if (/```|function|class|interface|import/i.test(lower)) score += 0.1;
    if (message.content.length > 600) score -= 0.2;
    return Math.max(0, Math.min(1, score));
  }

  private dropOrTrimOlder(
    messages: ComponentMessage[],
    targetTokens: number,
  ): { messages: ComponentMessage[]; dropped: number; truncated: number } {
    if (targetTokens <= 0) {
      return { messages: [], dropped: messages.length, truncated: 0 };
    }

    const scored: ScoredMessage[] = messages.map((message, index) => ({
      message,
      score: this.relevance(message) - index * 1e-9,
    }));
    scored.sort((a, b) => a.score - b.score);

    const selected = new Set<number>();
    let selectedTokens = 0;
    for (const item of scored) {
      const itemTokens = this.estimateMessages([item.message]);
      if (
        selected.size === 0 ||
        selectedTokens + itemTokens <= targetTokens
      ) {
        const originalIndex = messages.indexOf(item.message);
        selected.add(originalIndex);
        selectedTokens += itemTokens;
      }
    }

    let kept = messages.filter((_, index) => selected.has(index));
    let dropped = messages.length - kept.length;
    let truncated = 0;
    let keptTokens = this.estimateMessages(kept);

    if (keptTokens > targetTokens) {
      const ordered = [...kept]
        .map((message, index) => ({ message, score: this.relevance(message) - index * 1e-9 }))
        .sort((a, b) => a.score - b.score);
      for (const item of ordered) {
        if (keptTokens <= targetTokens) break;
        const itemTokens = this.estimateMessages([item.message]);
        const room = targetTokens - (keptTokens - itemTokens);
        if (room <= 0) {
          kept = kept.filter((message) => message !== item.message);
          keptTokens -= itemTokens;
          dropped += 1;
        } else {
          const trimmed = this.trimMessage(item.message, room);
          const newTokens = this.estimateMessages([trimmed]);
          kept = kept.map((message) =>
            message === item.message ? trimmed : message,
          );
          keptTokens += newTokens - itemTokens;
          truncated += 1;
        }
      }
    }

    return { messages: kept, dropped, truncated };
  }

  private trimRecent(
    messages: ComponentMessage[],
    olderCount: number,
    maxTokens: number,
  ): { messages: ComponentMessage[]; dropped: number; truncated: number } {
    let current = [...messages];
    let currentTokens = this.estimateMessages(current);
    let dropped = 0;
    let truncated = 0;

    for (let i = olderCount; i < current.length && currentTokens > maxTokens; i++) {
      const message = current[i]!;
      const itemTokens = this.estimateMessages([message]);
      const otherTokens = currentTokens - itemTokens;
      const room = maxTokens - otherTokens;

      if (room <= 0 && current.length > olderCount + 1) {
        current = current.filter((candidate) => candidate !== message);
        currentTokens -= itemTokens;
        dropped += 1;
      } else if (room > 0) {
        const trimmed = this.trimMessage(message, room);
        const newTokens = this.estimateMessages([trimmed]);
        current = current.map((candidate) =>
          candidate === message ? trimmed : candidate,
        );
        currentTokens += newTokens - itemTokens;
        truncated += 1;
      }
    }

    return { messages: current, dropped, truncated };
  }
}

export const tokenBudget = new TokenBudget();
