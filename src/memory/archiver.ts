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
import { isWithinBase } from "../utils/path-safety.js";

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

export interface ArchiveOptions {
  /** true = 只报告将归档清单，不移动任何文件（dry-run 下 archived 即"将归档"清单） */
  dryRun?: boolean;
}

/**
 * P3.1：原子写 / 索引注入接缝（测试可注入失败；生产走真实 fs + 全局 SQLiteMemory）。
 * 只暴露回写与索引这两步——它们才是"移动之后仍可能失败"的位置。
 */
export interface MemoryArchiverDeps {
  writeFileSync?: (filePath: string, content: string) => void;
  renameSync?: (from: string, to: string) => void;
  unlinkSync?: (filePath: string) => void;
  syncIndex?: (notePath: string, archivePath: string) => boolean;
}

const DEFAULT_ARCHIVER_DEPS: Required<MemoryArchiverDeps> = {
  writeFileSync: (filePath, content) => fs.writeFileSync(filePath, content, "utf-8"),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (filePath) => fs.unlinkSync(filePath),
  syncIndex: (notePath, archivePath) => getSqliteMemory().archiveNotePath(notePath, archivePath),
};

export class MemoryArchiver {
  private vaultPath: string;
  private archivePath: string;
  private readonly deps: Required<MemoryArchiverDeps>;

  constructor(vaultPath?: string, deps?: MemoryArchiverDeps) {
    this.vaultPath = vaultPath || readString("OBSIDIAN_VAULT_PATH", "./axiom-memory");
    this.archivePath = path.join(this.vaultPath, "05-Archives");
    this.deps = { ...DEFAULT_ARCHIVER_DEPS, ...deps };
  }

  /**
   * 执行归档扫描
   */
  async archive(opts: ArchiveOptions = {}): Promise<ArchiveResult> {
    const dryRun = opts.dryRun === true;
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
      logger.info("Archiving rule", { rule: rule.name, maxAgeDays: rule.maxAgeDays, dryRun });
      await this.processRule(rule, now, result, dryRun);
    }

    logger.info("Archive complete", {
      archived: result.archived.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      dryRun,
    });

    return result;
  }

  private async processRule(rule: ArchiveRule, now: number, result: ArchiveResult, dryRun: boolean): Promise<void> {
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
          await this.evaluateFile(entryRel, rule, now, result, dryRun);
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
          await this.evaluateFile(entry.name, rule, now, result, dryRun);
        }
    }
  }

  private async evaluateFile(fileRel: string, rule: ArchiveRule, now: number, result: ArchiveResult, dryRun: boolean): Promise<void> {
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

    // dry-run：只报告，不落盘（"将归档清单"进 archived，文件原地不动）
    if (dryRun) {
      result.archived.push(fileRel);
      return;
    }

    // 执行归档
    try {
      await this.moveToArchive(fileRel);
      result.archived.push(fileRel);
    } catch (e) {
      result.errors.push(`${fileRel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async archiveNote(fileRel: string): Promise<boolean> {
    if (!this.isPathWithinVault(fileRel)) return false;
    const fullPath = path.join(this.vaultPath, fileRel);
    if (!fs.existsSync(fullPath)) return false;
    await this.moveToArchive(fileRel);
    return true;
  }

  /** 原子写：同目录 tmp → rename（既有 rename-first 之外，补上「回写标记」这一步的原子性）。 */
  private atomicWriteFile(targetPath: string, content: string): void {
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      this.deps.writeFileSync(tmpPath, content);
      this.deps.renameSync(tmpPath, targetPath);
    } catch (err) {
      // 失败时清理 tmp（best-effort），绝不留半截文件
      try {
        this.deps.unlinkSync(tmpPath);
      } catch {
        /* tmp 可能尚未创建 */
      }
      throw err;
    }
  }

  /** 生成带归档标记的最终内容（与原实现逐字一致，仅抽出以便重写路径复用）。 */
  private buildArchivedContent(originalContent: string, fileRel: string): string {
    const now = new Date().toISOString();
    const { frontmatter: oldFm, body } = this.parseFrontmatter(originalContent);

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

    return fmLines.join("\n") + "\n\n" + body;
  }

  private async moveToArchive(fileRel: string): Promise<void> {
    // Fix 4：防御性边界检查（防路径穿越，与 VaultManager.resolveSafePath 同构）
    if (!this.isPathWithinVault(fileRel)) {
      throw new Error(`Path traversal blocked: ${fileRel}`);
    }

    const sourcePath = path.join(this.vaultPath, fileRel);
    // 构建归档路径：保持原有目录结构
    const archiveRel = fileRel;
    const archiveFullPath = path.join(this.archivePath, archiveRel);
    const archiveDir = path.dirname(archiveFullPath);

    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // 唯一副本暂存：用于任何失败分支把源恢复成**原始内容**（而不是带 markers 的版本）
    const originalContent = fs.readFileSync(sourcePath, "utf-8");
    const newContent = this.buildArchivedContent(originalContent, fileRel);

    // Fix 3：优先原子 rename（同文件系统内 renameSync 是原子操作，消除 copy-then-delete 窗口）。
    // 跨文件系统（EXDEV）回退到「同目录 tmp → rename」的原子写。
    let usedRename = false;
    try {
      this.deps.renameSync(sourcePath, archiveFullPath);
      usedRename = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        this.atomicWriteFile(archiveFullPath, newContent);
      } else {
        throw e;
      }
    }

    // P3.1：rename 只会移动原文；标记 frontmatter 的回写必须**原子替换**，否则崩溃会截断唯一副本。
    // 失败回滚：归档里仍是 rename 带过来的原文，移回源位置即可恢复（不丢内容、不污染源）。
    if (usedRename) {
      try {
        this.atomicWriteFile(archiveFullPath, newContent);
      } catch (err) {
        try {
          this.deps.renameSync(archiveFullPath, sourcePath);
        } catch {
          /* 回滚失败：原文仍在归档路径（未截断），错误如实上报 */
        }
        throw err;
      }
    }

    // Fix 1：索引更新成功后才“删除”源。此时源在 rename 路径下已被移走；
    // EXDEV 回退下源仍存在，故此处显式清理（仅在索引成功后）。
    const sourceStillExists = fs.existsSync(sourcePath);

    const indexedArchivePath = path.relative(this.vaultPath, archiveFullPath).replace(/\\/g, "/");
    // 索引更新——失败则回滚：rename 路径下把文件移回源位置**并原子恢复原始内容**；
    // EXDEV 路径下删归档、保留源。关键：源文件必须恢复原状，绝不留下“带 markers 的源”。
    try {
      this.deps.syncIndex(fileRel, indexedArchivePath);
    } catch (err) {
      logger.warn("[MemoryArchiver] SQLite archive index sync failed — rolling back", {
        from: fileRel,
        to: archiveRel,
        error: err instanceof Error ? err.message : String(err),
      });
      if (usedRename) {
        try {
          this.deps.renameSync(archiveFullPath, sourcePath);
        } catch {
          /* 回滚失败：保留归档副本，错误如实上报 */
        }
        try {
          this.atomicWriteFile(sourcePath, originalContent);
        } catch {
          /* 内容恢复失败：保留已移回的文件（含 markers），错误如实上报 */
        }
      } else {
        try {
          this.deps.unlinkSync(archiveFullPath);
        } catch {
          /* 归档清理失败：源仍完好，错误如实上报 */
        }
      }
      throw err;
    }

    // 索引成功后才清理源文件（EXDEV 回退路径下源仍存在）
    if (sourceStillExists) {
      this.deps.unlinkSync(sourcePath);
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
    // T3（2026-09-18）：containment 判定委托唯一原语（原为第 8 份重复实现）
    return isWithinBase(this.vaultPath, resolved);
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
