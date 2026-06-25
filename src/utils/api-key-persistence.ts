/**
 * API Key Override SQLite Persistence Layer
 *
 * 将运行时 API Key 覆盖持久化到 SQLite，确保重启后保留。
 * 与 api-key-store.ts 解耦：本模块只负责 DB 读写，store 负责内存状态。
 */

import type { Database } from "bun:sqlite";
import { logger } from "./logger.js";

export interface PersistedOverride {
  provider: string;
  apiKey: string;
  baseURL?: string;
  setAt: number;
}

/** Create the api_key_overrides table if it doesn't exist. */
export function initApiKeyOverridesTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS api_key_overrides (
      provider TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      base_url TEXT,
      set_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_api_key_overrides_updated
    ON api_key_overrides(updated_at DESC)
  `);
  logger.info("[ApiKeyPersistence] Table api_key_overrides ready");
}

/** Load all persisted overrides from DB. */
export function loadApiKeyOverrides(db: Database): PersistedOverride[] {
  const rows = db
    .query(
      "SELECT provider, api_key, base_url, set_at FROM api_key_overrides"
    )
    .all() as Array<{
      provider: string;
      api_key: string;
      base_url: string | null;
      set_at: number;
    }>;

  return rows.map((r) => ({
    provider: r.provider,
    apiKey: r.api_key,
    baseURL: r.base_url || undefined,
    setAt: r.set_at,
  }));
}

/** Upsert a single override into DB. */
export function saveApiKeyOverride(
  db: Database,
  provider: string,
  apiKey: string,
  baseURL?: string
): void {
  db.run(
    `
    INSERT INTO api_key_overrides (provider, api_key, base_url, set_at, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(provider) DO UPDATE SET
      api_key = excluded.api_key,
      base_url = excluded.base_url,
      set_at = excluded.set_at,
      updated_at = unixepoch()
    `,
    [provider, apiKey, baseURL || null, Date.now()]
  );
  logger.info(`[ApiKeyPersistence] Saved override for ${provider}`);
}

/** Delete an override from DB. */
export function deleteApiKeyOverride(db: Database, provider: string): void {
  db.run("DELETE FROM api_key_overrides WHERE provider = ?", [provider]);
  logger.info(`[ApiKeyPersistence] Deleted override for ${provider}`);
}
