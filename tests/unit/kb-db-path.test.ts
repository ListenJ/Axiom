/**
 * 审计 E-1 / 整改 R3 Task 3.2 —— SQLite 记忆库路径单一解析源
 *
 * 修复前：kb-backend.ts 自行默认 ./data/kg.db，与 vault 的
 * SQLITE_MEMORY_DB || DATABASE_PATH(./data/agent.db) 分裂 → KAL 在
 * kg.db 中查不存在的 memory_notes 表，vault 腿恒空（split-brain）。
 *
 * 修复后契约：resolveSqliteMemoryDbPath() 是唯一解析源；
 * kb-backend 仅在显式设置 KB_DB_PATH 时才偏离。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveSqliteMemoryDbPath } from "../../src/memory/sqlite-memory.js";

const ENV_KEYS = ["SQLITE_MEMORY_DB", "DATABASE_PATH", "KB_DB_PATH"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveSqliteMemoryDbPath 契约（E-1）", () => {
  test("默认 agent.db", () => {
    expect(resolveSqliteMemoryDbPath()).toBe("./data/agent.db");
  });

  test("SQLITE_MEMORY_DB 优先于 DATABASE_PATH", () => {
    process.env.SQLITE_MEMORY_DB = "./data/mem.sqlite";
    process.env.DATABASE_PATH = "./data/other.db";
    expect(resolveSqliteMemoryDbPath()).toBe("./data/mem.sqlite");
  });

  test("仅 DATABASE_PATH 时生效", () => {
    process.env.DATABASE_PATH = "./data/only-path.db";
    expect(resolveSqliteMemoryDbPath()).toBe("./data/only-path.db");
  });
});
