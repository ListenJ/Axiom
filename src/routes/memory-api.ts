/**
 * Cross-session Memory API
 * 
 * Provides unified access to conversation history, knowledge, and tasks
 * across sessions. Supports cross-table joins between SQLite databases.
 */
import type { RouteContext, RouteHandler } from "./types.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { getSessionMessages } from "../db/session-store.js";
import { getSessionLineage, searchSessionLineage } from "../db/session-lineage.js";
import { getTokenTracker } from "../router/token-tracker.js";

// ===== Conversation History (Server-side persistence) =====

/** POST /memory/conversations — Save a conversation message to server */
export async function handleSaveConversation(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/conversations" || ctx.req.method !== "POST") return null;
  
  const body = await ctx.req.json().catch(() => ({}));
  const { sessionId, role, content, agentId, toolCalls, toolResults, tokensUsed, latencyMs } = body;
  
  if (!sessionId || !role || !content) {
    return ctx.jsonResponse({ error: "sessionId, role, and content are required" }, 400, ctx.baseHeaders);
  }

  try {
    ctx.db.run(
      `INSERT INTO conversations (session_id, role, content, agent_id, tool_calls, tool_results, tokens_used, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId, role, content, agentId || "default",
      toolCalls ? JSON.stringify(toolCalls) : null,
      toolResults ? JSON.stringify(toolResults) : null,
      tokensUsed || 0, latencyMs || 0, Math.floor(Date.now() / 1000)
    );
    return ctx.jsonResponse({ ok: true, sessionId }, 201, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to save conversation", err as Error);
    return ctx.jsonResponse({ error: "Failed to save conversation" }, 500, ctx.baseHeaders);
  }
}

/** GET /memory/conversations?session=X&limit=50 — Get conversation history */
export async function handleGetConversations(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/conversations" || ctx.req.method !== "GET") return null;
  
  const sessionId = ctx.url.searchParams.get("session");
  const limit = Math.min(parseInt(ctx.url.searchParams.get("limit") || "50", 10), 500);
  const offset = parseInt(ctx.url.searchParams.get("offset") || "0", 10);

  try {
    let messages;
    if (sessionId) {
      messages = ctx.db.query(
        `SELECT id, session_id, role, content, agent_id, tool_calls, tool_results, tokens_used, latency_ms, created_at
         FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`
      ).all(sessionId, limit, offset);
    } else {
      // List recent sessions with counts
      messages = ctx.db.query(
        `SELECT session_id, COUNT(*) as message_count, MIN(created_at) as started, MAX(created_at) as last_active
         FROM conversations GROUP BY session_id ORDER BY last_active DESC LIMIT ? OFFSET ?`
      ).all(limit, offset);
    }
    return ctx.jsonResponse({ messages, count: messages.length }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to get conversations", err as Error);
    return ctx.jsonResponse({ error: "Failed to get conversations" }, 500, ctx.baseHeaders);
  }
}

/** GET /memory/sessions — List all sessions with metadata */
export async function handleListSessions(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/sessions" || ctx.req.method !== "GET") return null;

  try {
    const sessions = ctx.db.query(
      `SELECT 
         c.session_id,
         COALESCE(s.title, '') as title,
         COUNT(*) as message_count,
         SUM(CASE WHEN c.role = 'user' THEN 1 ELSE 0 END) as user_messages,
         SUM(CASE WHEN c.role = 'assistant' THEN 1 ELSE 0 END) as assistant_messages,
         SUM(c.tokens_used) as total_tokens,
         MIN(c.created_at) as started_at,
         MAX(c.created_at) as last_active
       FROM conversations c
       LEFT JOIN chat_sessions s ON s.session_id = c.session_id
       GROUP BY c.session_id, s.title
       ORDER BY last_active DESC
       LIMIT 100`
    ).all();
    return ctx.jsonResponse({ sessions }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to list sessions", err as Error);
    return ctx.jsonResponse({ error: "Failed to list sessions" }, 500, ctx.baseHeaders);
  }
}

/**
 * PATCH /chat/sessions/:id — 重命名会话（持久化到 chat_sessions 表，upsert）
 */
export async function handleRenameSession(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/chat/sessions" && !ctx.url.pathname.startsWith("/chat/sessions/")) return null;
  if (ctx.req.method !== "PATCH") return null;

  const sessionId = ctx.url.pathname.replace("/chat/sessions/", "");
  if (!sessionId) {
    return ctx.jsonResponse({ error: "session id required" }, 400, ctx.baseHeaders);
  }

  const body = (await ctx.req.json().catch(() => ({}))) as { title?: unknown };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return ctx.jsonResponse({ error: "title is required" }, 400, ctx.baseHeaders);
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    ctx.db.query(
      `INSERT INTO chat_sessions (session_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
    ).run(sessionId, title, now, now);
    return ctx.jsonResponse({ ok: true, sessionId, title }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to rename session", err as Error);
    return ctx.jsonResponse({ error: "Failed to rename session" }, 500, ctx.baseHeaders);
  }
}

/**
 * DELETE /chat/sessions/:id — 删除会话（chat_sessions 元数据 + conversations 消息）
 * 破坏性操作：需一次性确认码（x-confirmation-id header，见 confirmation.ts）
 */
export async function handleDeleteSession(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/chat/sessions" && !ctx.url.pathname.startsWith("/chat/sessions/")) return null;
  if (ctx.req.method !== "DELETE") return null;

  const sessionId = ctx.url.pathname.replace("/chat/sessions/", "");
  if (!sessionId) {
    return ctx.jsonResponse({ error: "session id required" }, 400, ctx.baseHeaders);
  }

  const { requireHttpConfirmation } = await import("./confirmation.js");
  const confirmErr = requireHttpConfirmation(ctx, "chat:session-delete");
  if (confirmErr) return confirmErr;

  try {
    ctx.db.query("DELETE FROM chat_sessions WHERE session_id = ?").run(sessionId);
    const removed = ctx.db.query("DELETE FROM conversations WHERE session_id = ?").run(sessionId);
    return ctx.jsonResponse(
      { ok: true, sessionId, removedMessages: Number(removed.changes) },
      200,
      ctx.baseHeaders,
    );
  } catch (err) {
    logger.error("Failed to delete session", err as Error);
    return ctx.jsonResponse({ error: "Failed to delete session" }, 500, ctx.baseHeaders);
  }
}

// ===== Cross-table Knowledge Query =====

/** GET /memory/knowledge?q=X&type=X&tier=X — Unified knowledge search across tables */
export async function handleKnowledgeSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/knowledge" || ctx.req.method !== "GET") return null;

  const query = ctx.url.searchParams.get("q") || "";
  const type = ctx.url.searchParams.get("type"); // knowledge, entity, note
  const tier = ctx.url.searchParams.get("tier"); // episodic, semantic, project, procedural
  const limit = Math.min(parseInt(ctx.url.searchParams.get("limit") || "20", 10), 100);

  try {
    const results: { knowledge: unknown[]; entities: unknown[]; notes: unknown[] } = { knowledge: [], entities: [], notes: [] };

    // Search knowledge table
    if (!type || type === "knowledge") {
      let sql = `SELECT id, tier, topic_key as title, content, confidence, access_count, created_at FROM knowledge WHERE 1=1`;
      const params: (string | number)[] = [];
      if (query) { sql += ` AND (topic_key LIKE ? OR content LIKE ?)`; params.push(`%${query}%`, `%${query}%`); }
      if (tier) { sql += ` AND tier = ?`; params.push(tier); }
      sql += ` ORDER BY confidence DESC, access_count DESC LIMIT ?`;
      params.push(limit);
      results.knowledge = ctx.db.query(sql).all(...params);
    }

    // Search entities (knowledge graph)
    if (!type || type === "entity") {
      let sql = `SELECT id, name, type, properties, created_at FROM entities WHERE 1=1`;
      const params: (string | number)[] = [];
      if (query) { sql += ` AND (name LIKE ? OR properties LIKE ?)`; params.push(`%${query}%`, `%${query}%`); }
      if (type && type !== "entity") { sql += ` AND type = ?`; params.push(type); }
      sql += ` ORDER BY name LIMIT ?`;
      params.push(limit);
      results.entities = ctx.db.query(sql).all(...params);
    }

    // Search vault notes (cross-database: axiom-memory.db)
    if (!type || type === "note") {
      try {
        const { Database } = await import("bun:sqlite");
        const memDb = new Database("./axiom-memory.db", { readonly: true });
        let sql = `SELECT id, path, title, excerpt, score FROM memory_notes WHERE 1=1`;
        const params: (string | number)[] = [];
        if (query) { sql += ` AND (title LIKE ? OR content LIKE ?)`; params.push(`%${query}%`, `%${query}%`); }
        sql += ` ORDER BY score DESC LIMIT ?`;
        params.push(limit);
        results.notes = memDb.query(sql).all(...params);
        memDb.close();
      } catch {
        // Memory DB may not exist yet
        results.notes = [];
      }
    }

    const totalResults = results.knowledge.length + results.entities.length + results.notes.length;
    return ctx.jsonResponse({ ...results, totalResults }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Knowledge search failed", err as Error);
    return ctx.jsonResponse({ error: "Knowledge search failed" }, 500, ctx.baseHeaders);
  }
}

// ===== Knowledge Pending Review =====

/** GET /knowledge/pending-review — List notes with status: pending-review */
export async function handleKnowledgePendingReview(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/knowledge/pending-review" || ctx.req.method !== "GET") return null;

  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const vaultPath = readString("OBSIDIAN_VAULT_PATH", "./axiom-memory");
    const atomicDir = path.join(vaultPath, "03-Knowledge", "atomic-notes");

    if (!fs.existsSync(atomicDir)) {
      return ctx.jsonResponse({ notes: [], count: 0 }, 200, ctx.baseHeaders);
    }

    const pendingNotes: Array<{
      file: string;
      title: string;
      source: string;
      reason?: string;
      created: string;
      updated?: string;
    }> = [];

    for (const file of fs.readdirSync(atomicDir)) {
      if (!file.endsWith(".md")) continue;
      const content = fs.readFileSync(path.join(atomicDir, file), "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];
      const status = fm.match(/^status:\s*(.+)$/m)?.[1].trim();
      if (status !== "pending-review") continue;

      pendingNotes.push({
        file,
        title: fm.match(/^topic:\s*(.+)$/m)?.[1].trim()
          || content.match(/^#\s+(.+)$/m)?.[1].trim()
          || file.replace(".md", ""),
        source: fm.match(/^source:\s*(.+)$/m)?.[1].trim() || "",
        reason: fm.match(/^review-reason:\s*(.+)$/m)?.[1].trim(),
        created: fm.match(/^created:\s*(.+)$/m)?.[1].trim() || "",
        updated: fm.match(/^updated:\s*(.+)$/m)?.[1].trim(),
      });
    }

    return ctx.jsonResponse({ notes: pendingNotes, count: pendingNotes.length }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to scan pending review notes", err as Error);
    return ctx.jsonResponse({ error: "Failed to scan pending review notes" }, 500, ctx.baseHeaders);
  }
}

/** POST /knowledge/pending-review/approve — Approve or reject a pending note */
export async function handleKnowledgeReviewAction(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/knowledge/pending-review/action" || ctx.req.method !== "POST") return null;

  const body = await ctx.req.json().catch(() => ({}));
  const { file, action } = body; // action: "approve" | "reject"

  if (!file || !action) {
    return ctx.jsonResponse({ error: "file and action are required" }, 400, ctx.baseHeaders);
  }

  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const vaultPath = readString("OBSIDIAN_VAULT_PATH", "./axiom-memory");
    const filepath = path.join(vaultPath, "03-Knowledge", "atomic-notes", file);

    if (!fs.existsSync(filepath)) {
      return ctx.jsonResponse({ error: "Note not found" }, 404, ctx.baseHeaders);
    }

    let content = fs.readFileSync(filepath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      return ctx.jsonResponse({ error: "Invalid frontmatter" }, 400, ctx.baseHeaders);
    }

    let fm = fmMatch[1];
    const today = new Date().toISOString().split("T")[0];

    if (action === "approve") {
      fm = fm.replace(/^status:.*$/m, "status: active");
      fm = fm.replace(/^review-reason:.*$/m, "");
    } else if (action === "reject") {
      fm = fm.replace(/^status:.*$/m, "status: archived");
    } else {
      return ctx.jsonResponse({ error: "action must be 'approve' or 'reject'" }, 400, ctx.baseHeaders);
    }

    if (fm.match(/^updated:/m)) {
      fm = fm.replace(/^updated:.*$/m, `updated: ${today}`);
    } else {
      fm += `\nupdated: ${today}`;
    }

    content = content.replace(/^---\n[\s\S]*?\n---/, `---\n${fm}\n---`);
    fs.writeFileSync(filepath, content, "utf-8");

    return ctx.jsonResponse({ ok: true, file, action }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to process review action", err as Error);
    return ctx.jsonResponse({ error: "Failed to process review action" }, 500, ctx.baseHeaders);
  }
}

// ===== Task Management =====

/** GET /memory/tasks?status=X — List tasks */
export async function handleListTasks(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/tasks" || ctx.req.method !== "GET") return null;

  const status = ctx.url.searchParams.get("status");
  const limit = Math.min(parseInt(ctx.url.searchParams.get("limit") || "50", 10), 200);

  try {
    let sql = `SELECT id, title, status, priority, parent_task_id, context_summary, result_summary, created_at, updated_at FROM tasks WHERE 1=1`;
    const params: (string | number)[] = [];
    if (status) { sql += ` AND status = ?`; params.push(status); }
    sql += ` ORDER BY priority DESC, updated_at DESC LIMIT ?`;
    params.push(limit);
    const tasks = ctx.db.query(sql).all(...params);
    return ctx.jsonResponse({ tasks }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to list tasks", err as Error);
    return ctx.jsonResponse({ error: "Failed to list tasks" }, 500, ctx.baseHeaders);
  }
}

// ===== Model Usage Stats =====

/**
 * GET /memory/usage — Model usage statistics
 * 改接 token-tracker（实时 token_usage 库，含 cost_usd 峰谷/直连价成本）；
 * 旧 model_usage 死表不再读取。返回形状保持前端兼容。
 */
export async function handleModelUsage(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/usage" || ctx.req.method !== "GET") return null;

  const days = parseInt(ctx.url.searchParams.get("days") || "7", 10);
  try {
    const since = Date.now() - days * 86400 * 1000;
    const stats = getTokenTracker().getStatsByModel({ since });
    const usage = stats.map((m) => ({
      provider: m.provider,
      model_name: m.model,
      call_count: m.totalCalls,
      total_prompt_tokens: m.totalPromptTokens,
      total_completion_tokens: m.totalCompletionTokens,
      avg_latency_ms: Math.round(m.avgLatencyMs),
      success_count: Math.round((m.successRate / 100) * m.totalCalls),
      cost_usd: m.costUsd ?? 0,
    }));
    return ctx.jsonResponse({ usage, days }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to get usage stats", err as Error);
    return ctx.jsonResponse({ error: "Failed to get usage stats" }, 500, ctx.baseHeaders);
  }
}

/** POST /chat/sessions/:id/archive — 将会话消息原生写入 Vault 日志 */
export async function handleArchiveSession(ctx: RouteContext): Promise<Response | null> {
  const prefix = "/chat/sessions/";
  const suffix = "/archive";
  if (!ctx.url.pathname.startsWith(prefix) || !ctx.url.pathname.endsWith(suffix) || ctx.req.method !== "POST") return null;
  const sessionId = decodeURIComponent(ctx.url.pathname.slice(prefix.length, -suffix.length));
  if (!sessionId) {
    return ctx.jsonResponse({ error: "session id required" }, 400, ctx.baseHeaders);
  }
  if (!ctx.vault) {
    return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);
  }
  try {
    const rows = getSessionMessages(ctx.db, sessionId, 1000, 0);
    const vaultPath = await ctx.vault.writeConversationLog(
      sessionId,
      rows.map((r) => ({
        role: r.role,
        content: r.content,
        timestamp: new Date(r.created_at * 1000).toISOString(),
      })),
    );
    return ctx.jsonResponse({ ok: true, sessionId, vaultPath, archivedMessages: rows.length }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to archive session", err as Error);
    return ctx.jsonResponse({ error: "Failed to archive session" }, 500, ctx.baseHeaders);
  }
}

/** GET /memory/session-search?q=X — 轻量搜索会话摘要与 lineage 元数据 */
export async function handleSessionSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/session-search" || ctx.req.method !== "GET") return null;
  const query = ctx.url.searchParams.get("q") ?? "";
  const limit = parseInt(ctx.url.searchParams.get("limit") || "20", 10);
  const results = searchSessionLineage(ctx.db, query, limit);
  return ctx.jsonResponse({ results, count: results.length }, 200, ctx.baseHeaders);
}

/** GET /chat/sessions/:id/lineage — 返回祖先/后代会话谱系 */
export async function handleSessionLineage(ctx: RouteContext): Promise<Response | null> {
  const prefix = "/chat/sessions/";
  const suffix = "/lineage";
  if (!ctx.url.pathname.startsWith(prefix) || !ctx.url.pathname.endsWith(suffix) || ctx.req.method !== "GET") return null;
  const sessionId = decodeURIComponent(ctx.url.pathname.slice(prefix.length, -suffix.length));
  if (!sessionId) {
    return ctx.jsonResponse({ error: "session id required" }, 400, ctx.baseHeaders);
  }
  const lineage = getSessionLineage(ctx.db, sessionId);
  return ctx.jsonResponse({ sessionId, lineage }, 200, ctx.baseHeaders);
}
