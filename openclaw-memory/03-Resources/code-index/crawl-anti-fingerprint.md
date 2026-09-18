---
id: code-crawl.anti-fingerprint
type: code-index
source: crawl\anti-fingerprint.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 655
tags: [code, auto-indexed]
exports: ["Fingerprint", "FingerprintGenerator", "fpGen"]
---

# crawl.anti-fingerprint

## 元信息

- **源文件**: `crawl\anti-fingerprint.ts`
- **模块**: `crawl.anti-fingerprint`
- **行数**: 196
- **索引时间**: 2026-05-25T05:11:12.523Z

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| interface | `Fingerprint` | 73 |
| class | `FingerprintGenerator` | 95 |
| variable | `fpGen` | 195 |

## 代码

```typescript
/**
 * 反追踪 / 反指纹 / 反审查模块
 *
 * 设计原则：
 * 1. 请求特征随机化 — 每次请求使用不同的指纹组合
 * 2. 时间模式模糊化 — 消除可预测的时间间隔
 * 3. 网络特征混淆 — 代理轮换 + TLS 指纹多样化
 * 4. 元数据最小化 — 仅发送必要的请求头
 * 5. 隔离性 — 每个请求使用独立的 cookie/会话上下文
 */

/** 用户代理池 — 覆盖主流浏览器和操作系统 */
const USER_AGENTS = [
  // Chrome on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Chrome on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  // Firefox
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
  // Safari
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  // Edge
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
  // Mobile
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
];

/** Accept-Language 池 — 模拟不同地区用户 */
const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-TW,zh;q=0.9,en;q=0.8",
  "ja-JP,ja;q=0.9,en;q=0.8",
  "en-GB,en;q=0.9",
  "de-DE,de;q=0.9,en;q=0.8",
  "fr-FR,fr;q=0.9,en;q=0.8",
  "ko-KR,ko;q=0.9,en;q=0.8",
];

/** Accept 头池 */
const ACCEPT_HEADERS = [
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
];

/** 时区池 */
const TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
];

/** 屏幕分辨率池 */
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 2560, height: 1440 },
  { width: 390, height: 844 },   // iPhone 14
  { width: 412, height: 915 },   // Android
];

export interface Fingerprint {
  userAgent: string;
  acceptLanguage: string;
  accept: string;
  acceptEncoding: string;
  dnt: string;
  secFetchDest: string;
  secFetchMode: string;
  secFetchSite: string;
  secFetchUser: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  viewport: { width: number; height: number };
  timezone: string;
  /** 请求间隔延迟（ms） */
  jitterDelay: number;
  /** 是否启用缓存破坏 */
  cacheBust: boolean;
}

/** 指纹生成器 */
export class FingerprintGenerator {
  private rng: () => number;

  constructor(seed?: number) {
    // 简单的 LCG 随机数生成器，支持可选种子用于测试
    let s = seed ?? Math.floor(Math.random() * 0x7fffffff);
    this.rng = () => {
      s = (s * 16807 + 0) % 0x7fffffff;
      return (s - 1) / 0x7fffffff;
    };
  }

  generate(): Fingerprint {
    const ua = this.pick(USER_AGENTS);
    const isMobile = ua.includes("Mobile") || ua.includes("iPhone");
    const platform = this.extractPlatform(ua);

    return {
      userAgent: ua,
      acceptLanguage: this.pick(ACCEPT_LANGUAGES),
      accept: this.pick(ACCEPT_HEADERS),
      acceptEncoding: "gzip, deflate, br",
      dnt: this.rng() > 0.7 ? "1" : "0",
      secFetchDest: "document",
      secFetchMode: "navigate",
      secFetchSite: "none",
      secFetchUser: "?1",
      secChUa: this.buildSecChUa(ua),
      secChUaMobile: isMobile ? "?1" : "?0",
      secChUaPlatform: `"${platform}"`,
      viewport: isMobile
        ? VIEWPORTS.filter((v) => v.width < 500)[Math.floor(this.rng() * 2)]
        : VIEWPORTS.filter((v) => v.width >= 1000)[Math.floor(this.rng() * 5)],
      timezone: this.pick(TIMEZONES),
      jitterDelay: this.randomJitter(),
      cacheBust: this.rng() > 0.5,
    };
  }

  /** 生成请求头 */
  buildHeaders(fp: Fingerprint, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": fp.userAgent,
      Accept: fp.accept,
      "Accept-Language": fp.acceptLanguage,
      "Accept-Encoding": fp.acceptEncoding,
      DNT: fp.dnt,
      "Sec-Fetch-Dest": fp.secFetchDest,
      "Sec-Fetch-Mode": fp.secFetchMode,
      "Sec-Fetch-Site": fp.secFetchSite,
      "Sec-Fetch-User": fp.secFetchUser,
      "Sec-Ch-Ua": fp.secChUa,
      "Sec-Ch-Ua-Mobile": fp.secChUaMobile,
      "Sec-Ch-Ua-Platform": fp.secChUaPlatform,
      "Cache-Control": fp.cacheBust ? "no-cache" : "max-age=0",
      "Upgrade-Insecure-Requests": "1",
      Connection: "keep-alive",
      ...extra,
    };

    // 移除值为空的头，减少指纹熵
    for (const [k, v] of Object.entries(headers)) {
      if (!v || v === "undefined") delete headers[k];
    }

    return headers;
  }

  /** 随机化时间间隔（指数退避 + 抖动） */
  randomJitter(baseMs = 1000): number {
    // 指数分布，平均值为 baseMs
    const exp = -baseMs * Math.log(this.rng() || 0.001);
    // 添加 ±30% 抖动
    const jitter = exp * (0.7 + this.rng() * 0.6);
    return Math.min(Math.max(jitter, 200), baseMs * 5);
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  private extractPlatform(ua: string): string {
    if (ua.includes("Windows")) return "Windows";
    if (ua.includes("Mac OS X")) return "macOS";
    if (ua.includes("Linux")) return "Linux";
    if (ua.includes("Android")) return "Android";
    if (ua.includes("iPhone")) return "iOS";
    return "Unknown";
  }

  private buildSecChUa(ua: string): string {
    if (ua.includes("Chrome/125")) return '"Chromium";v="125", "Not.A/Brand";v="24"';
    if (ua.includes("Chrome/124")) return '"Chromium";v="124", "Not.A/Brand";v="24"';
    if (ua.includes("Edg")) return '"Chromium";v="125", "Microsoft Edge";v="125"';
    if (ua.includes("Firefox")) return '"Firefox";v="126"';
    return '"Not.A/Brand";v="99"';
  }
}

/** 全局指纹生成器实例 */
export const fpGen = new FingerprintGenerator();

```