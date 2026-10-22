/**
 * Scene Router HTTP API
 *
 * 提供 RESTful 接口用于场景驱动工具调用。
 * POST /mcp/scene — 执行场景
 * GET  /mcp/scenes — 列出所有场景
 * GET  /mcp/scenes/:id — 获取场景详情
 *
 * P2.1（2026-10-22）：注入的 registry 必须是**真实工具注册表**（含外部工具与 pipeline 适配工具），
 * 否则 DEFAULT_SCENES 引用的 git_status/fs_read 等全部缺失。缺失时：启动期 typed 告警；
 * `/mcp/scenes` 暴露逐场景 availability；`/mcp/scene` 返回 404/409 而不是 200 假成功。
 */

import type { RouteContext } from "../routes/types.js";
import { SceneRouter, DEFAULT_SCENES, type ScenePreflightStatus } from "../mcp/scene-router.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import { logger } from "../utils/logger.js";

let sceneRouter: SceneRouter | null = null;

/** 初始化场景路由器（在 main.ts 中调用；registry 必须是装配了真实工具的那一份） */
export function initSceneRouter(registry: ToolRegistry): SceneRouter {
  sceneRouter = new SceneRouter(registry);
  sceneRouter.addScenes(DEFAULT_SCENES);
  const preflight = sceneRouter.getPreflightStatus();
  if (preflight.degraded) {
    // 不静默：缺工具的场景在这份 registry 上跑不起来，启动即告警（/health 同步可见）
    logger.warn("[SceneRouter] 场景工具缺失（启动预检降级）", {
      code: "scene-tools-unavailable",
      totalScenes: preflight.totalScenes,
      availableScenes: preflight.availableScenes,
      missingToolCount: preflight.missingTools.length,
      missingTools: preflight.missingTools.slice(0, 20),
    });
  } else {
    logger.debug("[SceneRouter] Initialized", {
      scenes: preflight.totalScenes,
      availableScenes: preflight.availableScenes,
    });
  }
  return sceneRouter;
}

/** 获取当前场景路由器实例 */
export function getSceneRouter(): SceneRouter {
  if (!sceneRouter) {
    throw new Error("SceneRouter not initialized. Call initSceneRouter() first.");
  }
  return sceneRouter;
}

/** 场景路由预检状态（未初始化返回 null；供 /health 使用）。 */
export function getSceneRouterPreflight(): ScenePreflightStatus | null {
  if (!sceneRouter) return null;
  return sceneRouter.getPreflightStatus();
}

/** 处理 /mcp/* 路由 */
export async function handleSceneRoutes(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;

  // GET /mcp/scenes — 列出所有场景（附带逐场景可用性；P2.1）
  if (path === "/mcp/scenes" && ctx.req.method === "GET") {
    const router = getSceneRouter();
    return ctx.jsonResponse(
      {
        scenes: router.listScenes(),
        availability: router.getAvailability(),
        preflight: router.getPreflightStatus(),
      },
      200,
      ctx.baseHeaders,
    );
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
    // P2.1：未匹配 → 404；工具缺失 → 409（typed code 已在 result 中）；正常 → 200
    if (result.code === "scene-not-matched") {
      return ctx.jsonResponse(result, 404, ctx.baseHeaders);
    }
    if (result.code === "scene-tools-unavailable") {
      return ctx.jsonResponse(result, 409, ctx.baseHeaders);
    }
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  }

  // GET /mcp/scenes/:id — 场景详情
  const sceneDetailMatch = path.match(/^\/mcp\/scenes\/([\w-]+)$/);
  if (sceneDetailMatch && ctx.req.method === "GET") {
    const sceneId = sceneDetailMatch[1];
    const router = getSceneRouter();
    const scene = router.getScene(sceneId);
    if (!scene) {
      return ctx.jsonResponse({ error: `Scene '${sceneId}' not found` }, 404, ctx.baseHeaders);
    }
    const availability = router.getAvailability().find((a) => a.sceneId === sceneId);
    return ctx.jsonResponse({
      id: scene.id,
      name: scene.name,
      description: scene.description,
      tools: scene.tools,
      parallel: scene.parallel ?? false,
      priority: scene.priority ?? 0,
      match: Array.isArray(scene.match) ? scene.match : "[custom matcher]",
      availability,
    }, 200, ctx.baseHeaders);
  }

  return null;
}
