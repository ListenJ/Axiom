/**
 * 智能流量识别与分类引擎
 *
 * 多维度特征流量识别，区分用户 agent 任务流量与外部攻击流量：
 *   - 路径遍历 (path traversal)
 *   - SQL 注入 (SQLi)
 *   - XSS 跨站脚本
 *   - 命令注入
 *   - SSRF 服务端请求伪造
 *   - 恶意 User-Agent（sqlmap/nikto/nmap 等扫描工具）
 *   - 可疑路径探测（.env / .git / wp-admin 等）
 *   - 异常载荷大小
 *
 * 性能：分类延迟 < 1ms（正则匹配），满足 ≤100ms 要求。
 * 集成：classify() → auditLogger → securityMonitor → healthCheck。
 */

import { logger } from "./logger.js";

export type TrafficClass = "legitimate" | "suspicious" | "malicious";

export interface TrafficFeatures {
  method: string;
  path: string;
  userAgent: string;
  contentType: string;
  payloadSize: number;
  query: string;
  remoteAddress: string;
}

export interface ClassificationResult {
  classification: TrafficClass;
  score: number; // 0-1, higher = more suspicious
  reasons: string[];
  features: TrafficFeatures;
  durationMs: number;
}

export interface TrafficStats {
  total: number;
  legitimate: number;
  suspicious: number;
  malicious: number;
  topAttackTypes: Array<{ type: string; count: number }>;
  avgLatencyMs: number;
}

interface AttackPattern {
  name: string;
  pattern: RegExp;
  score: number;
}

/** 攻击签名数据库 — 可配置、可扩展 */
const ATTACK_PATTERNS: AttackPattern[] = [
  // 路径遍历
  { name: "path_traversal", pattern: /(?:\.\.[\/\\]){2,}|%2e%2e[%/\\]|\.\.%2f/i, score: 0.8 },
  // SQL 注入
  { name: "sql_injection", pattern: /['"]\s*(?:or|and)\s+\d\s*=\s*\d|union\s+select|;\s*drop\s+table|;\s*insert\s+into|;\s*update\s+\w+\s+set/i, score: 0.9 },
  // XSS
  { name: "xss", pattern: /<script|javascript:|onerror\s*=|onload\s*=|<iframe|<embed|<svg\/on/i, score: 0.8 },
  // 命令注入
  { name: "cmd_injection", pattern: /[;|&]\s*(?:cat|ls|id|whoami|wget|curl|bash|sh|nc|ncat|ping|nslookup)\b/i, score: 0.9 },
  // SSRF
  { name: "ssrf", pattern: /(?:https?|ftp):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254|::1|\[::1\])/i, score: 0.7 },
];

/** 恶意 User-Agent 签名 */
const MALICIOUS_UA_RE = /sqlmap|nikto|nmap|masscan|nessus|openvas|acunetix|w3af|havij|dirbuster|gobuster|hydra|metasploit|burp/i;

/** 可疑路径探测 */
const SUSPICIOUS_PATHS: Array<{ name: string; pattern: RegExp; score: number }> = [
  { name: "suspicious_path", pattern: /\.env\b/i, score: 0.9 },
  { name: "suspicious_path", pattern: /\.git\b/i, score: 0.9 },
  { name: "suspicious_path", pattern: /wp-admin|wp-login/i, score: 0.6 },
  { name: "suspicious_path", pattern: /\.ssh\b/i, score: 0.9 },
  { name: "suspicious_path", pattern: /\/etc\/passwd/i, score: 0.9 },
  { name: "suspicious_path", pattern: /\/proc\/self/i, score: 0.8 },
];

/** 上传端点白名单 — 允许大载荷 */
const UPLOAD_PATH_RE = /\/(?:upload|ocr\/scan|import)\b/i;
const UPLOAD_CONTENT_RE = /multipart\/form-data/i;
const OVERSIZE_THRESHOLD = 100 * 1024; // 100KB

const SUSPICIOUS_THRESHOLD = 0.3;
const MALICIOUS_THRESHOLD = 0.7;

export class TrafficClassifier {
  private stats_counts = { legitimate: 0, suspicious: 0, malicious: 0 };
  private attackTypeCounts = new Map<string, number>();
  private totalLatencyMs = 0;

  /**
   * 对单个请求进行多维度特征分类
   *
   * 检查顺序：快速 UA 检查 → 路径检查 → 查询参数/路径攻击签名 → 载荷大小
   * 得分取所有命中规则的最高分（而非累加），避免误报叠加。
   */
  classify(features: TrafficFeatures): ClassificationResult {
    const start = performance.now();
    const reasons: string[] = [];
    let maxScore = 0;

    // 1. 恶意 User-Agent 检测
    if (MALICIOUS_UA_RE.test(features.userAgent)) {
      reasons.push("malicious_ua");
      maxScore = Math.max(maxScore, 0.85);
    }

    // 2. 可疑路径探测
    for (const sp of SUSPICIOUS_PATHS) {
      if (sp.pattern.test(features.path)) {
        if (!reasons.includes(sp.name)) reasons.push(sp.name);
        maxScore = Math.max(maxScore, sp.score);
      }
    }

    // 3. 攻击签名检测 — 检查 path + query
    const checkStr = `${features.path}?${features.query}`;
    for (const ap of ATTACK_PATTERNS) {
      if (ap.pattern.test(checkStr) || ap.pattern.test(features.path)) {
        if (!reasons.includes(ap.name)) reasons.push(ap.name);
        maxScore = Math.max(maxScore, ap.score);
      }
    }

    // 4. 异常载荷大小检测（上传端点豁免）
    const isUpload = UPLOAD_PATH_RE.test(features.path) || UPLOAD_CONTENT_RE.test(features.contentType);
    if (!isUpload && features.payloadSize > OVERSIZE_THRESHOLD) {
      reasons.push("oversized_payload");
      maxScore = Math.max(maxScore, 0.4);
    }

    // 分类
    let classification: TrafficClass;
    if (maxScore >= MALICIOUS_THRESHOLD) {
      classification = "malicious";
    } else if (maxScore >= SUSPICIOUS_THRESHOLD) {
      classification = "suspicious";
    } else {
      classification = "legitimate";
    }

    const durationMs = performance.now() - start;

    // 更新统计
    this.stats_counts[classification]++;
    this.totalLatencyMs += durationMs;
    for (const reason of reasons) {
      this.attackTypeCounts.set(reason, (this.attackTypeCounts.get(reason) ?? 0) + 1);
    }

    if (classification === "malicious") {
      logger.warn("[TrafficClassifier] Malicious traffic detected", {
        classification,
        score: maxScore,
        reasons,
        path: features.path,
        remoteAddress: features.remoteAddress,
      });
    }

    return {
      classification,
      score: Math.round(maxScore * 1000) / 1000,
      reasons,
      features,
      durationMs,
    };
  }

  /** 返回分类统计，供 dashboard 使用 */
  stats(): TrafficStats {
    const total = this.stats_counts.legitimate + this.stats_counts.suspicious + this.stats_counts.malicious;
    const topAttackTypes = Array.from(this.attackTypeCounts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total,
      legitimate: this.stats_counts.legitimate,
      suspicious: this.stats_counts.suspicious,
      malicious: this.stats_counts.malicious,
      topAttackTypes,
      avgLatencyMs: total > 0 ? Math.round((this.totalLatencyMs / total) * 1000) / 1000 : 0,
    };
  }

  /** 清空统计 */
  reset(): void {
    this.stats_counts = { legitimate: 0, suspicious: 0, malicious: 0 };
    this.attackTypeCounts.clear();
    this.totalLatencyMs = 0;
  }
}

/** 全局单例 */
let globalClassifier: TrafficClassifier | null = null;

export function getTrafficClassifier(): TrafficClassifier {
  if (!globalClassifier) {
    globalClassifier = new TrafficClassifier();
  }
  return globalClassifier;
}
