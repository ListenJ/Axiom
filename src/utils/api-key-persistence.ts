/**
 * API Key Override SQLite Persistence Layer
 *
 * 将运行时 API Key 覆盖持久化到 SQLite，确保重启后保留。
 * 与 api-key-store.ts 解耦：本模块只负责 DB 读写，store 负责内存状态。
 *
 * Task 4.1: API Key 静态加密（AES-256-GCM）
 * - 密文格式：`<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 * - 密钥来源：`AXIOM_ENCRYPTION_KEY`（base64 编码 32 字节）
 * - fail-closed：写时未配密钥 → throw；读时未配密钥或解密失败 → 跳过 + warn
 */

import type { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { logger } from "./logger.js";
import { readString } from "./env.js";

export interface PersistedOverride {
  provider: string;
  apiKey: string;
  baseURL?: string;
  setAt: number;
}

// ============================================================================
// Task 4.1 — AES-256-GCM 加解密
// ============================================================================

const IV_LENGTH = 12;   // GCM 推荐 12 字节 IV
const TAG_LENGTH = 16;  // GCM auth tag 16 字节
const KEY_LENGTH = 32;  // AES-256

/** 加密后的密文格式：`<iv_hex>:<authTag_hex>:<ciphertext_hex>` */
const CIPHER_PATTERN = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;

/** 读取并解码 AXIOM_ENCRYPTION_KEY（base64 → 32 字节 Buffer）。未配置返回 null。 */
function getEncryptionKey(): Buffer | null {
  const b64 = readString("AXIOM_ENCRYPTION_KEY");
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length === KEY_LENGTH ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 加密明文 API Key。fail-closed：未配密钥时 throw（防止明文落盘）。
 * 返回 `<iv_hex>:<authTag_hex>:<ciphertext_hex>` 格式字符串。
 */
function encrypt(plain: string): string {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      "[ApiKeyPersistence] AXIOM_ENCRYPTION_KEY 未配置或长度不正确（需 base64 编码的 32 字节）。拒绝明文写入。",
    );
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * 解密密文。未配密钥或解密失败返回 null（调用方负责跳过 + warn）。
 */
function decrypt(cipherText: string): string | null {
  const key = getEncryptionKey();
  if (!key) return null;
  if (!CIPHER_PATTERN.test(cipherText)) return null;
  try {
    const [ivHex, tagHex, dataHex] = cipherText.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/** 判断 DB 中的 api_key 字段是否为明文（未加密）。 */
function isPlaintext(stored: string): boolean {
  return !CIPHER_PATTERN.test(stored);
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

/** Load all persisted overrides from DB. Task 4.1: 解密 api_key，失败跳过 + warn。 */
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

  const out: PersistedOverride[] = [];
  for (const r of rows) {
    // Task 4.1: 容错历史明文 — 若未配密钥但记录是明文，原样返回（兼容升级前数据）
    if (isPlaintext(r.api_key)) {
      const key = getEncryptionKey();
      if (!key) {
        // 未配密钥 + 明文记录：原样返回（兼容升级前），但 warn 提示
        logger.warn(
          `[ApiKeyPersistence] Provider ${r.provider} 存储为明文且未配置 AXIOM_ENCRYPTION_KEY，原样返回（建议配置密钥后调用 migratePlaintextKeys）`,
        );
        out.push({
          provider: r.provider,
          apiKey: r.api_key,
          baseURL: r.base_url || undefined,
          setAt: r.set_at,
        });
      } else {
        // 已配密钥但记录是明文：跳过（应由 migratePlaintextKeys 处理）
        logger.warn(
          `[ApiKeyPersistence] Provider ${r.provider} 存储为明文，跳过加载（请调用 migratePlaintextKeys 加密重写）`,
        );
      }
      continue;
    }

    // 密文记录：解密
    const plain = decrypt(r.api_key);
    if (plain === null) {
      logger.warn(
        `[ApiKeyPersistence] Provider ${r.provider} 解密失败（密钥不匹配或数据损坏），跳过`,
      );
      continue;
    }
    out.push({
      provider: r.provider,
      apiKey: plain,
      baseURL: r.base_url || undefined,
      setAt: r.set_at,
    });
  }
  return out;
}

/** Upsert a single override into DB. Task 4.1: 写前 encrypt，fail-closed。 */
export function saveApiKeyOverride(
  db: Database,
  provider: string,
  apiKey: string,
  baseURL?: string
): void {
  const encrypted = encrypt(apiKey); // 未配密钥 → throw（fail-closed）
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
    [provider, encrypted, baseURL || null, Date.now()]
  );
  logger.info(`[ApiKeyPersistence] Saved override for ${provider}`);
}

/** Delete an override from DB. */
export function deleteApiKeyOverride(db: Database, provider: string): void {
  db.run("DELETE FROM api_key_overrides WHERE provider = ?", [provider]);
  logger.info(`[ApiKeyPersistence] Deleted override for ${provider}`);
}

/**
 * Task 4.1: 迁移历史明文 API Key 到密文。
 * 检测 api_key_overrides 表中所有明文记录（不匹配 CIPHER_PATTERN），加密重写。
 * 未配置 AXIOM_ENCRYPTION_KEY 时直接返回 0（不操作）。
 * @returns 迁移的记录数
 */
export function migratePlaintextKeys(db: Database): number {
  const key = getEncryptionKey();
  if (!key) {
    logger.warn(
      "[ApiKeyPersistence] migratePlaintextKeys 跳过：未配置 AXIOM_ENCRYPTION_KEY",
    );
    return 0;
  }

  const rows = db
    .query("SELECT provider, api_key FROM api_key_overrides")
    .all() as Array<{ provider: string; api_key: string }>;

  let migrated = 0;
  for (const r of rows) {
    if (isPlaintext(r.api_key)) {
      try {
        const encrypted = encrypt(r.api_key);
        db.run(
          "UPDATE api_key_overrides SET api_key = ?, updated_at = unixepoch() WHERE provider = ?",
          [encrypted, r.provider],
        );
        migrated++;
      } catch (err) {
        logger.warn(
          `[ApiKeyPersistence] 迁移 ${r.provider} 失败: ${(err as Error).message}`,
        );
      }
    }
  }
  if (migrated > 0) {
    logger.info(
      `[ApiKeyPersistence] migratePlaintextKeys 完成：${migrated} 条明文已加密重写`,
    );
  }
  return migrated;
}
