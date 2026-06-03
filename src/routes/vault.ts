/**
 * Vault and CodeGraph routes
 */
import type { RouteContext } from "./types.js";

export async function handleVaultStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/stats" && ctx.req.method === "GET") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    return ctx.jsonResponse(ctx.vault.stats(), 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultPara(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname.startsWith("/vault/para/") && ctx.req.method === "GET") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const category = ctx.url.pathname.slice("/vault/para/".length);
    const notes = ctx.vault.browsePara(category);
    return ctx.jsonResponse({ category, notes }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultTags(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname.startsWith("/vault/tags/") && ctx.req.method === "GET") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const tag = decodeURIComponent(ctx.url.pathname.slice("/vault/tags/".length));
    const notes = ctx.vault.browseTag(tag);
    return ctx.jsonResponse({ tag, notes }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultNetwork(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname.startsWith("/vault/network/") && ctx.req.method === "GET") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const notePath = decodeURIComponent(ctx.url.pathname.slice("/vault/network/".length));
    const depth = Number(ctx.url.searchParams.get("depth")) || 1;
    const network = ctx.vault.getNetwork(notePath, depth);
    return ctx.jsonResponse({ notePath, depth, ...network }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultNote(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/note" && ctx.req.method === "GET") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const notePath = ctx.url.searchParams.get("path");
    if (!notePath) return ctx.jsonResponse({ error: "Missing path param" }, 400, ctx.baseHeaders);
    const note = ctx.vault.readNote(notePath);
    if (!note) return ctx.jsonResponse({ error: "Note not found" }, 404, ctx.baseHeaders);
    return ctx.jsonResponse({ path: notePath, ...note }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultWrite(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/write" && ctx.req.method === "POST") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const body = await ctx.req.json();
    const { path: notePath, content, ...opts } = body;
    if (!notePath || !content) return ctx.jsonResponse({ error: "Missing path or content" }, 400, ctx.baseHeaders);
    const written = await ctx.vault.writeNote(notePath, content, opts);
    return ctx.jsonResponse({ path: written }, 201, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultAtomic(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/atomic" && ctx.req.method === "POST") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const body = await ctx.req.json();
    const { title, idea, ...opts } = body;
    if (!title || !idea) return ctx.jsonResponse({ error: "Missing title or idea" }, 400, ctx.baseHeaders);
    const path = await ctx.vault.writeAtomicNote(title, idea, opts);
    return ctx.jsonResponse({ path, title }, 201, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultCodeIndex(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/code-index" && ctx.req.method === "POST") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const result = await ctx.vault.indexCode();
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleVaultReload(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/vault/reload" && ctx.req.method === "POST") {
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    ctx.vault.reload();
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
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
    const { getConfig } = await import("../utils/config.js");
    const { MemoryDistiller } = await import("../memory/distiller.js");
    const config = getConfig();
    const body = await ctx.req.json();
    const distiller = new MemoryDistiller(config.memory.vaultPath);
    const created = await distiller.distillManual(body.title, body.content, {
      source: body.source || "manual",
      sourceType: body.sourceType || "manual",
      tags: body.tags,
      relatedNotes: body.relatedNotes,
    });
    return ctx.jsonResponse({ created }, 201, ctx.baseHeaders);
  }
  return null;
}

export async function handleBootstrap(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/bootstrap" && ctx.req.method === "GET") {
    const { getConfig } = await import("../utils/config.js");
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
