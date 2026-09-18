#!/usr/bin/env bun
/**
 * Database and vault backup script
 * Usage: bun run scripts/backup.ts [options]
 */

import { readdir, copyFile, mkdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";

interface BackupOptions {
  sourceDb: string;
  sourceVault: string;
  backupDir: string;
  keepBackups: number;
  compress: boolean;
}

const DEFAULT_OPTIONS: BackupOptions = {
  sourceDb: process.env.DATABASE_URL?.replace("sqlite:", "") || "./data/axiom.db",
  sourceVault: process.env.VAULT_PATH || "./axiom-memory",
  backupDir: process.env.BACKUP_DIR || "./backups",
  keepBackups: parseInt(process.env.KEEP_BACKUPS || "7", 10),
  compress: process.env.COMPRESS_BACKUPS !== "false",
};

async function createBackup(options: BackupOptions): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(options.backupDir, `backup-${timestamp}`);

  console.log(`Creating backup at: ${backupPath}`);

  // Create backup directory
  await mkdir(backupPath, { recursive: true });

  // Backup database
  if (existsSync(options.sourceDb)) {
    const dbBackupPath = join(backupPath, "database.db");
    await mkdir(dirname(dbBackupPath), { recursive: true });
    await copyFile(options.sourceDb, dbBackupPath);
    console.log(`✓ Database backed up: ${options.sourceDb}`);
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
    console.log(`Removing old backup: ${backup.name}`);
    await Bun.$`rm -rf ${backup.path}`;
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

// CLI
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
} else if (command === "help") {
  console.log(`
Axiom Backup Tool

Usage: bun run scripts/backup.ts [command]

Commands:
  create    Create a new backup (default)
  list      List existing backups
  help      Show this help message

Environment Variables:
  DATABASE_URL      Database file path (default: ./data/axiom.db)
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
