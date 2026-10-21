import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "../../src/routes/types.js";
import { handleWebSearchSettings } from "../../src/routes/settings.js";
import { loadWebSearchConfig, loadWebSearchConfigWithRevision } from "../../src/crawl/web-search-config.js";
import { searchCache } from "../../src/utils/cache.js";

/**
 * P1（2026-10-22）路由级集成测试：/settings/web-search 的 GET(revision) + POST(If-Match/CAS/409)。
 * 通过 `handleWebSearchSettings(ctx, { configPath })` 注入**隔离临时配置**，不触碰仓库真实配置文件。
 */
let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-settings-route-"));
  cfgPath = join(dir, "web-search.yaml");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true }); // 测试自建临时目录（非仓库路径）
});
/** 最小 RouteContext 假体：handler 只消费 url / req / baseHeaders / jsonResponse。 */
function makeCtx(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): RouteContext {
  const url = new URL(`http://127.0.0.1:18789${path}`);
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const req = new Request(url, { method: init.method ?? "GET", headers: init.headers, body });
  return {
    url,
    req,
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  } as unknown as RouteContext;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await handleWebSearchSettings(
    makeCtx(path, { method: "POST", body, headers }),
    { configPath: cfgPath },
  );
  expect(res).not.toBeNull();
  return { status: res!.status, json: (await res!.json()) as Record<string, unknown> };
}

describe("POST /settings/web-search 乐观并发（隔离临时配置）", () => {
  test("GET 返回 revision，且与磁盘内容修订号一致", async () => {
    const res = await handleWebSearchSettings(makeCtx("/settings/web-search"), { configPath: cfgPath });
    expect(res!.status).toBe(200);
    const json = (await res!.json()) as Record<string, unknown>;
    expect(typeof json.revision).toBe("string");
    const { revision } = loadWebSearchConfigWithRevision(cfgPath);
    expect(json.revision).toBe(revision);
    expect((json.engines as unknown[]).length).toBeGreaterThan(0);
  });

  test("带正确 If-Match 保存成功，返回新 revision 且落盘生效", async () => {
    const { revision } = loadWebSearchConfigWithRevision(cfgPath);
    const { status, json } = await postJson(
      "/settings/web-search",
      { aggregate: { max_results: 20 } },
      { "if-match": `"${revision}"` },
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.revision).not.toBe(revision);
    expect(loadWebSearchConfig(cfgPath).aggregate.max_results).toBe(20);
  });

  test("过期 If-Match → 409 revision-conflict，且不覆盖别人的写入", async () => {
    const { revision } = loadWebSearchConfigWithRevision(cfgPath);
    // 模拟另一个窗口已保存
    const first = await postJson(
      "/settings/web-search",
      { aggregate: { max_results: 25 } },
      { "if-match": `"${revision}"` },
    );
    expect(first.status).toBe(200);
    const afterFirst = readFileSync(cfgPath, "utf-8");

    // 用旧 revision 再次保存 → 409
    const conflict = await postJson(
      "/settings/web-search",
      { aggregate: { max_results: 30 } },
      { "if-match": `"${revision}"` },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe("revision-conflict");
    expect(typeof conflict.json.revision).toBe("string");
    // 磁盘仍是第一次保存的值
    expect(readFileSync(cfgPath, "utf-8")).toBe(afterFirst);
    expect(loadWebSearchConfig(cfgPath).aggregate.max_results).toBe(25);
  });

  test("body.ifRevision 与 If-Match 等价；applied 明细回传", async () => {
    const { revision } = loadWebSearchConfigWithRevision(cfgPath);
    const { status, json } = await postJson("/settings/web-search", {
      ifRevision: revision,
      aggregate: { max_results: 12 },
    });
    expect(status).toBe(200);
    expect(json.applied).toContain("aggregate.max_results");
    expect(loadWebSearchConfig(cfgPath).aggregate.max_results).toBe(12);
  });

  test("未知字段被拒绝 → 400 invalid-patch，不写盘", async () => {
    const res = await postJson("/settings/web-search", {
      aggregate: { max_results: 12, unknown_knob: 1 },
      utterlyUnknown: true,
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid-patch");
    expect(loadWebSearchConfig(cfgPath).aggregate.max_results).toBe(10);
  });

  test("非法类型返回 400 invalid-patch，不写盘", async () => {
    const res = await postJson("/settings/web-search", { aggregate: { max_results: "not-a-number" } });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid-patch");
    // 非法值不得落盘：仍是默认值
    expect(loadWebSearchConfig(cfgPath).aggregate.max_results).toBe(10);
  });

  test("不带 If-Match 的旧客户端仍可保存（以服务端最新值为基线）", async () => {
    const { status, json } = await postJson("/settings/web-search", { aggregate: { max_results: 18 } });
    expect(status).toBe(200);
    expect(typeof json.revision).toBe("string");
    expect(loadWebSearchConfig(cfgPath).aggregate.max_results).toBe(18);
  });
  test("保存成功后清空搜索聚合缓存（P3/D5：改配置后不再读到旧查询结果）", async () => {
    searchCache.set("probe::router::default", [{ title: "旧结果" }], 60_000);
    expect(await searchCache.get("probe::router::default")).toBeDefined();
    const { status } = await postJson("/settings/web-search", { aggregate: { max_results: 16 } });
    expect(status).toBe(200);
    expect(await searchCache.get("probe::router::default")).toBeUndefined();
  });
});