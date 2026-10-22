#!/usr/bin/env bun
/**
 * Database and vault backup script
 * Usage: bun run scripts/backup.ts [options]
 */

import { readdir, copyFile, mkdir, stat, unlink, rmdir, readFile, writeFile } from "fs/promises";
import { join, dirname, relative, sep } from "path";
import { existsSync } from "fs";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";

export interface BackupOptions {
  sourceDb: string;
  sourceVault: string;
  backupDir: string;
  keepBackups: number;
  compress: boolean;
}

export const DEFAULT_OPTIONS: BackupOptions = {
  sourceDb:
    process.env.DATABASE_PATH ||
    process.env.DATABASE_URL?.replace("sqlite:", "") ||
    "./data/agent.db",
  sourceVault: process.env.VAULT_PATH || "./axiom-memory",
  backupDir: process.env.BACKUP_DIR || "./backups",
  keepBackups: parseInt(process.env.KEEP_BACKUPS || "7", 10),
  compress: process.env.COMPRESS_BACKUPS !== "false",
};

async function checkpointSourceDb(sourceDb: string): Promise<void> {
  try {
    const db = new Database(sourceDb);
    try {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    console.log(`✓ WAL checkpoint (TRUNCATE) done: ${sourceDb}`);
  } catch (error) {
    console.warn(`[警告] WAL checkpoint failed, continuing with file copy: ${sourceDb}`, error);
  }
}

/** 备份目录内校验清单文件名（sha256sum 兼容格式：`<hash>  <relpath>`） */
export const BACKUP_CHECKSUM_FILE = "SHA256SUMS";

/** 计算单个文件 SHA256。 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

/** 递归收集备份目录内需要记账的文件（相对路径用 POSIX 分隔符；排除校验清单自身）。 */
async function listBackupFiles(backupDir: string, current = backupDir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listBackupFiles(backupDir, full)));
    } else if (entry.isFile()) {
      const rel = relative(backupDir, full).split(sep).join("/");
      if (rel === BACKUP_CHECKSUM_FILE) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * P3.4：为备份产物生成 SHA256 清单（数据库 + WAL/SHM sidecar + manifest + vault 文件）。
 * 返回被记账文件数与清单路径；空目录抛错（避免生成“空清单”伪装成功）。
 */
export async function generateBackupChecksums(
  backupDir: string,
): Promise<{ files: number; manifestPath: string }> {
  const files = await listBackupFiles(backupDir);
  if (files.length === 0) {
    throw new Error(`备份目录为空，拒绝生成校验清单：${backupDir}`);
  }
  const lines: string[] = [];
  for (const rel of files) {
    lines.push(`${await sha256File(join(backupDir, rel))}  ${rel}`);
  }
  const manifestPath = join(backupDir, BACKUP_CHECKSUM_FILE);
  await writeFile(manifestPath, lines.join("\n") + "\n", "utf-8");
  return { files: files.length, manifestPath };
}

/**
 * 校验备份内数据库的完整性（SQLite `PRAGMA integrity_check`）。
 * 坏库必须让备份判定失败——不能留下“看起来成功”的坏备份。
 */
export async function verifyDatabaseIntegrity(dbPath: string): Promise<{ ok: boolean; detail: string }> {
  if (!existsSync(dbPath)) return { ok: false, detail: `数据库不存在：${dbPath}` };
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("PRAGMA integrity_check").get() as Record<string, unknown> | null;
      const value = row ? Object.values(row)[0] : undefined;
      return { ok: value === "ok", detail: String(value ?? "integrity_check 无返回") };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

/** 校验备份产物 SHA256 清单：文件缺失、哈希不匹配、清单不可读都记为错误。 */
export async function verifyBackupChecksums(backupDir: string): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const manifestPath = join(backupDir, BACKUP_CHECKSUM_FILE);
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`缺少校验清单：${manifestPath}`] };
  }
  const lines = (await readFile(manifestPath, "utf-8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) errors.push("校验清单为空");
  const listed = new Set<string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      errors.push(`清单行格式非法：${line}`);
      continue;
    }
    const [, expected, rel] = match;
    listed.add(rel);
    const full = join(backupDir, rel);
    if (!existsSync(full)) {
      errors.push(`文件缺失：${rel}`);
      continue;
    }
    const actual = await sha256File(full);
    if (actual !== expected) errors.push(`哈希不匹配：${rel}`);
  }
  // 清单外文件同样视为异常：备份里多出的文件不属于本次备份产物（防注入/误放）。
  for (const rel of await listBackupFiles(backupDir)) {
    if (!listed.has(rel)) errors.push(`清单外文件：${rel}`);
  }
  return { ok: errors.length === 0, errors };
}

/** 完整校验一个备份目录：SHA256 清单 + 数据库 integrity_check。 */
export async function verifyBackup(backupDir: string): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const checksum = await verifyBackupChecksums(backupDir);
  if (!checksum.ok) errors.push(...checksum.errors);
  const dbPath = join(backupDir, "database.db");
  if (existsSync(dbPath)) {
    const integrity = await verifyDatabaseIntegrity(dbPath);
    if (!integrity.ok) errors.push(`数据库完整性校验失败：${integrity.detail}`);
  }
  return { ok: errors.length === 0, errors };
}

export async function createBackup(options: BackupOptions): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(options.backupDir, `backup-${timestamp}`);

  console.log(`Creating backup at: ${backupPath}`);

  // Create backup directory
  await mkdir(backupPath, { recursive: true });

  // Backup database
  if (existsSync(options.sourceDb)) {
    const dbBackupPath = join(backupPath, "database.db");

    // Flush WAL into the main db file before copying (best-effort).
    await checkpointSourceDb(options.sourceDb);

    await mkdir(dirname(dbBackupPath), { recursive: true });
    await copyFile(options.sourceDb, dbBackupPath);
    console.log(`✓ Database backed up: ${options.sourceDb}`);

    // If WAL/SHM sidecar files still exist (e.g. another live connection),
    // copy them too so the backup stays consistent.
    const walSource = `${options.sourceDb}-wal`;
    const shmSource = `${options.sourceDb}-shm`;
    if (existsSync(walSource)) {
      await copyFile(walSource, `${dbBackupPath}-wal`);
      console.log(`✓ WAL sidecar backed up: ${walSource} -> database.db-wal`);
    }
    if (existsSync(shmSource)) {
      await copyFile(shmSource, `${dbBackupPath}-shm`);
      console.log(`✓ SHM sidecar backed up: ${shmSource} -> database.db-shm`);
    }
  } else {
    console.warn(`[警告] Database not found: ${options.sourceDb}`);
  }

  // Backup vault (metadata only, skip large files)
  if (existsSync(options.sourceVault)) {
    const vaultBackupPath = join(backupPath, "vault");
    await mkdir(vaultBackupPath, { recursive: true });
    await copyVault(options.sourceVault, vaultBackupPath);
    console.log(`✓ Vault backed up: ${options.sourceVault}`);
  } else {
    console.warn(`[警告] Vault not found: ${options.sourceVault}`);
  }

  // Create manifest
  const manifest = {
    timestamp,
    version: process.env.npm_package_version || "unknown",
    files: {
      database: existsSync(options.sourceDb),
      vault: existsSync(options.sourceVault),
    },
  };

  await Bun.write(
    join(backupPath, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`✓ Backup manifest created`);

  // P3.4：备份库完整性自检 + 产物校验和。任一步失败都让备份失败（exit 1），
  // 不留“看起来成功”的坏备份；校验清单覆盖 database.db / sidecar / manifest / vault 文件。
  const dbBackupPath = join(backupPath, "database.db");
  if (existsSync(dbBackupPath)) {
    const integrity = await verifyDatabaseIntegrity(dbBackupPath);
    if (!integrity.ok) {
      console.error(`✗ 备份库完整性校验失败：${integrity.detail}`);
      throw new Error(`备份失败：数据库完整性校验未通过（${integrity.detail}）`);
    }
    console.log("✓ 备份库完整性校验通过（PRAGMA integrity_check = ok）");
  }
  const checks = await generateBackupChecksums(backupPath);
  console.log(`✓ 产物校验和已生成：${checks.manifestPath}（${checks.files} 个文件）`);

  // Cleanup old backups
  await cleanupOldBackups(options);
}

async function copyVault(source: string, dest: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyVault(sourcePath, destPath);
    } else if (entry.isFile()) {
      // Skip large files (> 10MB) and binary files
      try {
        const stats = await stat(sourcePath);
        if (stats.size > 10 * 1024 * 1024) {
          console.log(`  Skipping large file: ${entry.name} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
          continue;
        }
        await copyFile(sourcePath, destPath);
      } catch (error) {
        console.warn(`  Failed to copy: ${entry.name}`, error);
      }
    }
  }
}

// Delete a backup directory strictly entry-by-entry (no shell rm -rf,
// no directory-level recursive delete): recurse via readdir(withFileTypes),
// unlink each file, then rmdir the now-empty directory.
async function deletePathTree(target: string): Promise<void> {
  const entries = await readdir(target, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await deletePathTree(entryPath);
    } else {
      await unlink(entryPath);
      console.log(`  Deleted file: ${entryPath}`);
    }
  }

  await rmdir(target);
  console.log(`  Deleted directory: ${target}`);
}

async function cleanupOldBackups(options: BackupOptions): Promise<void> {
  if (!existsSync(options.backupDir)) return;

  const entries = await readdir(options.backupDir, { withFileTypes: true });
  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("backup-"))
    .map((e) => ({
      name: e.name,
      path: join(options.backupDir, e.name),
      time: stat(join(options.backupDir, e.name)),
    }));

  if (backups.length <= options.keepBackups) return;

  // Sort by modification time (oldest first)
  const sorted = await Promise.all(
    backups.map(async (b) => ({
      ...b,
      mtime: (await b.time).mtime,
    }))
  );
  sorted.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  // Remove oldest backups
  const toRemove = sorted.slice(0, sorted.length - options.keepBackups);
  for (const backup of toRemove) {
    console.log(`Removing old backup: ${backup.path}`);
    await deletePathTree(backup.path);
  }
}

async function listBackups(backupDir: string): Promise<void> {
  if (!existsSync(backupDir)) {
    console.log("No backups found");
    return;
  }

  const entries = await readdir(backupDir, { withFileTypes: true });
  const backups = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith("backup-")
  );

  console.log(`\nFound ${backups.length} backup(s):\n`);

  for (const backup of backups) {
    const manifestPath = join(backupDir, backup.name, "manifest.json");
    let info = "";

    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await Bun.file(manifestPath).text());
        info = ` (${manifest.files.database ? "DB" : ""}${manifest.files.vault ? ", Vault" : ""})`;
      } catch {
        // ignore
      }
    }

    console.log(`  ${backup.name}${info}`);
  }
}

// CLI（仅在直接执行时运行；被测试 import 时不产生副作用）
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0] || "create";

  if (command === "create") {
    createBackup(DEFAULT_OPTIONS)
      .then(() => {
        console.log("\n✓ Backup completed successfully");
        process.exit(0);
      })
      .catch((error) => {
        console.error("\n✗ Backup failed:", error);
        process.exit(1);
      });
  } else if (command === "list") {
    listBackups(DEFAULT_OPTIONS.backupDir).then(() => process.exit(0));
  } else if (command === "verify") {
    const dir = args[1];
    if (!dir) {
      console.error("用法: bun run scripts/backup.ts verify <backup-dir>");
      process.exit(2);
    }
    verifyBackup(dir).then((result) => {
      if (result.ok) {
        console.log(`✓ 备份校验通过：${dir}`);
        process.exit(0);
      }
      console.error(`✗ 备份校验失败：${dir}`);
      for (const error of result.errors) console.error(`  - ${error}`);
      process.exit(1);
    });
  } else if (command === "help") {
    console.log(`
Axiom Backup Tool

Usage: bun run scripts/backup.ts [command]

Commands:
  create           Create a new backup (default; 含 integrity_check + SHA256SUMS)
  list             List existing backups
  verify <dir>     Verify a backup directory (SHA256SUMS + integrity_check)
  help             Show this help message

Environment Variables:
  DATABASE_PATH     Database file path (default: ./data/agent.db)
  DATABASE_URL      Legacy fallback for the database path ("sqlite:" prefix stripped)
  VAULT_PATH        Vault directory path (default: ./axiom-memory)
  BACKUP_DIR        Backup destination (default: ./backups)
  KEEP_BACKUPS      Number of backups to keep (default: 7)
  COMPRESS_BACKUPS  Enable compression (default: true)
`);
    process.exit(0);
  } else {
    console.error(`Unknown command: ${command}`);
    console.error("Run 'bun run scripts/backup.ts help' for usage");
    process.exit(1);
  }
}
