/**
 * SQLite 并发基线 pragma —— 单一来源。
 *
 * 背景：本项目已多次出现"多进程/多连接写同一 SQLite 报 SQLITE_BUSY"的事故类，
 * `src/dre/practice-manual.ts` 亦把"须设 busy_timeout + WAL"记为教训。但主库的若干
 * 连接只开了 WAL、漏了 busy_timeout —— WAL 只保证"不损坏"，不保证"不报错"。
 *
 * 收敛到一个函数，避免各连接各写一份、再次漂移。
 *
 * - `journal_mode=WAL`：读写并发，崩溃安全（多进程写不会静默损坏文件）
 * - `synchronous=NORMAL`：WAL 下的常规性能/安全折中
 * - `busy_timeout`：写锁竞争时**等待**该毫秒数而非立刻抛 SQLITE_BUSY
 *
 * 幂等：可在自开连接与共享连接上安全重复调用。
 */
import type { Database } from "bun:sqlite";

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

export function applySqliteConcurrencyPragmas(
  db: Database,
  busyTimeoutMs: number = DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
}
