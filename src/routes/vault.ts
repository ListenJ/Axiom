/**
 * Vault and CodeGraph routes
 * 读操作经过 ReadOptimizerFacade (黑板 → 缓存 → 批量 → 字段投影)
 */
import type { RouteContext } from "./types.js";
import { getReadOptimizer } from "../utils/read-optimizer.js";
import { requireHttpConfirmation } from "./confirmation.js";
import { requireAuthToken, auditSuccess } from "./route-auth.js";

async function vaultRead(
  ctx: RouteContext,
  action: string,
  params: Record<string, unknown>,
  fields?: string[]
): Promise<unknown> {
  if (!ctx.vault) return null;
  const facade = getReadOptimizer();
  const res = await facade.read({
    resource: "vault",
    action,
    params,
    agentId: "vault-route",
    fields,
    cacheTtlMs: 30_000,
  });
  return res.data;
}

export async function handleVaultStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/stats" && ctx.req.method === "GET") {
    const data = await vaultRead(ctx, "stats", {});
    if (data === null) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    return ctx.jsonResponse(data, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultPara(ctx: RouteContext): Promise<Response | null> {
  // GET /vault/para — PARA 分类分布概览（前端 endpoints.vault.para 契约闭环）
  if (ctx.url.pathname === "/vault/para" && ctx.req.method === "GET") {
    const { vaultStatsCache } = await import("../utils/vault-stats-cache.js");
    return ctx.jsonResponse(
      { distribution: vaultStatsCache.read()?.paraDistribution ?? {} },
      200,
      ctx.baseHeaders
    );
  }
  if (ctx.url.pathname.startsWith("/vault/para/") && ctx.req.method === "GET") {
    const category = ctx.url.pathname.slice("/vault/para/".length);
    const data = await vaultRead(ctx, "browsePara", { category });
    if (data === null) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    return ctx.jsonResponse({ category, notes: data }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultTagsList(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/tags" && ctx.req.method === "GET") {
    // 容错：tags 可能为 NULL / 非 JSON / 表尚未迁移，一律优雅降级为空标签列表
    try {
      const rows = ctx.db.query(
        "SELECT DISTINCT json_each.value as tag FROM memory_notes, json_each(memory_notes.tags) " +
          "WHERE memory_notes.tags IS NOT NULL AND json_valid(memory_notes.tags) ORDER BY tag"
      ).all() as { tag: string }[];
      return ctx.jsonResponse({ tags: rows.map(r => r.tag) }, 200, ctx.baseHeaders);
    } catch {
      return ctx.jsonResponse({ tags: [] }, 200, ctx.baseHeaders);
    }
  }
  return null;
}

export async function handleVaultTags(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname.startsWith("/vault/tags/") && ctx.req.method === "GET") {
    const tag = decodeURIComponent(ctx.url.pathname.slice("/vault/tags/".length));
    const data = await vaultRead(ctx, "browseTag", { tag });
    if (data === null) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    return ctx.jsonResponse({ tag, notes: data }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultNetwork(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname.startsWith("/vault/network/") && ctx.req.method === "GET") {
    const notePath = decodeURIComponent(ctx.url.pathname.slice("/vault/network/".length));
    const depth = Number(ctx.url.searchParams.get("depth")) || 1;
    const data = await vaultRead(ctx, "getNetwork", { notePath, depth });
    if (data === null) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    return ctx.jsonResponse({ notePath, depth, ...(data as Record<string, unknown>) }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultNote(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/note" && ctx.req.method === "GET") {
    const notePath = ctx.url.searchParams.get("path");
    if (!notePath) return ctx.jsonResponse({ error: "Missing path param" }, 400, ctx.baseHeaders);
    const data = await vaultRead(ctx, "readNote", { notePath });
    if (data === null) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    if (!data) return ctx.jsonResponse({ error: "Note not found" }, 404, ctx.baseHeaders);
    return ctx.jsonResponse(data, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultWrite(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/write" && ctx.req.method === "POST") {
    const authErr = requireAuthToken(ctx);
    if (authErr) return authErr;
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const body = await ctx.req.json();
    const confirmErr = requireHttpConfirmation(ctx, "vault:write", body);
    if (confirmErr) return confirmErr;
    const { path: notePath, content, ...opts } = body;
    if (!notePath || !content) return ctx.jsonResponse({ error: "Missing path or content" }, 400, ctx.baseHeaders);
    const written = await ctx.vault.writeNote(notePath, content, opts);
    auditSuccess(ctx, "vault.write", notePath);
    return ctx.jsonResponse({ path: written }, 201, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultAtomic(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/atomic" && ctx.req.method === "POST") {
    const authErr = requireAuthToken(ctx);
    if (authErr) return authErr;
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const body = await ctx.req.json();
    const confirmErr = requireHttpConfirmation(ctx, "vault:atomic", body);
    if (confirmErr) return confirmErr;
    const { title, idea, ...opts } = body;
    if (!title || !idea) return ctx.jsonResponse({ error: "Missing title or idea" }, 400, ctx.baseHeaders);
    const path = await ctx.vault.writeAtomicNote(title, idea, opts);
    auditSuccess(ctx, "vault.write", path);
    return ctx.jsonResponse({ path, title }, 201, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultCodeIndex(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/code-index" && ctx.req.method === "POST") {
    const authErr = requireAuthToken(ctx);
    if (authErr) return authErr;
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const confirmErr = requireHttpConfirmation(ctx, "vault:code-index");
    if (confirmErr) return confirmErr;
    const result = await ctx.vault.indexCode();
    auditSuccess(ctx, "vault.write", "code-index");
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultReload(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/reload" && ctx.req.method === "POST") {
    const authErr = requireAuthToken(ctx);
    if (authErr) return authErr;
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const confirmErr = requireHttpConfirmation(ctx, "vault:reload");
    if (confirmErr) return confirmErr;
    ctx.vault.reload();
    auditSuccess(ctx, "vault.write", "reload");
    return ctx.jsonResponse({ ok: true }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultWatchStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/watch-status" && ctx.req.method === "GET") {
    return ctx.jsonResponse({
      watching: ctx.fileWatcher?.isWatching ?? false,
      watchedDirectories: ctx.fileWatcher?.watchedCount ?? 0,
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultDistill(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/distill" && ctx.req.method === "POST") {
    const authErr = requireAuthToken(ctx);
    if (authErr) return authErr;
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const body = await ctx.req.json();
    const confirmErr = requireHttpConfirmation(ctx, "vault:distill", body);
    if (confirmErr) return confirmErr;
    const { getConfig } = await import("../core/config-center.js");
    const { MemoryDistiller } = await import("../memory/distiller.js");
    const config = getConfig();
    const distiller = new MemoryDistiller(config.memory.vaultPath);
    const created = await distiller.distillManual(body.title, body.content, {
      source: body.source || "manual",
      sourceType: body.sourceType || "manual",
      tags: body.tags,
      relatedNotes: body.relatedNotes,
    });
    auditSuccess(ctx, "vault.write", created);
    return ctx.jsonResponse({ created }, 201, ctx.baseHeaders);
  }
  return null;
}

export async function handleBootstrap(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/bootstrap" && ctx.req.method === "GET") {
    const confirmErr = requireHttpConfirmation(ctx, "bootstrap:run");
    if (confirmErr) return confirmErr;
    const { getConfig } = await import("../core/config-center.js");
    const { AgentBootstrap } = await import("../memory/bootstrap.js");
    const config = getConfig();
    const bootstrap = new AgentBootstrap(config.memory.vaultPath);
    const topic = ctx.url.searchParams.get("topic") || "";
    const depth = Number(ctx.url.searchParams.get("depth")) || 5;
    const context = await bootstrap.run({ topic, memoryDepth: depth });
    const format = ctx.url.searchParams.get("format") || "json";
    if (format === "prompt") {
      const { createCorsHeaders } = await import("../utils/security.js");
      return new Response(bootstrap.toSystemPrompt(context), {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...createCorsHeaders() },
      });
    }
    return ctx.jsonResponse(context, 200, ctx.baseHeaders);
  }
  return null;
}

// === CodeGraph ===

export async function handleCodegraphSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/codegraph/search" && ctx.req.method === "GET") {
    const query = ctx.url.searchParams.get("q");
    if (!query) return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);
    const { retrieveCodeMemory } = await import("../memory/codegraph-index.js");
    const result = await retrieveCodeMemory(query);
    return ctx.jsonResponse(
      result ?? { error: "CodeGraph not initialized or no results" },
      result ? 200 : 404,
      ctx.baseHeaders
    );
  }
  return null;
}

export async function handleCodegraphInit(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/codegraph/init" && ctx.req.method === "POST") {
    const confirmErr = requireHttpConfirmation(ctx, "codegraph:init");
    if (confirmErr) return confirmErr;
    const { initializeCodegraph, getStatus } = await import("../memory/codegraph-index.js");
    await initializeCodegraph();
    const status = await getStatus();
    return ctx.jsonResponse(status ?? { ok: true }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleCodegraphStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/codegraph/status" && ctx.req.method === "GET") {
    const { getStatus } = await import("../memory/codegraph-index.js");
    const status = await getStatus();
    return ctx.jsonResponse(status ?? { initialized: false }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleCodegraphFileIndex(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/file-index" && ctx.req.method === "GET") {
    const { searchFiles, isCodegraphInitialized } = await import("../memory/codegraph-index.js");
    if (!(await isCodegraphInitialized())) {
      return ctx.jsonResponse({ files: [] }, 200, ctx.baseHeaders);
    }
    const files = await searchFiles("*", { limit: 5000 });
    return ctx.jsonResponse({ files: files.map((f) => f.path) }, 200, ctx.baseHeaders);
  }
  return null;
}
