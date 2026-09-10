/**
 * 记忆归档自动化
 *
 * 基于 PARA 方法的归档策略：
 * - Resources → Archives: 超过 90 天未访问且非核心参考
 * - Conversations → Archives: 超过 30 天的会话日志
 * - Projects → Archives: 标记为 completed 的项目
 * - Daily logs → Archives: 超过 60 天的日志
 *
 * 归档不是删除，而是移动到 05-Archives/ 目录，保留可检索性。
 */

import fs from "fs";
import path from "path";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import { getSqliteMemory } from "./sqlite-memory.js";

interface ArchiveRule {
  name: string;
  sourcePattern: RegExp;
  maxAgeDays: number;
  condition?: (filePath: string, stat: fs.Stats, frontmatter: Record<string, unknown>) => boolean;
}

interface ArchiveResult {
  archived: string[];
  skipped: string[];
  errors: string[];
}

export class MemoryArchiver {
  private vaultPath: string;
  private archivePath: string;

  constructor(vaultPath?: string) {
    this.vaultPath = vaultPath || readString("OBSIDIAN_VAULT_PATH", "./axiom-memory");
    this.archivePath = path.join(this.vaultPath, "05-Archives");
  }

  /**
   * 执行归档扫描
   */
  async archive(): Promise<ArchiveResult> {
    const result: ArchiveResult = { archived: [], skipped: [], errors: [] };
    const now = Date.now();

    const rules: ArchiveRule[] = [
      {
        name: "conversations",
        sourcePattern: /^04-Conversations\//,
        maxAgeDays: 30,
      },
      {
        name: "daily-logs",
        sourcePattern: /^memory\//,
        maxAgeDays: 60,
      },
      {
        name: "web-clips",
        sourcePattern: /^03-Resources\/web-clips\//,
        maxAgeDays: 90,
      },
      {
        name: "search-results",
        sourcePattern: /^03-Resources\/search-results\//,
        maxAgeDays: 14,
      },
      {
        name: "completed-projects",
        sourcePattern: /^01-Projects\//,
        maxAgeDays: 0, // 不基于时间，基于 frontmatter 状态
        condition: (_fp, _stat, fm) => fm.status === "completed" || fm.status === "archived",
      },
    ];

    for (const rule of rules) {
      logger.info("Archiving rule", { rule: rule.name, maxAgeDays: rule.maxAgeDays });
      await this.processRule(rule, now, result);
    }

    logger.info("Archive complete", {
      archived: result.archived.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
    });

    return result;
  }

  private async processRule(rule: ArchiveRule, now: number, result: ArchiveResult): Promise<void> {
    const scanDir = async (dir: string, relPrefix: string) => {
      const fullDir = path.join(dir, relPrefix);
      if (!fs.existsSync(fullDir)) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(fullDir, { withFileTypes: true });
      } catch (e) {
        result.errors.push(`Cannot read directory ${fullDir}: ${(e as Error).message}`);
        return;
      }
      for (const entry of entries) {
        const entryRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          await scanDir(dir, entryRel);
        } else if (entry.name.endsWith(".md")) {
          await this.evaluateFile(entryRel, rule, now, result);
        }
      }
    };

    // 扫描 Vault 根目录
    let rootEntries: fs.Dirent[];
    try {
      rootEntries = fs.readdirSync(this.vaultPath, { withFileTypes: true });
    } catch (e) {
      result.errors.push(`Cannot read vault root ${this.vaultPath}: ${(e as Error).message}`);
      return;
    }
    for (const entry of rootEntries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("05-Archives")) {
        await scanDir(this.vaultPath, entry.name);
      } else if (entry.isFile() && entry.name.endsWith(".md") && rule.sourcePattern.test(entry.name)) {
        await this.evaluateFile(entry.name, rule, now, result);
      }
    }
  }

  private async evaluateFile(fileRel: string, rule: ArchiveRule, now: number, result: ArchiveResult): Promise<void> {
    if (!rule.sourcePattern.test(fileRel)) return;

    const fullPath = path.join(this.vaultPath, fileRel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      result.errors.push(`Cannot stat: ${fileRel}`);
      return;
    }

    const frontmatter = this.parseFrontmatterSafe(fullPath);

    // 条件检查
    if (rule.condition) {
      if (!rule.condition(fileRel, stat, frontmatter)) {
        result.skipped.push(fileRel);
        return;
      }
    }

    // 时间检查
    if (rule.maxAgeDays > 0) {
      const ageMs = now - stat.mtimeMs;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < rule.maxAgeDays) {
        result.skipped.push(fileRel);
        return;
      }
    }

    // 永不过期标记
    if (frontmatter.permanent === true || frontmatter.archived === false) {
      result.skipped.push(fileRel);
      return;
    }

    // 执行归档
    try {
      await this.moveToArchive(fileRel, frontmatter);
      result.archived.push(fileRel);
    } catch (e) {
      result.errors.push(`${fileRel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async archiveNote(fileRel: string): Promise<boolean> {
    if (!this.isPathWithinVault(fileRel)) return false;
    const fullPath = path.join(this.vaultPath, fileRel);
    if (!fs.existsSync(fullPath)) return false;
    const frontmatter = this.parseFrontmatterSafe(fullPath);
    await this.moveToArchive(fileRel, frontmatter);
    return true;
  }

  private async moveToArchive(fileRel: string, frontmatter: Record<string, unknown>): Promise<void> {
    // Fix 4：防御性边界检查（防路径穿越，与 VaultManager.resolveSafePath 同构）
    if (!this.isPathWithinVault(fileRel)) {
      throw new Error(`Path traversal blocked: ${fileRel}`);
    }

    const sourcePath = path.join(this.vaultPath, fileRel);
    const now = new Date().toISOString();

    // 构建归档路径：保持原有目录结构
    const archiveRel = fileRel;
    const archiveFullPath = path.join(this.archivePath, archiveRel);
    const archiveDir = path.dirname(archiveFullPath);

    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // 读取原内容，添加归档标记
    let content = fs.readFileSync(sourcePath, "utf-8");
    const { frontmatter: oldFm, body } = this.parseFrontmatter(content);

    const newFm = {
      ...oldFm,
      archived_at: now.slice(0, 10),
      archived_from: fileRel,
      ...(oldFm.tags ? { tags: [...(Array.isArray(oldFm.tags) ? oldFm.tags : [oldFm.tags]), "archived"] } : {}),
    };

    const fmLines = ["---"];
    for (const [k, v] of Object.entries(newFm)) {
      if (Array.isArray(v)) {
        fmLines.push(`${k}: [${v.map((x) => `"${x}"`).join(", ")}]`);
      } else {
        fmLines.push(`${k}: ${v}`);
      }
    }
    fmLines.push("---");

    const newContent = fmLines.join("\n") + "\n\n" + body;

    // Fix 3：优先原子 rename（同文件系统内 renameSync 是原子操作，消除 copy-then-delete 窗口）。
    // 跨文件系统（EXDEV）回退到写入临时文件 + 重命名。无论哪条路径，删除源文件都发生在
    // 索引更新成功之后（Fix 1），确保不会出现“源已删、索引仍指向旧路径”的孤文件。
    let usedRename = false;
    try {
      fs.renameSync(sourcePath, archiveFullPath);
      usedRename = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EXDEV：跨设备/跨目录无法原子 rename，回退为写入归档 + 重命名
      if (code === "EXDEV") {
        const tmpPath = `${archiveFullPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          fs.writeFileSync(tmpPath, newContent, "utf-8");
          fs.renameSync(tmpPath, archiveFullPath);
        } catch (writeErr) {
          try { fs.unlinkSync(tmpPath); } catch {}
          throw writeErr;
        }
      } else {
        throw e;
      }
    }

    // rename 成功：在 rename 路径下 sourcePath 已不复存在，归档内容即原文（含 archiver 标记需补写）。
    // rename 不重写 frontmatter，为保证归档标记一致，rename 后回写标记 frontmatter。
    if (usedRename) {
      fs.writeFileSync(archiveFullPath, newContent, "utf-8");
    }

    // Fix 1：索引更新成功后才“删除”源。此时源在 rename 路径下已被移走；
    // EXDEV 回退下源仍存在，故此处显式清理（仅在索引成功后）。
    const sourceStillExists = fs.existsSync(sourcePath);

    const indexedArchivePath = path.relative(this.vaultPath, archiveFullPath).replace(/\\/g, "/");
    // 索引更新——失败则回滚：rename 路径下把文件移回源位置；EXDEV 路径下删归档、保留源。
    // 关键：源文件必须恢复原状，绝不留下“源已删/已移、索引无行”的孤文件。
    try {
      getSqliteMemory().archiveNotePath(fileRel, indexedArchivePath);
    } catch (err) {
      logger.warn("[MemoryArchiver] SQLite archive index sync failed — rolling back", {
        from: fileRel,
        to: archiveRel,
        error: err instanceof Error ? err.message : String(err),
      });
      if (usedRename) {
        // rename 路径：源已被移到 archiveFullPath，回滚 = 移回源位置
        try { fs.renameSync(archiveFullPath, sourcePath); } catch {}
      } else {
        // EXDEV 路径：源仍在原位（完好），清理已写入的归档文件
        try { fs.unlinkSync(archiveFullPath); } catch {}
      }
      throw err;
    }

    // 索引成功后才清理源文件（EXDEV 回退路径下源仍存在）
    if (sourceStillExists) {
      fs.unlinkSync(sourcePath);
    }

    logger.info("Archived note", { from: fileRel, to: archiveRel });
  }

  /**
   * 校验 fileRel 位于 vault 边界内（防路径穿越）。
   * 与 VaultManager.resolveSafePath 同构：拒绝包含 ".."、绝对路径、或解析后跑出 vault 的路径。
   */
  private isPathWithinVault(fileRel: string): boolean {
    if (path.isAbsolute(fileRel)) return false;
    const resolved = path.resolve(this.vaultPath, fileRel);
    const base = path.resolve(this.vaultPath);
    const relative = path.relative(base, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return true;
  }

  private parseFrontmatterSafe(filePath: string): Record<string, unknown> {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return this.parseFrontmatter(content).frontmatter;
    } catch {
      return {};
    }
  }

  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const normalized = content.replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { frontmatter: {}, body: normalized };

    const fm: Record<string, unknown> = {};
    for (const line of match[1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        if (val.startsWith("[") && val.endsWith("]")) {
          fm[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        } else if (val === "true") {
          fm[key] = true;
        } else if (val === "false") {
          fm[key] = false;
        } else {
          fm[key] = val.replace(/^["']|["']$/g, "");
        }
      }
    }
    return { frontmatter: fm, body: normalized.slice(match[0].length).trim() };
  }

  /** 获取归档统计 */
  stats(): { archivedCount: number; byCategory: Record<string, number> } {
    if (!fs.existsSync(this.archivePath)) {
      return { archivedCount: 0, byCategory: {} };
    }

    let count = 0;
    const byCategory: Record<string, number> = {};

    const scan = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          scan(path.join(dir, entry.name), entryRel);
        } else if (entry.name.endsWith(".md")) {
          count++;
          const category = rel.split("/")[0] || "uncategorized";
          byCategory[category] = (byCategory[category] || 0) + 1;
        }
      }
    };

    scan(this.archivePath, "");
    return { archivedCount: count, byCategory };
  }
}

export default MemoryArchiver;
