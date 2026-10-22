/**
 * P3.4：备份产物校验和 + 数据库完整性自检（失败注入/篡改负例，非恒真断言）
 *
 * 背景（交接包 P3.4 + 读码）：仓库内没有「git archives 校验和」实现（`archive/` 是 gitignored
 * 本地目录），按用户批准的替代方案改为「备份产物校验和」：
 *   - `scripts/backup.ts` 原先只做 audit：复制 + WAL checkpoint + 保留 7 份，**无 SHA256 清单、
 *     无 PRAGMA integrity_check**——坏库/坏文件会被当成“成功备份”。
 *
 * 本文件断言：
 *   1. 生成 SHA256SUMS（database.db / sidecar / manifest）后可验证通过；篡改任一文件 → 必须红；
 *   2. 正常库 integrity ok；垃圾库 → 必须红；
 *   3. 清单匹配但库损坏 → verifyBackup 仍失败（integrity_check 兜底）；
 *   4. createBackup 真实产出可验证的备份；坏源库 → 抛错（不产出“看起来成功”的备份）。
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  BACKUP_CHECKSUM_FILE,
  createBackup,
  generateBackupChecksums,
  verifyBackup,
  verifyBackupChecksums,
  verifyDatabaseIntegrity,
} from "../../scripts/backup.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

function makeValidDb(file: string, rows = 3): void {
  const db = new Database(file);
  try {
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < rows; i++) db.run("INSERT INTO t (v) VALUES (?)", [`row-${i}`]);
  } finally {
    db.close();
  }
}

describe("P3.4 备份校验和与完整性", () => {
  test("生成 SHA256SUMS 后可验证通过；篡改 sidecar → 必须红", async () => {
    const dir = tmpDir("backup-checksum-");
    try {
      makeValidDb(path.join(dir, "database.db"));
      fs.writeFileSync(path.join(dir, "database.db-wal"), "wal-bytes");
      fs.writeFileSync(path.join(dir, "manifest.json"), '{"ok":true}');

      const gen = await generateBackupChecksums(dir);
      expect(gen.files).toBe(3);
      expect(fs.existsSync(path.join(dir, BACKUP_CHECKSUM_FILE))).toBe(true);
      expect(await verifyBackupChecksums(dir)).toEqual({ ok: true, errors: [] });

      fs.writeFileSync(path.join(dir, "database.db-wal"), "tampered-bytes");
      const bad = await verifyBackupChecksums(dir);
      expect(bad.ok).toBe(false);
      expect(bad.errors.join(" ")).toContain("哈希不匹配：database.db-wal");

      // 清单外文件（注入/误放）同样必须红
      fs.writeFileSync(path.join(dir, "unexpected.bin"), "extra");
      const extra = await verifyBackupChecksums(dir);
      expect(extra.ok).toBe(false);
      expect(extra.errors.join(" ")).toContain("清单外文件：unexpected.bin");
    } finally {
      cleanup(dir);
    }
  });

  test("verifyDatabaseIntegrity：正常库 ok；垃圾文件/缺失 → 红", async () => {
    const dir = tmpDir("backup-integrity-");
    try {
      const good = path.join(dir, "good.db");
      makeValidDb(good, 5);
      expect(await verifyDatabaseIntegrity(good)).toEqual({ ok: true, detail: "ok" });

      const garbage = path.join(dir, "garbage.db");
      fs.writeFileSync(garbage, "this is not a sqlite database".repeat(10));
      expect((await verifyDatabaseIntegrity(garbage)).ok).toBe(false);

      expect((await verifyDatabaseIntegrity(path.join(dir, "missing.db"))).ok).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("清单匹配但库损坏 → verifyBackup 仍失败（integrity_check 兜底）", async () => {
    const dir = tmpDir("backup-corrupt-");
    try {
      fs.writeFileSync(path.join(dir, "database.db"), "corrupted-sqlite-bytes".repeat(20));
      await generateBackupChecksums(dir); // 清单与内容一致（哈希匹配）
      const result = await verifyBackup(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("数据库完整性校验失败");
    } finally {
      cleanup(dir);
    }
  });

  test("createBackup 真实产出可验证备份；坏源库 → 抛错且不产出成功备份", async () => {
    const root = tmpDir("backup-create-");
    try {
      const sourceDb = path.join(root, "source.db");
      makeValidDb(sourceDb, 4);
      const sourceVault = path.join(root, "vault");
      fs.mkdirSync(sourceVault, { recursive: true });
      fs.writeFileSync(path.join(sourceVault, "note.md"), "# note");
      const backupDir = path.join(root, "backups");

      await createBackup({
        sourceDb,
        sourceVault,
        backupDir,
        keepBackups: 7,
        compress: false,
      });
      const created = fs.readdirSync(backupDir).filter((n) => n.startsWith("backup-"));
      expect(created.length).toBe(1);
      const backupPath = path.join(backupDir, created[0]);
      expect(fs.existsSync(path.join(backupPath, BACKUP_CHECKSUM_FILE))).toBe(true);
      expect(await verifyBackup(backupPath)).toEqual({ ok: true, errors: [] });

      // 负例：坏源库必须让 backup 失败（不得产出“看起来成功”的备份）
      const badSource = path.join(root, "bad-source.db");
      fs.writeFileSync(badSource, "not-a-db".repeat(50));
      await expect(
        createBackup({ sourceDb: badSource, sourceVault, backupDir, keepBackups: 7, compress: false }),
      ).rejects.toThrow(/完整性校验未通过/);
    } finally {
      cleanup(root);
    }
  }, 30_000);
});
