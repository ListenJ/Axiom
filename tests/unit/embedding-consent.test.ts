/**
 * 切片 3：embedding 授权门 + 消耗估算 + 披露文案（纯离线）
 *
 * 覆盖：
 *  - 授权状态解析：默认 ask、三个合法值、非法值保守回落 ask
 *  - 估算纯函数：区间合理（min ≤ max）、随字符数单调、非法输入不抛错
 *  - 披露文案含四项要素 + 估算区间
 *  - 拒绝文案**区分召回与延迟**（不得写"效率降低"这类会被误读为变慢的表述）
 *  - 口径锁定：默认状态**不是** yes（未表态不得静默调用）
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  EMBEDDING_CONSENT_ENV,
  EMBEDDING_CONSENT_DEFAULT,
  EMBEDDING_DISCLOSURE_ELEMENTS,
  resolveEmbeddingConsent,
  estimateEmbeddingTokenRange,
  buildEmbeddingConsentPrompt,
  buildEmbeddingDenialImpact,
  createConsentedEmbedder,
} from "../../src/knowledge/embedding-consent.js";

const ORIG = process.env[EMBEDDING_CONSENT_ENV];
afterEach(() => {
  if (ORIG === undefined) delete process.env[EMBEDDING_CONSENT_ENV];
  else process.env[EMBEDDING_CONSENT_ENV] = ORIG;
});

describe("embedding 授权状态", () => {
  it("默认是 ask（未表态不得静默调用）", () => {
    delete process.env[EMBEDDING_CONSENT_ENV];
    expect(EMBEDDING_CONSENT_DEFAULT).toBe("ask");
    expect(resolveEmbeddingConsent()).toBe("ask");
  });

  it("yes / no / ask 三个合法值原样返回（大小写与空白不敏感）", () => {
    process.env[EMBEDDING_CONSENT_ENV] = " YES ";
    expect(resolveEmbeddingConsent()).toBe("yes");
    process.env[EMBEDDING_CONSENT_ENV] = "no";
    expect(resolveEmbeddingConsent()).toBe("no");
    process.env[EMBEDDING_CONSENT_ENV] = "ask";
    expect(resolveEmbeddingConsent()).toBe("ask");
  });

  it("非法值保守回落 ask（不当作同意）", () => {
    process.env[EMBEDDING_CONSENT_ENV] = "true";
    expect(resolveEmbeddingConsent()).toBe("ask");
    process.env[EMBEDDING_CONSENT_ENV] = "1";
    expect(resolveEmbeddingConsent()).toBe("ask");
  });
});

describe("消耗估算（纯函数）", () => {
  it("区间合理且随字符数单调", () => {
    const a = estimateEmbeddingTokenRange({ docCount: 10, totalChars: 4000 });
    expect(a.minTokens).toBeLessThanOrEqual(a.maxTokens);
    expect(a.maxTokens).toBe(4000);

    const b = estimateEmbeddingTokenRange({ docCount: 20, totalChars: 8000 });
    expect(b.maxTokens).toBeGreaterThan(a.maxTokens);
    expect(b.minTokens).toBeGreaterThanOrEqual(a.minTokens);
  });

  it("同输入同输出（确定性）", () => {
    const s = { docCount: 7, totalChars: 12345 };
    const runs = Array.from({ length: 5 }, () => estimateEmbeddingTokenRange(s));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it("非法/负数输入不抛错，按 0 处理", () => {
    const z = estimateEmbeddingTokenRange({ docCount: -1, totalChars: Number.NaN });
    expect(z.maxTokens).toBe(0);
    expect(z.minTokens).toBe(0);
  });

  it("method 明确写「估算、非计费依据」", () => {
    const e = estimateEmbeddingTokenRange({ docCount: 1, totalChars: 100 });
    expect(e.method).toContain("估算");
    expect(e.method).toContain("不是计费依据");
  });
});

describe("披露文案", () => {
  it("同意前文案含四项要素与估算区间", () => {
    const est = estimateEmbeddingTokenRange({ docCount: 100, totalChars: 250000 });
    const text = buildEmbeddingConsentPrompt(est);
    for (const el of EMBEDDING_DISCLOSURE_ELEMENTS) expect(text).toContain(el);
    expect(text).toContain(String(est.minTokens));
    expect(text).toContain(String(est.maxTokens));
    expect(text).toContain(EMBEDDING_CONSENT_ENV);
  });

  it("拒绝文案区分【召回】与【延迟】，且不得写「效率降低」", () => {
    const text = buildEmbeddingDenialImpact();
    expect(text).toContain("同义不同词");
    expect(text).toContain("跨语言");
    expect(text).toContain("缩写");
    expect(text).toContain("不受影响");
    expect(text).toContain("响应延迟");
    expect(text).toContain("略降");
    // 关键：不得出现"效率降低"这类会被读成"变慢"的笼统表述
    expect(text).not.toContain("效率降低");
  });
});

describe("授权门 → 真实 embedder（切片 4 第一步）", () => {
  it("未授权（ask/no）时**根本不交出 embedder** ⇒ 调用方物理上无法发起请求", () => {
    let called = 0;
    const deps = { embeddings: async () => { called++; return [[1, 2, 3]]; } };

    expect(createConsentedEmbedder(deps, { mode: "ask" })).toBeNull();
    expect(createConsentedEmbedder(deps, { mode: "no" })).toBeNull();
    expect(called).toBe(0); // 关键：零调用，不是"调了但忽略结果"
  });

  it("已授权（yes）时才返回可用 embedder，并转发到注入的真实实现", async () => {
    let got: string[] | null = null;
    const deps = { embeddings: async (texts: string[]) => { got = texts; return [[0.1, 0.2]]; } };

    const embedder = createConsentedEmbedder(deps, { mode: "yes" });
    expect(embedder).not.toBeNull();
    const vecs = await embedder!(["你好"]);
    expect(got as unknown).toEqual(["你好"]);
    expect(vecs[0]!.length).toBe(2);
  });

  it("已授权但底层失败 → 返回空数组降级（不抛错、不阻断主流程）", async () => {
    const deps = { embeddings: async () => { throw new Error("429 rate limited"); } };
    const embedder = createConsentedEmbedder(deps, { mode: "yes" })!;
    await expect(embedder(["x"])).resolves.toEqual([]);
  });

  it("缺省取环境授权状态（未设置 ⇒ ask ⇒ null）", () => {
    delete process.env[EMBEDDING_CONSENT_ENV];
    const deps = { embeddings: async () => [[1]] };
    expect(createConsentedEmbedder(deps)).toBeNull();
  });
});
