/**
 * 知识缺口检测器
 * 检测用户查询中是否需要补充网络知识
 */

import { logger } from "../utils/logger.js";

export interface GapDetectionResult {
  hasGap: boolean;
  confidence: number;
  reason: string;
  suggestedQueries: string[];
  strategy: "search" | "knowledge_base" | "none";
}

export interface AutoSearchResult {
  query: string;
  results: Array<{ title: string; link: string; snippet: string }>;
  savedToVault: boolean;
  vaultPath?: string;
}

/** 脱敏模式 */
const SENSITIVE_PATTERNS = [
  { regex: /\b(?:sk-|ak-|pk-)[a-zA-Z0-9]{20,}\b/g, replacement: "[API_KEY]" },
  { regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: "[IP]" },
  { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL]" },
  { regex: /\/(?:home|Users|usr)\/[a-zA-Z0-9_]+/g, replacement: "[PATH]" },
];

export class KnowledgeGapDetector {
  /**
   * 检测输入中是否存在知识缺口
   */
  async detect(input: string, response?: string): Promise<GapDetectionResult> {
    const lower = input.toLowerCase();
    let hasGap = false;
    let confidence = 0;
    const reasons: string[] = [];
    const suggestedQueries: string[] = [];

    // 策略0: 排除常见闲聊/问候语（避免误判）
    const casualGreetings = [
      "你好", "您好", "嗨", "hello", "hi", "hey",
      "今天天气", "吃了吗", "在吗", "有空吗",
    ];
    const isCasual = casualGreetings.some(g => lower.includes(g));
    // 如果输入很短（<15字）且包含问候语，视为闲聊
    if (isCasual && input.length < 15) {
      return {
        hasGap: false,
        confidence: 0,
        reason: "检测到问候语，视为闲聊",
        suggestedQueries: [],
        strategy: "none",
      };
    }

    // 策略1: 显式搜索请求
    const searchTriggers = [
      "搜索", "查找", "查询", "调研", "了解", "什么是", "怎么样",
      "search", "find", "look up", "research", "what is", "how to",
    ];
    for (const trigger of searchTriggers) {
      if (lower.includes(trigger)) {
        hasGap = true;
        confidence = Math.max(confidence, 0.7);
        reasons.push(`检测到搜索触发词: "${trigger}"`);
        suggestedQueries.push(input);
        break;
      }
    }

    // 策略2: 时效性需求
    const timeTriggers = ["最新", "最近", "2025", "2026", "新特性", "新版本", "latest", "recent"];
    for (const trigger of timeTriggers) {
      if (lower.includes(trigger)) {
        hasGap = true;
        confidence = Math.max(confidence, 0.8);
        reasons.push(`检测到时效性需求: "${trigger}"`);
        suggestedQueries.push(`${input} 最新`);
        break;
      }
    }

    // 策略3: 不确定性信号
    const uncertaintySignals = [
      "不知道", "不确定", "可能", "也许", "不清楚", "不了解",
      "don't know", "not sure", "maybe", "unclear",
    ];
    if (response) {
      const respLower = response.toLowerCase();
      for (const signal of uncertaintySignals) {
        if (respLower.includes(signal)) {
          hasGap = true;
          confidence = Math.max(confidence, 0.6);
          reasons.push(`模型输出含不确定性信号: "${signal}"`);
          suggestedQueries.push(input);
          break;
        }
      }
    }

    // 策略4: 技术术语密度高（可能需要补充知识）
    const techTerms = [
      "framework", "library", "api", "protocol", "algorithm",
      "架构", "框架", "协议", "算法", "模型", "引擎",
    ];
    let techCount = 0;
    for (const term of techTerms) {
      if (lower.includes(term)) techCount++;
    }
    if (techCount >= 3) {
      hasGap = true;
      confidence = Math.max(confidence, 0.5);
      reasons.push(`高技术术语密度 (${techCount}个)`);
    }

    return {
      hasGap,
      confidence,
      reason: reasons.join("; ") || "未检测到知识缺口",
      suggestedQueries: [...new Set(suggestedQueries)],
      strategy: hasGap ? "search" : "none",
    };
  }

  /**
   * 自动填充知识缺口
   */
  async autoFill(input: string, response?: string): Promise<AutoSearchResult | null> {
    const detection = await this.detect(input, response);
    if (!detection.hasGap || detection.confidence < 0.5) {
      return null;
    }

    const query = detection.suggestedQueries[0] || input;
    const sanitized = this.sanitizeQuery(query);
    const expanded = this.expandQuery(sanitized);

    return {
      query: expanded[0],
      results: [],
      savedToVault: false,
    };
  }

  /** 查询脱敏 */
  private sanitizeQuery(query: string): string {
    let result = query;
    for (const pattern of SENSITIVE_PATTERNS) {
      result = result.replace(pattern.regex, pattern.replacement);
    }
    return result;
  }

  /** 查询扩展 */
  private expandQuery(query: string): string[] {
    const expansions = [query];
    
    // 添加技术上下文
    if (/\b(?:react|vue|angular|svelte)\b/i.test(query)) {
      expansions.push(`${query} frontend framework`);
    }
    if (/\b(?:node|python|go|rust|java)\b/i.test(query)) {
      expansions.push(`${query} programming language`);
    }
    if (/\b(?:docker|kubernetes|k8s)\b/i.test(query)) {
      expansions.push(`${query} container orchestration`);
    }

    return expansions;
  }
}

export const gapDetector = new KnowledgeGapDetector();
