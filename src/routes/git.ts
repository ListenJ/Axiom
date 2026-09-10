/**
 * Git service routes — exposes git operations as HTTP API.
 * Allows users to perform git commit/push/status from the frontend.
 */
import type { RouteContext, RouteHandler } from "./types.js";
import { readString } from "../utils/env.js";
import {
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitCommit,
  gitPush,
} from "../mcp/tools/git.js";
import { safeStringEqual } from "../utils/auth-check.js";

/**
 * 二因素写保护（审计 S1，2026-08-25）：AXIOM_SECOND_FACTOR_TOKEN 未配置时
 * 放行（fail-open，与 sandbox.ts requireAuthToken 调用语义一致）；
 * 配置后不匹配 → 403。
 */
function requireSecondFactorToken(ctx: RouteContext): Response | null {
  const expected = readString("AXIOM_SECOND_FACTOR_TOKEN");
  if (!expected) return null;
  const provided =
    ctx.req.headers.get("x-api-key") ||
    ctx.req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (safeStringEqual(provided, expected)) return null;
  return ctx.jsonResponse(
    { error: "Unauthorized - second factor token required" },
    403,
    ctx.baseHeaders,
  );
}

/** Default repo path — the project root */
const REPO_PATH = ".";

/** GET /api/git/status — working tree status */
async function handleGitStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.req.method !== "GET") return null;
  if (ctx.url.pathname !== "/api/git/status") return null;

  const result = await gitStatus(REPO_PATH);
  return ctx.jsonResponse(result, result.success ? 200 : 500, ctx.baseHeaders);
}

/** GET /api/git/diff — diff (supports ?staged=true&file=xxx) */
async function handleGitDiff(ctx: RouteContext): Promise<Response | null> {
  if (ctx.req.method !== "GET") return null;
  if (ctx.url.pathname !== "/api/git/diff") return null;

  const staged = ctx.url.searchParams.get("staged") === "true";
  const file = ctx.url.searchParams.get("file") || undefined;

  const result = await gitDiff(REPO_PATH, { staged, file });
  return ctx.jsonResponse(result, result.success ? 200 : 500, ctx.baseHeaders);
}

/** GET /api/git/log — commit history (supports ?maxCount=N) */
async function handleGitLog(ctx: RouteContext): Promise<Response | null> {
  if (ctx.req.method !== "GET") return null;
  if (ctx.url.pathname !== "/api/git/log") return null;

  const maxCount = parseInt(ctx.url.searchParams.get("maxCount") || "20", 10);

  const result = await gitLog(REPO_PATH, { maxCount });
  return ctx.jsonResponse(result, result.success ? 200 : 500, ctx.baseHeaders);
}

/** GET /api/git/branch — list branches */
async function handleGitBranch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.req.method !== "GET") return null;
  if (ctx.url.pathname !== "/api/git/branch") return null;

  const result = await gitBranch(REPO_PATH);
  return ctx.jsonResponse(result, result.success ? 200 : 500, ctx.baseHeaders);
}

/** POST /api/git/commit — stage + commit (body: { message, files? }) */
async function handleGitCommit(ctx: RouteContext): Promise<Response | null> {
  if (ctx.req.method !== "POST") return null;
  if (ctx.url.pathname !== "/api/git/commit") return null;
  const authErr = requireSecondFactorToken(ctx);
  if (authErr) return authErr;

  let body: { message?: string; files?: string[] };
  try {
    body = await ctx.req.json();
  } catch {
    return ctx.jsonResponse({ success: false, error: "invalid JSON body" }, 400, ctx.baseHeaders);
  }

  if (!body.message || !body.message.trim()) {
    return ctx.jsonResponse(
      { success: false, error: "message is required" },
      400,
      ctx.baseHeaders
    );
  }

  const result = await gitCommit(REPO_PATH, body.message, body.files);
  return ctx.jsonResponse(result, result.success ? 200 : 500, ctx.baseHeaders);
}

/** POST /api/git/push — push to remote (body: { remote?, branch?, force? }) */
async function handleGitPush(ctx: RouteContext): Promise<Response | null> {
  if (ctx.req.method !== "POST") return null;
  if (ctx.url.pathname !== "/api/git/push") return null;
  const authErr = requireSecondFactorToken(ctx);
  if (authErr) return authErr;

  let body: { remote?: string; branch?: string; force?: boolean };
  try {
    body = await ctx.req.json();
  } catch {
    return ctx.jsonResponse({ success: false, error: "invalid JSON body" }, 400, ctx.baseHeaders);
  }

  const result = await gitPush(REPO_PATH, {
    remote: body.remote,
    branch: body.branch,
    force: body.force,
  });
  return ctx.jsonResponse(result, result.success ? 200 : 500, ctx.baseHeaders);
}

/** Exported handler — tries all git routes, returns first match */
export const handleGitRoutes: RouteHandler = async (ctx: RouteContext): Promise<Response | null> => {
  if (!ctx.url.pathname.startsWith("/api/git/")) return null;
  return (
    (await handleGitStatus(ctx)) ||
    (await handleGitDiff(ctx)) ||
    (await handleGitLog(ctx)) ||
    (await handleGitBranch(ctx)) ||
    (await handleGitCommit(ctx)) ||
    (await handleGitPush(ctx)) ||
    null
  );
};
