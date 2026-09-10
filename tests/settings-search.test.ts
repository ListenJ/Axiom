/**
 * Settings catalog + semantic/keyword search tests
 *
 * 覆盖：
 *  - 设置目录完整性（key 唯一、中文 label/desc、分区齐全）
 *  - 关键词搜索（中文子串 + 同义词，相近设置项可区分）
 *  - 语义 embedding 注入（可测余弦相似度排序）
 *  - embedding 失败自动回落关键词（边缘增强·失败回退）
 *  - 路由：GET /settings/catalog、POST /settings/search、空查询 400
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  SETTINGS_CATALOG,
  SETTING_SECTIONS,
  type SettingItem,
} from "../src/core/settings-catalog.js";
import { searchSettings, keywordScore } from "../src/core/settings-search.js";
import { handleSettingsCatalog, handleSettingsSearch } from "../src/routes/settings.js";
import type { RouteContext } from "../src/routes/types.js";

function fakeCtx(method: string, path: string, body?: unknown): RouteContext {
  return {
    url: new URL(`http://localhost${path}`),
    req: new Request(`http://localhost${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json" },
    }),
    baseHeaders: {},
    startupTime: Date.now(),
    jsonResponse: (data: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...extra },
      }),
  } as unknown as RouteContext;
}

// 简单确定性 embedding：按字符 hash 归一化到单位向量
function fakeEmbedder(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => {
      const vec = new Array<number>(8).fill(0);
      for (let i = 0; i < t.length; i++) {
        vec[i % 8] += (t.charCodeAt(i) % 16) + 1;
      }
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
      return vec.map((v) => v / norm);
    }),
  );
}

describe("设置目录完整性", () => {
  it("分区齐全且顺序稳定", () => {
    const ids = SETTING_SECTIONS.map((s) => s.id);
    expect(ids).toContain("appearance");
    expect(ids).toContain("behavior");
    expect(ids).toContain("data");
    expect(ids).toContain("models");
    expect(ids).toContain("agent");
    expect(ids).toContain("gateway");
    expect(ids).toContain("crawler");
  });

  it("条目 key 唯一，label/desc 为中文且非空", () => {
    const keys = SETTINGS_CATALOG.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of SETTINGS_CATALOG) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(10);
      expect(/[\u4e00-\u9fff]/.test(item.label)).toBe(true);
      expect(/[\u4e00-\u9fff]/.test(item.desc)).toBe(true);
      expect(Array.isArray(item.keywords)).toBe(true);
    }
  });

  it("覆盖 Agent 相关配置（1:1 映射）", () => {
    const keys = SETTINGS_CATALOG.map((i) => i.key);
    expect(keys).toContain("chat.showThinking");
    expect(keys).toContain("chat.expandFileChanges");
    expect(keys).toContain("chat.expandToolCalls");
    expect(keys).toContain("chat.autoAcceptPermissions");
    expect(keys).toContain("permissions.autoAccept");
  });

  it("相近设置项描述可区分（权限类）", () => {
    const chatItem = SETTINGS_CATALOG.find((i) => i.key === "chat.autoAcceptPermissions")!;
    const backendItem = SETTINGS_CATALOG.find((i) => i.key === "permissions.autoAccept")!;
    expect(chatItem.desc).not.toBe(backendItem.desc);
    // 双方都应在各自 desc 中说明"high-risk 始终确认"这一关键约束
    expect(chatItem.desc).toMatch(/high-risk|高风险|始终/);
    expect(backendItem.desc).toMatch(/high-risk|高风险|始终/);
  });
});

describe("关键词搜索", () => {
  it("「缓存」命中 data.cache 且排第一", async () => {
    const res = await searchSettings("缓存", { embedder: null });
    expect(res.engine).toBe("keyword");
    const top = res.results[0];
    expect(top.key).toBe("data.cache");
    expect(top.matchType).toBe("keyword");
  });

  it("「权限」同时命中会话偏好与后端权限模式", async () => {
    const res = await searchSettings("权限", { embedder: null });
    const keys = res.results.map((r) => r.key);
    expect(keys).toContain("chat.autoAcceptPermissions");
    expect(keys).toContain("permissions.autoAccept");
  });

  it("同义词「提醒」命中通知（近似描述精确化）", async () => {
    const res = await searchSettings("提醒", { embedder: null });
    const keys = res.results.map((r) => r.key);
    expect(keys).toContain("behavior.notifications");
  });
});

describe("语义搜索（注入 embedding）", () => {
  it("语义命中时 engine=semantic 且分数 0~1", async () => {
    const res = await searchSettings("想打开深色夜间模式", { embedder: fakeEmbedder });
    expect(res.engine).toBe("semantic");
    const top = res.results[0];
    expect(top.score).toBeGreaterThanOrEqual(0);
    expect(top.score).toBeLessThanOrEqual(1);
    expect(top.matchType).toBe("semantic");
  });

  it("embedding 失败自动回落关键词，不崩溃", async () => {
    const failing: typeof fakeEmbedder = async () => {
      throw new Error("embedding service down");
    };
    const res = await searchSettings("缓存", { embedder: failing });
    expect(res.engine).toBe("keyword");
    expect(res.results[0].key).toBe("data.cache");
  });
});

describe("路由", () => {
  beforeEach(() => {
    process.env.EDGE_SETTINGS_SEARCH = "0"; // 测试禁网络，走关键词
  });
  afterEach(() => {
    delete process.env.EDGE_SETTINGS_SEARCH;
  });

  it("GET /settings/catalog 返回 sections 与 items", async () => {
    const res = await handleSettingsCatalog(fakeCtx("GET", "/settings/catalog"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { sections: unknown[]; items: unknown[] };
    expect(Array.isArray(body.sections)).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(SETTINGS_CATALOG.length);
  });

  it("POST /settings/search 返回排序结果", async () => {
    const res = await handleSettingsSearch(
      fakeCtx("POST", "/settings/search", { q: "缓存" }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      query: string;
      engine: string;
      results: Array<{ key: string; score: number }>;
    };
    expect(body.query).toBe("缓存");
    expect(body.results[0].key).toBe("data.cache");
  });

  it("空查询返回 400", async () => {
    const res = await handleSettingsSearch(fakeCtx("POST", "/settings/search", { q: "  " }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it("路径不匹配返回 null", async () => {
    expect(await handleSettingsCatalog(fakeCtx("GET", "/other"))).toBeNull();
    expect(await handleSettingsSearch(fakeCtx("GET", "/other"))).toBeNull();
  });
});
