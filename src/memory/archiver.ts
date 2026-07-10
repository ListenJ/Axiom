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
import { logger } from "../utils/logger.js";

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
    this.vaultPath = vaultPath || process.env.OBSIDIAN_VAULT_PATH || "./axiom-memory";
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

  private async moveToArchive(fileRel: string, frontmatter: Record<string, unknown>): Promise<void> {
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
    fs.writeFileSync(archiveFullPath, newContent, "utf-8");
    fs.unlinkSync(sourcePath);

    logger.info("Archived note", { from: fileRel, to: archiveRel });
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
