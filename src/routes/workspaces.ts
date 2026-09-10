/**
 * Workspace routes — current project workspace summary for the frontend sidebar.
 *
 * GET /api/workspaces 返回当前仓库工作区 + Git 分支/clean 状态 + 会话数。
 * 当前实现为单工作区（项目根），字段形状为未来多工作区预留。
 */
import path from "node:path";
import type { RouteContext, RouteHandler } from "./types.js";
import { gitStatus } from "../mcp/tools/git.js";
import { logger } from "../utils/logger.js";

const REPO_PATH = ".";

/** GET /api/workspaces — list workspaces with branch and session count */
export const handleWorkspaces: RouteHandler = async (ctx: RouteContext): Promise<Response | null> => {
  if (ctx.req.method !== "GET") return null;
  if (ctx.url.pathname !== "/api/workspaces") return null;

  const root = path.resolve(REPO_PATH);
  const git = await gitStatus(REPO_PATH);

  let sessionCount = 0;
  try {
    const row = ctx.db
      .query(`SELECT COUNT(*) as session_count FROM conversations`)
      .get() as { session_count: number } | null;
    sessionCount = row?.session_count ?? 0;
  } catch (err) {
    logger.error("Failed to count sessions for workspace", err as Error);
    return ctx.jsonResponse({ error: "Failed to load workspace sessions" }, 500, ctx.baseHeaders);
  }

  const workspaces = [
    {
      id: `ws-${Buffer.from(root).toString("hex").slice(0, 12)}`,
      name: path.basename(root) || root,
      path: root,
      branch: git.branch ?? "unknown",
      clean: git.clean ?? false,
      sessionCount,
    },
  ];
  return ctx.jsonResponse({ workspaces }, 200, ctx.baseHeaders);
};
