/**
 * Cross-session Memory API
 * 
 * Provides unified access to conversation history, knowledge, and tasks
 * across sessions. Supports cross-table joins between SQLite databases.
 */
import type { RouteContext, RouteHandler } from "./types.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

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
         session_id,
         COUNT(*) as message_count,
         SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_messages,
         SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as assistant_messages,
         SUM(tokens_used) as total_tokens,
         MIN(created_at) as started_at,
         MAX(created_at) as last_active
       FROM conversations 
       GROUP BY session_id 
       ORDER BY last_active DESC
       LIMIT 100`
    ).all();
    return ctx.jsonResponse({ sessions }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to list sessions", err as Error);
    return ctx.jsonResponse({ error: "Failed to list sessions" }, 500, ctx.baseHeaders);
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

/** GET /memory/usage — Model usage statistics */
export async function handleModelUsage(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/memory/usage" || ctx.req.method !== "GET") return null;

  const days = parseInt(ctx.url.searchParams.get("days") || "7", 10);
  try {
    const sinceEpoch = Math.floor(Date.now() / 1000) - (days * 86400);
    const usage = ctx.db.query(
      `SELECT provider, model_name, 
              COUNT(*) as call_count,
              SUM(tokens_input) as total_prompt_tokens,
              SUM(tokens_output) as total_completion_tokens,
              AVG(latency_ms) as avg_latency_ms,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count
       FROM model_usage 
       WHERE created_at > ?
       GROUP BY provider, model_name
       ORDER BY call_count DESC`
    ).all(sinceEpoch);
    return ctx.jsonResponse({ usage, days }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("Failed to get usage stats", err as Error);
    return ctx.jsonResponse({ error: "Failed to get usage stats" }, 500, ctx.baseHeaders);
  }
}
