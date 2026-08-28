/**
 * 审计 S4 网络层切片（docs/reviews/2026-08-28-independent-full-audit.md）：
 *  M9   —— 代理 curl 路径无 AbortController：curl -m 30 × 3 重试 + sleep 最坏 ~92s 有界阻塞
 *          （search-engines.ts curlFetch Bun.spawn 无 kill 兜底 + DDG/BingHtml 重试循环无总预算）
 *  L12a —— richSnippets.deepLinks 未钳制（search-engines.ts:269，条数/单项长度不受控）
 *  L12b —— result-scorer.ts:121 每次调用 new ConformalHallucinationDetector
 *          （构造器对全部 factBase 重建 IDF 缓存，逐结果打分路径重复 tokenize 全库）
 *
 * M9 / L12b 无行为接缝（fetchImpl 注入时不重试：attempts=1；检测器无可观测缓存面），
 * 按仓库惯例（tests/vram-probe-wiring.test.ts）用静态断言锁定；L12a 走行为断言
 * （clampDeepLinks 直测 + BingEngine 经注入 fetch 的公共接口验证）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { curlFetch, clampDeepLinks, BingEngine } from "../../src/crawl/search-engines.js";
import type { ProxyFetchResponse } from "../../src/utils/proxy-fetch.js";

const searchEnginesSrc = readFileSync("src/crawl/search-engines.ts", "utf8");
const resultScorerSrc = readFileSync("src/crawl/result-scorer.ts", "utf8");

function fakeResponse(payload: unknown): ProxyFetchResponse {
  const body = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    url: "https://api.bing.microsoft.com/v7.0/search",
    text: async () => body,
    json: async () => JSON.parse(body),
    buffer: async () => Buffer.from(body),
    arrayBuffer: async () => Buffer.from(body).buffer,
  };
}

describe("审计 M9: curl 子进程超时 kill + 单引擎重试总预算（静态断言）", () => {
  test("curlFetch 默认 spawn 含超时 kill 兜底（killTimer/proc.kill）", () => {
    expect(searchEnginesSrc).toContain("proc.kill()");
    expect(searchEnginesSrc).toContain("killTimer");
  });

  test("kill 时限与宽限硬上限常量存在且值合理（30s 对齐 -m 30，宽限 5s）", () => {
    expect(searchEnginesSrc).toMatch(/CURL_PROC_TIMEOUT_MS\s*=\s*30_000/);
    expect(searchEnginesSrc).toMatch(/CURL_PROC_KILL_GRACE_MS\s*=\s*5_000/);
  });

  test("单引擎重试总预算常量存在且值合理（45s，覆盖 92s 最坏场景）", () => {
    expect(searchEnginesSrc).toMatch(/SEARCH_ENGINE_TOTAL_BUDGET_MS\s*=\s*45_000/);
  });

  test("总预算接入 DDG 与 BingHtml 两个重试循环（声明 + 2 处引用）", () => {
    const refs = searchEnginesSrc.match(/SEARCH_ENGINE_TOTAL_BUDGET_MS/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("审计 L12a: richSnippets.deepLinks 钳制", () => {
  test("行为：条数钳到 5、单项字符串钳到 200、短项原样保留", () => {
    const long = "x".repeat(500);
    const out = clampDeepLinks([long, "a".repeat(150), "short", long, "b", long, long]);
    expect(out.length).toBe(5);
    expect(out[0].length).toBe(200);
    expect(out[1]).toBe("a".repeat(150));
    expect(out[2]).toBe("short");
  });

  test("行为：非字符串项 JSON 序列化后同样钳制", () => {
    const out = clampDeepLinks([{ name: "n".repeat(300), url: "https://e.com" }]);
    expect(out.length).toBe(1);
    expect(out[0].length).toBe(200);
    expect(out[0]).toContain('"name"');
  });

  test("静态：常量并列定义且 Bing 映射点经 clampDeepLinks", () => {
    expect(searchEnginesSrc).toMatch(/SEARCH_DEEPLINKS_MAX_ITEMS\s*=\s*5/);
    expect(searchEnginesSrc).toMatch(/SEARCH_DEEPLINKS_ITEM_MAX\s*=\s*200/);
    expect(searchEnginesSrc).toContain("clampDeepLinks(r.deepLinks)");
  });

  test("BingEngine 公共接口：deepLinks 超长数组被钳制（注入 fetch）", async () => {
    process.env.BING_API_KEY = process.env.BING_API_KEY || "test-key-s4";
    const long = "y".repeat(400);
    const engine = new BingEngine(async () =>
      fakeResponse({
        webPages: {
          value: [
            {
              name: "t",
              url: "https://e.com/a",
              displayUrl: "e.com/a",
              snippet: "s",
              deepLinks: [long, long, long, long, long, long, long],
            },
          ],
        },
      }),
    );
    const results = await engine.search({ query: "q" });
    expect(results.length).toBe(1);
    const deepLinks = (results[0].richSnippets as { deepLinks: string[] }).deepLinks;
    expect(deepLinks.length).toBe(5);
    for (const d of deepLinks) expect(d.length).toBe(200);
  });
});

describe("审计 L12b: result-scorer 检测器单例化（静态断言）", () => {
  test("检测器构造收敛到惰性缓存 helper（scoreFactualAccuracy 内不再 new）", () => {
    expect(resultScorerSrc).toContain("getSharedHallucinationDetector");
    // 构造点唯一：仅在缓存 helper 内出现一次
    const ctorRefs = resultScorerSrc.match(/new ConformalHallucinationDetector/g) ?? [];
    expect(ctorRefs.length).toBe(1);
  });

  test("缓存有上界（防 factBase 内容膨胀泄漏）", () => {
    expect(resultScorerSrc).toMatch(/DETECTOR_CACHE_MAX/);
  });
});

describe("M9 回归: curlFetch 正常路径不回归（mock spawn 注入）", () => {
  test("exit 0 → ok=true 且命令行仍含 -m 30", async () => {
    let captured: string[] = [];
    const spawn = (args: string[]) => {
      captured = args;
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode("<html>ok</html>"),
        stderr: new Uint8Array(),
      };
    };
    const r = await curlFetch("https://example.com", {}, "http://proxy:7890", spawn);
    expect(r.ok).toBe(true);
    expect(captured.join(" ")).toContain("-m 30");
  });
});
