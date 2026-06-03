/**
 * Scene Router HTTP API
 * 
 * 提供 RESTful 接口用于场景驱动工具调用。
 * POST /mcp/scene — 执行场景
 * GET  /mcp/scenes — 列出所有场景
 * GET  /mcp/scenes/:id — 获取场景详情
 */

import type { RouteContext } from "../routes/types.js";
import { SceneRouter, DEFAULT_SCENES } from "../mcp/scene-router.js";
import { ToolRegistry } from "../mcp/tool-registry.js";

let sceneRouter: SceneRouter | null = null;

/** 初始化场景路由器（在 main.ts 中调用） */
export function initSceneRouter(registry: ToolRegistry): SceneRouter {
  sceneRouter = new SceneRouter(registry);
  sceneRouter.addScenes(DEFAULT_SCENES);
  return sceneRouter;
}

/** 获取当前场景路由器实例 */
export function getSceneRouter(): SceneRouter {
  if (!sceneRouter) {
    throw new Error("SceneRouter not initialized. Call initSceneRouter() first.");
  }
  return sceneRouter;
}

/** 处理 /mcp/* 路由 */
export async function handleSceneRoutes(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;

  // GET /mcp/scenes — 列出所有场景
  if (path === "/mcp/scenes" && ctx.req.method === "GET") {
    const router = getSceneRouter();
    return ctx.jsonResponse({ scenes: router.listScenes() }, 200, ctx.baseHeaders);
  }

  // POST /mcp/scene — 执行场景
  if (path === "/mcp/scene" && ctx.req.method === "POST") {
    let body: { input?: string; context?: Record<string, unknown> } = {};
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.jsonResponse({ error: "Invalid JSON body" }, 400, ctx.baseHeaders);
    }

    const input = body.input || "";
    if (!input) {
      return ctx.jsonResponse({ error: "Missing 'input' field" }, 400, ctx.baseHeaders);
    }

    const router = getSceneRouter();
    const result = await router.execute(input, body.context);
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  }

  // GET /mcp/scenes/:id — 场景详情（TODO: 可扩展）
  // if (path.match(/^\/mcp\/scenes\/\w+$/)) { ... }

  return null;
}
