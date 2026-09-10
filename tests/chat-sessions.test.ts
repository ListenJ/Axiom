/**
 * 会话持久化路由回归测试：
 *  - PATCH /chat/sessions/:id 重命名（chat_sessions upsert）
 *  - GET /memory/sessions 返回持久化标题（LEFT JOIN）
 *  - DELETE /chat/sessions/:id 需一次性确认码，删除元数据 + 消息
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  handleRenameSession,
  handleDeleteSession,
  handleArchiveSession,
  handleListSessions,
} from "../src/routes/memory-api.js";
import type { RouteContext } from "../src/routes/types.js";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { VaultManager } from "../src/memory/vault-manager.js";
import { requestConfirmation } from "../src/utils/permissions.js";

const db = new Database(":memory:");

db.exec(`
  CREATE TABLE chat_sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_results TEXT,
    tokens_used INTEGER,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL
  );
  INSERT INTO conversations (session_id, agent_id, role, content, tokens_used, created_at)
    VALUES ('sess-1', 'test', 'user', '你好', 10, 1700000000),
           ('sess-1', 'test', 'assistant', '你好！', 20, 1700000001),
           ('sess-2', 'test', 'user', '另一会话', 5, 1700000002);
`);

function fakeCtx(method: string, path: string, body?: unknown): RouteContext {
  return {
    url: new URL(`http://localhost${path}`),
    req: new Request(`http://localhost${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    baseHeaders: {},
    startupTime: Date.now(),
    db,
    jsonResponse: (data: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...extra },
      }),
  } as unknown as RouteContext;
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("会话持久化路由", () => {
  beforeAll(() => {
    // 清空会话表残留（bun:sqlite :memory: 每次运行独立，防御性）
    db.query("DELETE FROM chat_sessions").run();
  });

  it("PATCH 重命名：创建/更新 chat_sessions 记录", async () => {
    const res1 = await handleRenameSession(fakeCtx("PATCH", "/chat/sessions/sess-1", { title: "  我的会话  " }));
    expect(res1!.status).toBe(200);
    expect((await bodyOf(res1!)).title).toBe("我的会话");

    const row = db.query("SELECT title FROM chat_sessions WHERE session_id = ?").get("sess-1") as { title: string };
    expect(row.title).toBe("我的会话");

    // 更新
    const res2 = await handleRenameSession(fakeCtx("PATCH", "/chat/sessions/sess-1", { title: "改名了" }));
    expect(res2!.status).toBe(200);
    const row2 = db.query("SELECT title FROM chat_sessions WHERE session_id = ?").get("sess-1") as { title: string };
    expect(row2.title).toBe("改名了");
  });

  it("PATCH 缺标题返回 400", async () => {
    const res = await handleRenameSession(fakeCtx("PATCH", "/chat/sessions/sess-1", { title: "   " }));
    expect(res!.status).toBe(400);
  });

  it("GET /memory/sessions 返回持久化标题（LEFT JOIN）", async () => {
    const res = await handleListSessions(fakeCtx("GET", "/memory/sessions"));
    expect(res!.status).toBe(200);
    const data = (await bodyOf(res!)) as { sessions: Array<{ session_id: string; title: string; message_count: number }> };
    const s1 = data.sessions.find((s) => s.session_id === "sess-1");
    expect(s1!.title).toBe("改名了");
    expect(s1!.message_count).toBe(2);
    const s2 = data.sessions.find((s) => s.session_id === "sess-2");
    expect(s2!.title).toBe("");
  });

  it("DELETE 无确认码返回 403 + confirmationId", async () => {
    const res = await handleDeleteSession(fakeCtx("DELETE", "/chat/sessions/sess-2"));
    expect(res!.status).toBe(403);
    const data = await bodyOf(res!);
    expect(data.blocked).toBe(true);
    expect(typeof data.confirmationId).toBe("string");
    // 未删除
    const count = db.query("SELECT COUNT(*) as c FROM conversations WHERE session_id = 'sess-2'").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("DELETE 带有效确认码：删除元数据 + 消息", async () => {
    // 正确流程：403 下发的 confirmationId 即一次性凭据，直接带 header 重发
    const confirmationId = requestConfirmation("chat:session-delete");

    const ctxWithHeader: RouteContext = {
      ...fakeCtx("DELETE", "/chat/sessions/sess-2"),
      req: new Request("http://localhost/chat/sessions/sess-2", {
        method: "DELETE",
        headers: { "x-confirmation-id": confirmationId },
      }),
    } as RouteContext;
    const res3 = await handleDeleteSession(ctxWithHeader);
    expect(res3!.status).toBe(200);
    const data = (await bodyOf(res3!)) as { removedMessages: number };
    expect(data.removedMessages).toBe(1);

    const convCount = db.query("SELECT COUNT(*) as c FROM conversations WHERE session_id = 'sess-2'").get() as { c: number };
    expect(convCount.c).toBe(0);
    const metaCount = db.query("SELECT COUNT(*) as c FROM chat_sessions WHERE session_id = 'sess-2'").get() as { c: number };
    expect(metaCount.c).toBe(0);
  });

  it("POST /chat/sessions/:id/archive 写入 Vault 会话日志", async () => {
    const tmp = `.tmp/test-vault-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    const vault = new VaultManager({ vaultPath: tmp, dbPath: ":memory:", apiPort: 0, apiToken: "" });
    const ctx: RouteContext = {
      ...fakeCtx("POST", "/chat/sessions/sess-1/archive"),
      vault,
    } as unknown as RouteContext;
    try {
      const res = await handleArchiveSession(ctx);
      expect(res!.status).toBe(200);
      const data = (await bodyOf(res!)) as { vaultPath: string; archivedMessages: number };
      expect(data.archivedMessages).toBe(2);
      expect(data.vaultPath).toContain("04-Conversations");
      const full = path.join(tmp, data.vaultPath);
      expect(existsSync(full)).toBe(true);
      const content = readFileSync(full, "utf-8");
      expect(content).toContain("你好");
    } finally {
      vault.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
