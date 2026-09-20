/**
 * 切片 B：自定义 provider —— 写进**同一事实源**（`src/utils/api-key-store.ts`）
 *
 * 覆盖：
 *  - 合法注册后可被解析（`getProviderConfig` / `getEffectiveApiKey` / `getEffectiveBaseURL` 全链路）
 *  - 密钥走**既有 override 通路**（不新增第二处密钥存储、不新增第二张 provider 表）
 *  - 校验：名称格式 / 撞内置名 / baseURL 协议 / 不支持的 adapter / 空 key
 *  - 路由：未知 provider **不再一律拒绝** —— 带齐三字段则注册；只给 provider+apiKey 仍 400 且给 hint
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  registerCustomProvider,
  isCustomProvider,
  listCustomProviders,
  unregisterCustomProvider,
  getProviderConfig,
  getEffectiveApiKey,
  getEffectiveBaseURL,
} from "../../src/utils/api-key-store.js";
import { handleApiKeys } from "../../src/routes/api-keys.js";
import type { RouteContext } from "../../src/routes/types.js";
import { Database } from "bun:sqlite";
import { initApiKeyOverridesTable, loadApiKeyOverrides } from "../../src/utils/api-key-persistence.js";
import { loadOverrides } from "../../src/utils/api-key-store.js";

const NAME = "my-embed-endpoint";
const KEY = "sk-custom-test-123456";

afterEach(() => {
  unregisterCustomProvider(NAME);
  delete process.env.AXIOM_AUTH_TOKEN;
  delete process.env.AXIOM_ENCRYPTION_KEY;
});

/** 真 DB（内存）+ 真加密密钥：落库路径是 fail-closed 的，必须给全 */
function makeDb(): Database {
  process.env.AXIOM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const db = new Database(":memory:");
  initApiKeyOverridesTable(db);
  return db;
}

describe("自定义 provider：同一事实源内可解析", () => {
  it("合法注册后 getProviderConfig / 有效 key / 有效 baseURL 全部打通", () => {
    const r = registerCustomProvider({
      provider: NAME, baseURL: "https://example.com/v1", adapter: "openai", apiKey: KEY,
    });
    expect(r.ok).toBe(true);
    expect(isCustomProvider(NAME)).toBe(true);

    const cfg = getProviderConfig(NAME);
    expect(cfg?.baseURL).toBe("https://example.com/v1");
    expect(cfg?.apiKeyEnv).toBe(""); // 自定义 provider 没有 env 名，密钥在 override 通路里

    expect(getEffectiveApiKey(NAME, "")).toBe(KEY);
    expect(getEffectiveBaseURL(NAME, "", "about:blank")).toBe("https://example.com/v1");
    expect(listCustomProviders().some((p) => p.provider === NAME)).toBe(true);
  });

  it("注销后不再可解析", () => {
    registerCustomProvider({ provider: NAME, baseURL: "https://example.com/v1", adapter: "openai", apiKey: KEY });
    expect(unregisterCustomProvider(NAME)).toBe(true);
    expect(isCustomProvider(NAME)).toBe(false);
    expect(getProviderConfig(NAME)).toBeUndefined();
  });

  it("名称与内置 provider 冲突时拒绝（不覆盖内置）", () => {
    const r = registerCustomProvider({ provider: "deepseek", baseURL: "https://x.example/v1", adapter: "openai", apiKey: KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("内置");
  });

  it("非法名称被拒", () => {
    for (const bad of ["", "bad name", "-lead", "a/b"]) {
      const r = registerCustomProvider({ provider: bad, baseURL: "https://x.example/v1", adapter: "openai", apiKey: KEY });
      expect(r.ok).toBe(false);
    }
  });

  it("baseURL 非 http(s) 或被拒", () => {
    for (const bad of ["ftp://x.example/v1", "not-a-url", "javascript:alert(1)"]) {
      const r = registerCustomProvider({ provider: NAME, baseURL: bad, adapter: "openai", apiKey: KEY });
      expect(r.ok).toBe(false);
    }
  });

  it("不支持的协议被拒（列出可选值）", () => {
    const r = registerCustomProvider({ provider: NAME, baseURL: "https://x.example/v1", adapter: "grpc", apiKey: KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("openai");
  });

  it("空 apiKey 被拒", () => {
    const r = registerCustomProvider({ provider: NAME, baseURL: "https://x.example/v1", adapter: "openai", apiKey: "   " });
    expect(r.ok).toBe(false);
  });
});

function makeCtx(body: Record<string, unknown>, db: Database): RouteContext {
  return {
    url: new URL("http://x/api-keys"),
    req: new Request("http://x/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-token-16chars" },
      body: JSON.stringify(body),
    }),
    db,
    vault: null,
    pipeline: null,
    healthMonitor: null,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }),
  } as never;
}

describe("路由：未知 provider 不再一律拒绝", () => {
  it("带齐 adapter/baseURL/apiKey → 注册成功（custom:true）且**已落库**", async () => {
    process.env.AXIOM_AUTH_TOKEN = "test-token-16chars";
    const db = makeDb();
    const res = (await handleApiKeys(makeCtx({
      provider: NAME, apiKey: KEY, baseURL: "https://example.com/v1", adapter: "openai",
    }, db))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; custom?: boolean };
    expect(body.ok).toBe(true);
    expect(body.custom).toBe(true);
    expect(isCustomProvider(NAME)).toBe(true);

    // 落库校验（复用既有 override 表，不新造存储）
    const persisted = loadApiKeyOverrides(db);
    const row = persisted.find((p) => p.provider === NAME);
    expect(row?.adapter).toBe("openai");
    expect(row?.baseURL).toBe("https://example.com/v1");
    db.close();
  });

  it("重启恢复：loadOverrides 依 adapter 重建自定义 provider", () => {
    const db = makeDb();
    const { saveApiKeyOverride } = require("../../src/utils/api-key-persistence.js") as typeof import("../../src/utils/api-key-persistence.js");
    saveApiKeyOverride(db, NAME, KEY, "https://example.com/v2", { adapter: "anthropic", displayName: "我的端点" });

    // 模拟重启：先清掉内存注册，再从库里恢复
    unregisterCustomProvider(NAME);
    expect(isCustomProvider(NAME)).toBe(false);
    loadOverrides(loadApiKeyOverrides(db));

    expect(isCustomProvider(NAME)).toBe(true);
    expect(getProviderConfig(NAME)?.baseURL).toBe("https://example.com/v2");
    expect(getEffectiveApiKey(NAME, "")).toBe(KEY);
    db.close();
  });

  it("只给 provider+apiKey（缺 adapter/baseURL）→ 仍 400，并提示需要哪三个字段", async () => {
    process.env.AXIOM_AUTH_TOKEN = "test-token-16chars";
    const db = makeDb();
    const res = (await handleApiKeys(makeCtx({ provider: NAME, apiKey: KEY }, db))) as Response;
    expect(res.status).toBe(400);
    const body = (await res.json()) as { hint?: string };
    expect(body.hint).toContain("adapter");
    expect(isCustomProvider(NAME)).toBe(false);
  });
});
