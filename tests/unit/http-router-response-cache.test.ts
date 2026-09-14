import { describe, it, expect } from "bun:test";
import { HttpRouter } from "../../src/core/http-router.js";
import type { RouteContext } from "../../src/routes/types.js";

/**
 * 回归测试：缓存的 Response 必须可重复发送（TDD RED → GREEN）
 *
 * 缺陷（来自第三方审计，Axiom 侧已修、本仓库仍活跃）：
 * `execute()` 把 handler 返回的 Response **对象本身**存入缓存，命中时又把同一个
 * 对象返回。而 `Response` 的 body 是**一次性流**：首次 `.text()` / 发送后即被消费，
 * 再次发送同一个对象会抛 `TypeError: Body already used`。
 *
 * 影响路径：`main.ts` 用 `httpRouter.execute()` 作为主请求路径，catch 块把异常
 * 转成 500 ⇒ **同一 GET 路径在 TTL(默认 30s) 内的第二次请求必然 500**。
 * 触发条件极宽：GET + status<400 + 路由未显式 `cacheable: false`（无路由设置该项）。
 *
 * 断言的是**对外可观察行为**（两次请求都能读到 body），不是内部实现 ——
 * 无论修复用 clone 还是别的方式，只要行为正确就通过。
 */

/** 构造路由执行所需的最小上下文（router 只读 req/url/jsonResponse） */
function makeCtx(method: string, path: string): RouteContext {
  return {
    req: new Request(`http://localhost${path}`, { method }),
    url: new URL(`http://localhost${path}`),
    jsonResponse: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as RouteContext;
}

describe("HttpRouter 缓存的 Response 可重复发送", () => {
  it("同一 GET 路径连续请求：每次都返回 200 且 body 可读（TTL 内命中缓存）", async () => {
    const router = new HttpRouter();
    let handlerCalls = 0;
    router.register({
      method: "GET",
      path: "/health",
      handler: async (ctx) => {
        handlerCalls++;
        return ctx.jsonResponse({ ok: true, run: handlerCalls });
      },
      meta: { description: "health" },
    });

    // 第 1 次：缓存未命中 → 执行 handler → 写入缓存
    const first = await router.execute(makeCtx("GET", "/health"));
    expect(first).not.toBeNull();
    expect(first!.status).toBe(200);
    await expect(first!.text()).resolves.toContain('"run":1');

    // 第 2 次：命中缓存 → 若缓存的是已被消费的同一 Response 对象，此处会抛
    //         TypeError: Body already used
    const second = await router.execute(makeCtx("GET", "/health"));
    expect(second).not.toBeNull();
    expect(second!.status).toBe(200);
    await expect(second!.text()).resolves.toContain('"ok":true');

    // 第 3 次：继续命中，仍须可读（防止"只 clone 第一次"的半修）
    const third = await router.execute(makeCtx("GET", "/health"));
    expect(third).not.toBeNull();
    await expect(third!.text()).resolves.toContain('"ok":true');

    // handler 只应执行一次：三次请求 = 1 次 miss + 2 次 hit
    expect(handlerCalls).toBe(1);
    expect(router.getPerfReport()["GET /health"].cacheHits).toBe(2);
  });

  it("命中缓存的响应 body 内容与首次一致（不是空 body 或残缺）", async () => {
    const router = new HttpRouter();
    router.register({
      method: "GET",
      path: "/stats",
      handler: async (ctx) => ctx.jsonResponse({ uptime: 42, nested: { a: [1, 2, 3] } }),
    });

    const first = await router.execute(makeCtx("GET", "/stats"));
    const firstBody = await first!.text();

    const second = await router.execute(makeCtx("GET", "/stats"));
    const secondBody = await second!.text();

    expect(secondBody).toBe(firstBody);
    expect(JSON.parse(secondBody)).toEqual({ uptime: 42, nested: { a: [1, 2, 3] } });
  });

  it("不同路径各自独立缓存，互不串味", async () => {
    const router = new HttpRouter();
    router.register({ method: "GET", path: "/a", handler: async (ctx) => ctx.jsonResponse({ p: "a" }) });
    router.register({ method: "GET", path: "/b", handler: async (ctx) => ctx.jsonResponse({ p: "b" }) });

    const a1 = await router.execute(makeCtx("GET", "/a"));
    const b1 = await router.execute(makeCtx("GET", "/b"));
    const a2 = await router.execute(makeCtx("GET", "/a"));

    expect(JSON.parse(await a1!.text())).toEqual({ p: "a" });
    expect(JSON.parse(await b1!.text())).toEqual({ p: "b" });
    expect(JSON.parse(await a2!.text())).toEqual({ p: "a" });
  });

  it("不可缓存路由（cacheable:false）每次执行 handler，且响应始终可读", async () => {
    const router = new HttpRouter();
    let calls = 0;
    router.register({
      method: "GET",
      path: "/live",
      handler: async (ctx) => {
        calls++;
        return ctx.jsonResponse({ n: calls });
      },
      meta: { cacheable: false },
    });

    const r1 = await router.execute(makeCtx("GET", "/live"));
    const r2 = await router.execute(makeCtx("GET", "/live"));
    expect(JSON.parse(await r1!.text())).toEqual({ n: 1 });
    expect(JSON.parse(await r2!.text())).toEqual({ n: 2 });
    expect(calls).toBe(2);
  });
});
