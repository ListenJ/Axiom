/**
 * 生产接线：`POST /settings/search` 的 embedding **授权门**（切片 5）
 *
 * 被锁住的声明（用户 D1/D2/D5 裁定）：
 * - 未授权（`AXIOM_EMBEDDING_CONSENT` 缺省 = `ask`）⇒ 该路由**一次 embedding 调用都不发**，
 *   走确定性关键词路径；
 * - 已授权（`yes`）⇒ 门**真的打开**（不是永久关闭的摆设）：确实调用路由 embedding，
 *   并可用返回的向量产出语义/混合结果；
 * - embedding 失败 ⇒ 降级关键词，路由仍 200（不把检索打成 500）。
 *
 * 注：本文件用 `spyOn(router, "embeddings")`（**不是** `mock.module`）——后者是进程级替换，
 * 会污染同批其它测试文件（本仓库已有踩坑记录）。
 */
import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { handleSettingsSearch } from "../../src/routes/settings.js";
import { router } from "../../src/router/model-router.js";
import { EMBEDDING_CONSENT_ENV } from "../../src/knowledge/embedding-consent.js";
import { snapshotEnv } from "../../src/utils/env.js";

const envSnap = snapshotEnv([EMBEDDING_CONSENT_ENV]);

afterAll(() => {
  envSnap.restore();
});

beforeEach(() => {
  delete process.env[EMBEDDING_CONSENT_ENV];
});

function makeCtx(body: unknown) {
  const url = "http://x/settings/search";
  return {
    url: new URL(url),
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null,
    startupTime: Date.now(), baseHeaders: {},
    jsonResponse: (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  } as never;
}

describe("POST /settings/search · embedding 授权门", () => {
  it("未授权（默认 ask）⇒ **零 embedding 调用**，且返回确定性关键词结果", async () => {
    let calls = 0;
    const spy = spyOn(router, "embeddings").mockImplementation(async (texts: string[]) => {
      calls++;
      return texts.map(() => [1, 0, 0]);
    });
    try {
      const res = (await handleSettingsSearch(makeCtx({ q: "缓存" }))) as Response;
      expect(res.status).toBe(200);
      const data = (await res.json()) as { engine: string; results: unknown[] };
      expect(calls).toBe(0);
      expect(data.engine).toBe("keyword");
      expect(data.results.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("已授权 yes ⇒ 门**确实打开**：调用路由 embedding 并产出语义/混合结果", async () => {
    process.env[EMBEDDING_CONSENT_ENV] = "yes";
    let calls = 0;
    // 让"缓存"这条与大多数条目正交、只与目录中第一条同向，从而必然出现语义命中
    const spy = spyOn(router, "embeddings").mockImplementation(async (texts: string[]) => {
      calls++;
      return texts.map((_, i) => [i === 0 || i === 1 ? 1 : 0, 0, 0]);
    });
    try {
      const res = (await handleSettingsSearch(makeCtx({ q: "缓存" }))) as Response;
      expect(res.status).toBe(200);
      const data = (await res.json()) as { engine: string; results: Array<{ score: number }> };
      expect(calls).toBe(1);
      expect(data.engine === "semantic" || data.engine === "hybrid").toBe(true);
      expect(data.results.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("已授权但 embedding 抛错 ⇒ 降级关键词，仍 200（不打成 500）", async () => {
    process.env[EMBEDDING_CONSENT_ENV] = "yes";
    const spy = spyOn(router, "embeddings").mockImplementation(async () => {
      throw new Error("network down");
    });
    try {
      const res = (await handleSettingsSearch(makeCtx({ q: "缓存" }))) as Response;
      expect(res.status).toBe(200);
      const data = (await res.json()) as { engine: string };
      expect(data.engine).toBe("keyword");
    } finally {
      spy.mockRestore();
    }
  });

  it("路径/方法不匹配 ⇒ 返回 null（放行给其它 handler）", async () => {
    const ctx = { url: new URL("http://x/settings/catalog"), req: new Request("http://x/settings/catalog") } as never;
    expect(await handleSettingsSearch(ctx)).toBeNull();
  });
});
