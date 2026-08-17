import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getConnectionConfig } from "../../src/db/pg-client.js";

const KEYS = ["DATABASE_URL", "PG_HOST", "PG_PORT", "PG_USER", "PG_PASSWORD", "PG_DATABASE"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("pg getConnectionConfig", () => {
  it("DATABASE_URL（postgres://）优先", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    const c = getConnectionConfig();
    expect(c.url).toBe("postgres://u:p@h:5432/db");
  });
  it("无 DATABASE_URL → 由 PG_* 拼接", () => {
    delete process.env.DATABASE_URL;
    process.env.PG_HOST = "10.0.0.1"; process.env.PG_PORT = "5433";
    process.env.PG_USER = "ax"; process.env.PG_PASSWORD = "pw"; process.env.PG_DATABASE = "axdb";
    const c = getConnectionConfig();
    expect(c.url).toBe("postgresql://ax:pw@10.0.0.1:5433/axdb");
  });
  it("非 postgres 的 DATABASE_URL → 回退 PG_* 构造", () => {
    process.env.DATABASE_URL = "mysql://u:p@h:3306/db";
    delete process.env.PG_HOST;
    const c = getConnectionConfig();
    expect(c.url.startsWith("postgresql://")).toBe(true);
  });
});
