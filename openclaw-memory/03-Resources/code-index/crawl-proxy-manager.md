---
id: code-crawl.proxy-manager
type: code-index
source: crawl\proxy-manager.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 518
tags: [code, auto-indexed]
exports: ["ProxyConfig", "ProxyManager", "proxyManager"]
imports: ["fs"]
---

# crawl.proxy-manager

## 元信息

- **源文件**: `crawl\proxy-manager.ts`
- **模块**: `crawl.proxy-manager`
- **行数**: 167
- **索引时间**: 2026-05-25T05:11:12.527Z

## 依赖

- [[fs]]

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| interface | `ProxyConfig` | 12 |
| class | `ProxyManager` | 26 |
| variable | `proxyManager` | 166 |

## 代码

```typescript
/**
 * 代理管理器
 * 支持 HTTP / HTTPS / SOCKS5 代理，自动轮换与健康检查
 *
 * 代理格式：
 *   http://user:pass@host:port
 *   https://host:port
 *   socks5://user:pass@host:port
 */
import fs from "fs";

export interface ProxyConfig {
  url: string;
  /** 权重，越高使用频率越高 */
  weight?: number;
  /** 标签，如 "us", "eu", "asia" */
  tag?: string;
  /** 最后检查时间 */
  lastChecked?: number;
  /** 健康状态 */
  healthy?: boolean;
  /** 平均延迟 ms */
  latencyMs?: number;
}

export class ProxyManager {
  private proxies: ProxyConfig[] = [];
  private currentIndex = 0;
  private failedCounts = new Map<string, number>();
  private readonly maxFailCount = 3;

  constructor(proxies?: ProxyConfig[]) {
    if (proxies) {
      this.proxies = proxies.map((p) => ({ ...p, healthy: true, weight: p.weight ?? 1 }));
    }
  }

  /** 从环境变量加载代理列表 */
  static fromEnv(): ProxyManager {
    const proxies: ProxyConfig[] = [];

    // 单代理: PROXY_URL
    const single = process.env.PROXY_URL;
    if (single) proxies.push({ url: single });

    // 多代理: PROXY_LIST (逗号分隔)
    const list = process.env.PROXY_LIST;
    if (list) {
      for (const url of list.split(",").map((s) => s.trim()).filter(Boolean)) {
        proxies.push({ url });
      }
    }

    // 代理池文件: PROXY_POOL_FILE (每行一个代理)
    const poolFile = process.env.PROXY_POOL_FILE;
    if (poolFile) {
      try {
        const text = fs.readFileSync(poolFile, "utf-8");
        for (const line of text.split("\n")) {
          const url = line.trim();
          if (url && !url.startsWith("#")) proxies.push({ url });
        }
      } catch {
        console.warn(`[ProxyManager] Failed to read proxy pool file: ${poolFile}`);
      }
    }

    return new ProxyManager(proxies);
  }

  /** 添加代理 */
  add(proxy: ProxyConfig): void {
    this.proxies.push({ ...proxy, healthy: true, weight: proxy.weight ?? 1 });
  }

  /** 获取下一个代理（加权轮询） */
  next(tag?: string): ProxyConfig | null {
    const candidates = this.proxies.filter(
      (p) => p.healthy !== false && (!tag || p.tag === tag)
    );
    if (candidates.length === 0) return null;

    // 加权随机选择
    const totalWeight = candidates.reduce((s, p) => s + (p.weight ?? 1), 0);
    let rnd = Math.random() * totalWeight;
    for (const p of candidates) {
      rnd -= p.weight ?? 1;
      if (rnd <= 0) return p;
    }
    return candidates[candidates.length - 1];
  }

  /** 标记代理失败 */
  markFailed(url: string): void {
    const count = (this.failedCounts.get(url) ?? 0) + 1;
    this.failedCounts.set(url, count);

    if (count >= this.maxFailCount) {
      const p = this.proxies.find((x) => x.url === url);
      if (p) {
        p.healthy = false;
        console.warn(`[ProxyManager] Proxy marked unhealthy after ${count} failures: ${this.maskUrl(url)}`);
      }
    }
  }

  /** 标记代理成功 */
  markSuccess(url: string, latencyMs: number): void {
    this.failedCounts.set(url, 0);
    const p = this.proxies.find((x) => x.url === url);
    if (p) {
      p.healthy = true;
      p.latencyMs = latencyMs;
      p.lastChecked = Date.now();
    }
  }

  /** 健康检查所有代理 */
  async healthCheck(targetUrl = "https://httpbin.org/ip"): Promise<void> {
    console.log(`[ProxyManager] Checking ${this.proxies.length} proxies...`);

    const checks = this.proxies.map(async (p) => {
      const start = performance.now();
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10000);

        await fetch(targetUrl, {
          proxy: p.url,
          signal: controller.signal,
        });

        const latency = Math.round(performance.now() - start);
        this.markSuccess(p.url, latency);
        console.log(`  🟢 ${this.maskUrl(p.url)} (${latency}ms)`);
      } catch (e: any) {
        this.markFailed(p.url);
        console.log(`  🔴 ${this.maskUrl(p.url)} — ${e.message}`);
      }
    });

    await Promise.allSettled(checks);

    const healthy = this.proxies.filter((p) => p.healthy !== false).length;
    console.log(`[ProxyManager] ${healthy}/${this.proxies.length} proxies healthy`);
  }

  /** 获取健康的代理数量 */
  getHealthyCount(): number {
    return this.proxies.filter((p) => p.healthy !== false).length;
  }

  /** 代理 URL 脱敏（日志中使用） */
  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.username) u.password = "***";
      return `${u.protocol}//${u.host}`;
    } catch {
      return url.slice(0, 20) + "...";
    }
  }
}

/** 全局代理管理器 */
export const proxyManager = ProxyManager.fromEnv();

```