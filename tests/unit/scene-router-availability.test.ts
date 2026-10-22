/**
 * P2.1：SceneRouter 可用性/失败语义 + /health 降级可见性
 *
 * 背景（本地未覆盖面审计 2026-10-22 #5）：网关 main.ts 把 SceneRouter 挂在只装插件/外部
 * MCP 的 registry 上，而 DEFAULT_SCENES 引用 git_status/fs_read 等 MCP 服务端工具 ⇒
 * 场景执行大面积 Tool not found，却仍以 HTTP 200 返回，看起来执行成功。
 *
 * 本文件的断言：
 *   - 预检（availableScenes / missingTools）真实反映 registry 能力；
 *   - 未匹配 → 404 `scene-not-matched`；工具缺失 → 409 `scene-tools-unavailable`（不再 200 假成功）；
 *   - 真实 registry 上注册齐全的场景确实执行成功（证明不是"改成永远失败"）；
 *   - /health 暴露 toolRuntime + sceneRouter 降级状态；
 *   - 静态接线门禁：main.ts 必须先注册真实工具再 initSceneRouter（防回退到空 registry）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SceneRouter, DEFAULT_SCENES } from "../../src/mcp/scene-router.js";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import {
  handleSceneRoutes,
  initSceneRouter,
  getSceneRouterPreflight,
} from "../../src/routes/scene-routes.js";
import { handleHealth } from "../../src/routes/health.js";
import type { RouteContext } from "../../src/routes/types.js";

const REPO = join(import.meta.dir, "..", "..");

function makeCtx(
  pathname: string,
  method: string,
  body?: unknown,
  healthMonitor?: unknown,
): RouteContext {
  const req = new Request(`https://example.com${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    url: new URL(req.url),
    req,
    vault: null,
    db: {} as never,
    pipeline: null,
    healthMonitor: (healthMonitor ?? { checkAll: async () => [] }) as never,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extra?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...(extra ?? {}) },
      }),
  } as unknown as RouteContext;
}

function emptySceneRouter(): SceneRouter {
  const router = new SceneRouter(new ToolRegistry());
  router.addScenes(DEFAULT_SCENES);
  return router;
}

describe("P2.1 SceneRouter：预检与 typed 失败码", () => {
  test("空 registry：预检 degraded，missingTools 含 git_status/fs_read，无可执行场景", () => {
    const router = emptySceneRouter();
    const status = router.getPreflightStatus();
    expect(status.degraded).toBe(true);
    expect(status.availableScenes).toBe(0);
    expect(status.missingTools).toContain("git_status");
    expect(status.missingTools).toContain("fs_read");
    expect(router.getAvailability().every((a) => !a.available)).toBe(true);
  });

  test("已匹配但工具缺失 → scene-tools-unavailable（不执行、不伪造成功）", async () => {
    const router = emptySceneRouter();
    const result = await router.execute("查看 git 状态");
    expect(result.code).toBe("scene-tools-unavailable");
    expect(result.degraded).toBe(true);
    expect(result.executed).toEqual([]);
    expect(result.missingTools).toContain("git_status");
  });

  test("未匹配 → scene-not-matched（不再用 200 + 空 executed 冒充成功）", async () => {
    const router = emptySceneRouter();
    const result = await router.execute("zzz-绝对不匹配任何场景-zzz");
    expect(result.code).toBe("scene-not-matched");
    expect(result.executed).toEqual([]);
    expect(result.degraded).toBe(true);
  });

  test("真实 registry（工具注册齐全）时场景确实执行成功", async () => {
    const registry = new ToolRegistry();
    registry.add({
      name: "git_status",
      capability: ["internal"],
      description: "probe",
      inputSchema: {},
      handler: async () => ({ ok: true }),
    });
    const router = new SceneRouter(registry);
    router.addScene({
      id: "probe_scene",
      name: "probe",
      description: "probe scene",
      match: ["probe-scene-input"],
      tools: ["git_status"],
    });
    const result = await router.execute("probe-scene-input");
    expect(result.code).toBeUndefined();
    expect(result.degraded).toBe(false);
    expect(result.executed[0]).toMatchObject({ tool: "git_status", success: true });
  });
});

describe("P2.1 SceneRouter 路由：404/409 语义与 /health 可见性", () => {
  test("POST /mcp/scene：缺失工具 → 409 + typed code；未匹配 → 404", async () => {
    initSceneRouter(new ToolRegistry()); // 空 registry，模拟缺工具的真实情况
    const unavailable = (await handleSceneRoutes(
      makeCtx("/mcp/scene", "POST", { input: "查看 git 状态" }),
    )) as Response;
    expect(unavailable.status).toBe(409);
    const body = (await unavailable.json()) as { code?: string; missingTools?: string[] };
    expect(body.code).toBe("scene-tools-unavailable");
    expect(body.missingTools).toContain("git_status");

    const unmatched = (await handleSceneRoutes(
      makeCtx("/mcp/scene", "POST", { input: "zzz-不匹配-zzz" }),
    )) as Response;
    expect(unmatched.status).toBe(404);
    expect(((await unmatched.json()) as { code?: string }).code).toBe("scene-not-matched");
  });

  test("GET /mcp/scenes：返回逐场景 availability 与 preflight", async () => {
    initSceneRouter(new ToolRegistry());
    const res = (await handleSceneRoutes(makeCtx("/mcp/scenes", "GET"))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scenes: unknown[];
      availability: Array<{ sceneId: string; available: boolean; missingTools: string[] }>;
      preflight: { degraded: boolean; missingTools: string[] };
    };
    expect(body.scenes.length).toBeGreaterThan(0);
    expect(body.availability.length).toBe(body.scenes.length);
    expect(body.preflight.degraded).toBe(true);
    expect(body.preflight.missingTools).toContain("fs_read");
  });

  test("/health 暴露 toolRuntime 与 sceneRouter 降级状态（不静默）", async () => {
    initSceneRouter(new ToolRegistry());
    const res = (await handleHealth(makeCtx("/health", "GET"))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      toolRuntime?: { degraded?: string[]; vault?: string; searchEngine?: string };
      sceneRouter?: { degraded?: boolean; missingTools?: string[] };
    };
    expect(body.toolRuntime).toBeDefined();
    expect(Array.isArray(body.toolRuntime!.degraded)).toBe(true);
    expect(body.sceneRouter).toBeDefined();
    expect(body.sceneRouter!.degraded).toBe(true);
    expect(body.sceneRouter!.missingTools).toContain("git_status");
    // 预检单例与路由暴露的应是同一份事实
    expect(getSceneRouterPreflight()?.degraded).toBe(true);
  });
});

describe("P2.1 静态接线门禁：main.ts 必须先装配真实工具再交给 SceneRouter", () => {
  test("main.ts：registerExternalTools + adaptTools 先于 initSceneRouter(gatewayToolRegistry)", () => {
    const src = readFileSync(join(REPO, "src", "main.ts"), "utf-8");
    const extIdx = src.indexOf("registerExternalTools(gatewayToolRegistry)");
    const adaptIdx = src.indexOf("adaptTools([readTool, writeTool, queryTool])");
    const sceneIdx = src.indexOf("initSceneRouter(gatewayToolRegistry)");
    expect(extIdx).toBeGreaterThan(-1);
    expect(adaptIdx).toBeGreaterThan(-1);
    expect(sceneIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeLessThan(sceneIdx);
    expect(adaptIdx).toBeLessThan(sceneIdx);
    // 回退到只装插件的空 registry 会重新引入"假成功"；这条静态门禁直接拦住
    expect(src).not.toContain("initSceneRouter(pluginToolRegistry)");
    // 启动期依赖校验必须真实调用（而不是只定义了函数）
    expect(src).toContain("probeToolRuntimeDeps(");
  });
});
