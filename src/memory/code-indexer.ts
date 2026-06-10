/**
 * 代码文件自动索引器
 *
 * 将项目源代码映射到 Obsidian Vault 中，实现：
 * - 代码文件作为可检索的记忆笔记
 * - 函数/类/接口作为 Vault 中的原子笔记
 * - 导入依赖关系映射为 wiki-link
 * - 代码变更自动同步到 Vault
 *
 * Vault 存储结构：
 *   03-Resources/code-index/
 *     ├── src-main-ts.md          (文件级索引)
 *     ├── src-memory-vault-manager-ts.md
 *     └── modules/
 *         ├── deterministic-search.md
 *         └── vault-manager.md
 */

import fs from "fs";
import path from "path";
import { getFileSymbolsFromCodeGraph, type FileIndexData } from "./codegraph-index.js";
import { logger } from "../utils/logger.js";

export interface CodeIndexEntry {
  filePath: string;       // 原始代码路径
  vaultPath: string;      // Vault 中的路径
  moduleName: string;
  exports: Array<{ kind: string; name: string; line: number }>;
  imports: string[];
  summary: string;
  lastIndexed: string;
}

interface IndexerOptions {
  sourceRoot: string;     // 代码根目录
  vaultRoot: string;      // Vault 根目录
  vaultOutputDir: string; // Vault 中输出子目录
  includePatterns: string[];
  excludePatterns: string[];
}

export class CodeIndexer {
  private opts: Required<IndexerOptions>;

  private static readonly LANG_EXT_MAP: Record<string, string> = {
    ".ts": "typescript", ".js": "javascript", ".md": "markdown",
    ".go": "go", ".py": "python", ".java": "java",
    ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".rs": "rust", ".cs": "csharp", ".rb": "ruby",
    ".php": "php", ".swift": "swift", ".kt": "kotlin",
    ".scala": "scala", ".sh": "bash", ".dockerfile": "dockerfile",
  };

  constructor(opts: Partial<IndexerOptions> = {}) {
    const allLangs = Object.keys(CodeIndexer.LANG_EXT_MAP);
    const defaultPatterns = allLangs.map((ext) => `**/*${ext}`);
    this.opts = {
      sourceRoot: opts.sourceRoot || "./src",
      vaultRoot: opts.vaultRoot || "./openclaw-memory",
      vaultOutputDir: opts.vaultOutputDir || "03-Resources/code-index",
      includePatterns: opts.includePatterns || defaultPatterns,
      excludePatterns: opts.excludePatterns || ["node_modules", "dist", ".git", "__pycache__", ".venv", "vendor", "target", "build", "*.min.js", "*.test.*", "*_test.*"],
    };
  }

  /** 全量索引 */
  async indexAll(): Promise<CodeIndexEntry[]> {
    const entries: CodeIndexEntry[] = [];
    await this.scanDirectory(this.opts.sourceRoot, "", entries);

    // 生成模块总览
    await this.generateOverview(entries);

    return entries;
  }

  /** 增量索引单个文件 */
  async indexFile(filePath: string): Promise<CodeIndexEntry | null> {
    const relPath = path.relative(this.opts.sourceRoot, filePath);
    if (!this.shouldInclude(relPath)) return null;

    const content = fs.readFileSync(filePath, "utf-8");
    const ext = path.extname(filePath);
    const lang = ext === ".md" ? undefined : this.detectLang(filePath);

    // P3: 优先使用 CodeGraph 的 AST 数据，避免重复解析
    const cgData = ext !== ".md"
      ? await this.tryGetCodeGraphData(filePath)
      : null;

    const entry: CodeIndexEntry = {
      filePath: relPath,
      vaultPath: this.toVaultPath(relPath),
      moduleName: this.toModuleName(relPath),
      exports: cgData
        ? cgData.exports.map((e) => ({ kind: e.kind, name: e.name, line: e.line }))
        : ext === ".md"
          ? []
          : this.extractExports(content, lang),
      imports: cgData
        ? cgData.imports.map((i) => i.source)
        : ext === ".md"
          ? []
          : this.extractImports(content, lang),
      summary: ext === ".md"
        ? this.summarizeMarkdown(content)
        : cgData
          ? cgData.summary
          : this.summarizeCode(content, relPath, lang),
      lastIndexed: new Date().toISOString(),
    };

    await this.writeVaultNote(entry, content);
    return entry;
  }

  /**
   * P3: 尝试从 CodeGraph 获取文件符号数据
   * 成功时避免本地 regex 解析，失败时静默回退
   */
  private async tryGetCodeGraphData(filePath: string): Promise<FileIndexData | null> {
    try {
      const data = await getFileSymbolsFromCodeGraph(filePath);
      if (data) {
        logger.debug("[CodeIndexer] Using CodeGraph AST data", { file: path.basename(filePath), symbols: data.exports.length });
      }
      return data;
    } catch {
      return null;
    }
  }

  private async scanDirectory(dir: string, relPrefix: string, entries: CodeIndexEntry[]) {
    const fullDir = path.join(dir, relPrefix);
    if (!fs.existsSync(fullDir)) return;

    const items = fs.readdirSync(fullDir, { withFileTypes: true });
    for (const item of items) {
      const itemRel = relPrefix ? `${relPrefix}/${item.name}` : item.name;

      if (item.isDirectory()) {
        if (this.isExcludedDir(item.name)) continue;
        await this.scanDirectory(dir, itemRel, entries);
      } else if (item.isFile() && this.shouldInclude(itemRel)) {
        const entry = await this.indexFile(path.join(dir, itemRel));
        if (entry) entries.push(entry);
      }
    }
  }

  private shouldInclude(relPath: string): boolean {
    const ext = path.extname(relPath);
    if (!Object.keys(CodeIndexer.LANG_EXT_MAP).includes(ext)) return false;
    for (const p of this.opts.excludePatterns) {
      if (this.matchGlob(relPath, p)) return false;
    }
    return true;
  }

  private isExcludedDir(name: string): boolean {
    return ["node_modules", "dist", ".git", "__pycache__", ".venv"].includes(name);
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    const parts = pattern.split("/");
    const fileParts = filePath.split("/");
    // 简单 glob 匹配
    if (pattern.startsWith("**/")) {
      const suffix = pattern.slice(3);
      return filePath.endsWith(suffix);
    }
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
      return regex.test(filePath);
    }
    return filePath === pattern || filePath.endsWith("/" + pattern);
  }

  private toVaultPath(relPath: string): string {
    const base = path.basename(relPath, path.extname(relPath));
    const dir = path.dirname(relPath);
    const safeDir = dir.replace(/\//g, "-").replace(/\\/g, "-");
    const safeName = base.replace(/\//g, "-");
    if (safeDir === ".") {
      return `${this.opts.vaultOutputDir}/${safeName}.md`;
    }
    return `${this.opts.vaultOutputDir}/${safeDir}-${safeName}.md`;
  }

  private toModuleName(relPath: string): string {
    let name = relPath.replace(/\//g, ".").replace(/\\/g, ".");
    for (const ext of Object.keys(CodeIndexer.LANG_EXT_MAP)) {
      if (name.endsWith(ext)) {
        name = name.slice(0, -ext.length);
        break;
      }
    }
    return name;
  }

  private detectLang(filePath: string): string {
    const ext = path.extname(filePath);
    return CodeIndexer.LANG_EXT_MAP[ext] || "text";
  }

  private extractExports(content: string, lang?: string): Array<{ kind: string; name: string; line: number }> {
    const exports: Array<{ kind: string; name: string; line: number }> = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("//")) continue;

      // TypeScript / JavaScript
      if (!lang || lang === "typescript" || lang === "javascript") {
        const m1 = line.match(/export\s+(?:abstract\s+)?class\s+(\w+)/);
        if (m1) { exports.push({ kind: "class", name: m1[1], line: i + 1 }); continue; }
        const m2 = line.match(/export\s+interface\s+(\w+)/);
        if (m2) { exports.push({ kind: "interface", name: m2[1], line: i + 1 }); continue; }
        const m3 = line.match(/export\s+(?:async\s+)?function\s+(\w+)/);
        if (m3) { exports.push({ kind: "function", name: m3[1], line: i + 1 }); continue; }
        const m4 = line.match(/export\s+(?:const|let|var)\s+(\w+)/);
        if (m4) { exports.push({ kind: "variable", name: m4[1], line: i + 1 }); continue; }
        const m5 = line.match(/export\s*\{([^}]+)\}/);
        if (m5) {
          for (const name of m5[1].split(",").map((s) => s.trim().split("as")[0].trim())) {
            if (name) exports.push({ kind: "named", name, line: i + 1 });
          }
          continue;
        }
      }

      // Go
      if (lang === "go") {
        const m1 = line.match(/^func\s+(?:[\w\*]+\s+)?(\w+)\s*\(/);
        if (m1) { exports.push({ kind: "function", name: m1[1], line: i + 1 }); continue; }
        const m2 = line.match(/^type\s+(\w+)\s+(?:struct|interface)/);
        if (m2) { exports.push({ kind: m2[0].includes("interface") ? "interface" : "struct", name: m2[1], line: i + 1 }); continue; }
        const m3 = line.match(/^(const|var)\s+(\w+)/);
        if (m3) { exports.push({ kind: "variable", name: m3[2], line: i + 1 }); continue; }
      }

      // Python
      if (lang === "python") {
        const m1 = line.match(/^class\s+(\w+)/);
        if (m1) { exports.push({ kind: "class", name: m1[1], line: i + 1 }); continue; }
        const m2 = line.match(/^(?:async\s+)?def\s+(\w+)/);
        if (m2) { exports.push({ kind: "function", name: m2[1], line: i + 1 }); continue; }
      }

      // Java
      if (lang === "java") {
        const m1 = line.match(/(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/);
        if (m1) { exports.push({ kind: "class", name: m1[1], line: i + 1 }); continue; }
        const m2 = line.match(/(?:public\s+)?interface\s+(\w+)/);
        if (m2) { exports.push({ kind: "interface", name: m2[1], line: i + 1 }); continue; }
        const m3 = line.match(/(?:public|private|protected)\s+\w+\s+\w+\s*(?:<[^>]+>)?\s+(\w+)\s*\(/);
        if (m3) { exports.push({ kind: "method", name: m3[1], line: i + 1 }); continue; }
      }

      // C / C++
      if (lang === "c" || lang === "cpp") {
        const m1 = line.match(/(?:struct|enum|union)\s+(\w+)/);
        if (m1) { exports.push({ kind: m1[0].trim(), name: m1[1], line: i + 1 }); continue; }
        const m2 = line.match(/^\s*\w+(?:\s+\w+)*(?:\s*\*)?\s+(\w+)\s*\([^)]*\)\s*\{/);
        if (m2 && !line.includes("if ") && !line.includes("while ") && !line.includes("for ")) {
          exports.push({ kind: "function", name: m2[1], line: i + 1 }); continue;
        }
        const m3 = line.match(/typedef\s+.*\s+(\w+);/);
        if (m3) { exports.push({ kind: "typedef", name: m3[1], line: i + 1 }); continue; }
      }

      // Rust
      if (lang === "rust") {
        const m1 = line.match(/^fn\s+(\w+)/);
        if (m1) { exports.push({ kind: "function", name: m1[1], line: i + 1 }); continue; }
        const m2 = line.match(/^(?:pub\s+)?(?:struct|enum|trait|impl)\s+(?:<[^>]+>\s+)?(\w+)/);
        if (m2) { exports.push({ kind: m2[0].trim().split(/\s+/).pop() || "type", name: m2[1], line: i + 1 }); continue; }
      }
    }

    return exports;
  }

  private extractImports(content: string, lang?: string): string[] {
    const imports = new Set<string>();
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("//")) continue;

      // TypeScript / JavaScript / Java
      if (!lang || lang === "typescript" || lang === "javascript" || lang === "java") {
        const m = line.match(/import\s+.*?\s+from\s+["']([^"']+)["']/);
        if (m) {
          const mod = m[1];
          if (mod.startsWith(".")) {
            imports.add(mod.replace(/^\.\.?\//, "").replace(/\.\w+$/, "").replace(/\//g, "-"));
          } else {
            imports.add(mod);
          }
          continue;
        }
      }

      // Go
      if (lang === "go") {
        const m = line.match(/import\s+["']([^"']+)["']/);
        if (m) { imports.add(m[1]); continue; }
        const block = line.match(/import\s+\(/);
        if (block) {
          for (let j = i + 1; j < lines.length; j++) {
            const bline = lines[j];
            if (bline.includes(")")) break;
            const bm = bline.match(/["']([^"']+)["']/);
            if (bm) imports.add(bm[1]);
          }
          continue;
        }
      }

      // Python
      if (lang === "python") {
        const m1 = line.match(/from\s+([\w.]+)\s+import/);
        if (m1) { imports.add(m1[1]); continue; }
        const m2 = line.match(/import\s+([\w.]+)/);
        if (m2) { imports.add(m2[1]); continue; }
      }

      // C / C++
      if (lang === "c" || lang === "cpp") {
        const m = line.match(/#include\s+["<]([^">]+)[">]/);
        if (m) { imports.add(m[1]); continue; }
      }

      // Rust
      if (lang === "rust") {
        const m = line.match(/use\s+([\w:]+)/);
        if (m) { imports.add(m[1]); continue; }
      }
    }

    return Array.from(imports);
  }

  private summarizeCode(content: string, relPath: string, lang?: string): string {
    const lines = content.split("\n").length;
    const exports = this.extractExports(content, lang);
    const imports = this.extractImports(content, lang);

    const parts: string[] = [];
    parts.push(`代码文件: ${relPath}`);
    parts.push(`行数: ${lines}`);
    if (exports.length > 0) {
      parts.push(`导出: ${exports.slice(0, 5).map((e) => `${e.name}(${e.kind})`).join(", ")}${exports.length > 5 ? "..." : ""}`);
    }
    if (imports.length > 0) {
      parts.push(`依赖: ${imports.slice(0, 5).join(", ")}${imports.length > 5 ? "..." : ""}`);
    }

    return parts.join("；");
  }

  private summarizeMarkdown(content: string): string {
    const { frontmatter, body } = this.parseFrontmatter(content);
    const title = (frontmatter.title as string) || this.extractTitle(body) || "Untitled";
    const type = frontmatter.type || "note";
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    return `文档: ${title} (${type}, ${wordCount} 词)`;
  }

  private async writeVaultNote(entry: CodeIndexEntry, rawContent: string) {
    const vaultDir = path.join(this.opts.vaultRoot, this.opts.vaultOutputDir);
    if (!fs.existsSync(vaultDir)) {
      fs.mkdirSync(vaultDir, { recursive: true });
    }

    const vaultFullPath = path.join(this.opts.vaultRoot, entry.vaultPath);
    const vaultDirName = path.dirname(vaultFullPath);
    if (!fs.existsSync(vaultDirName)) {
      fs.mkdirSync(vaultDirName, { recursive: true });
    }

    const isCode = !entry.filePath.endsWith(".md");
    const detectedLang = this.detectLang(entry.filePath);

    // 生成 frontmatter
    const frontmatterLines = [
      "---",
      `id: code-${entry.moduleName}`,
      `type: ${isCode ? "code-index" : "document-index"}`,
      `source: ${entry.filePath}`,
      `lang: ${isCode ? detectedLang : "markdown"}`,
      `created: ${entry.lastIndexed.slice(0, 10)}`,
      `updated: ${entry.lastIndexed.slice(0, 10)}`,
      `word_count: ${rawContent.split(/\s+/).filter(Boolean).length}`,
      `tags: [${isCode ? "code" : "doc"}, auto-indexed]`,
    ];

    if (entry.exports.length > 0) {
      frontmatterLines.push(`exports: [${entry.exports.map((e) => `"${e.name}"`).join(", ")}]`);
    }
    if (entry.imports.length > 0) {
      frontmatterLines.push(`imports: [${entry.imports.map((i) => `"${i}"`).join(", ")}]`);
    }

    frontmatterLines.push("---");

    // 生成内容
    const contentLines: string[] = [];
    contentLines.push(`# ${entry.moduleName}`);
    contentLines.push("");
    contentLines.push("## 元信息");
    contentLines.push("");
    contentLines.push(`- **源文件**: \`${entry.filePath}\``);
    contentLines.push(`- **模块**: \`${entry.moduleName}\``);
    contentLines.push(`- **行数**: ${rawContent.split("\n").length}`);
    contentLines.push(`- **索引时间**: ${entry.lastIndexed}`);
    contentLines.push("");

    if (entry.imports.length > 0) {
      contentLines.push("## 依赖");
      contentLines.push("");
      for (const imp of entry.imports) {
        const wikiName = imp.includes("/") ? imp.replace(/\//g, "-") : imp;
        contentLines.push(`- [[${wikiName}]]`);
      }
      contentLines.push("");
    }

    if (entry.exports.length > 0) {
      contentLines.push("## 导出清单");
      contentLines.push("");
      contentLines.push("| 类型 | 名称 | 行号 |");
      contentLines.push("|------|------|------|");
      for (const e of entry.exports) {
        contentLines.push(`| ${e.kind} | \`${e.name}\` | ${e.line} |`);
      }
      contentLines.push("");
    }

    if (isCode) {
      contentLines.push("## 代码");
      contentLines.push("");
      contentLines.push(`\`\`\`${detectedLang}`);
      contentLines.push(rawContent);
      contentLines.push("```");
    } else {
      contentLines.push("## 原文");
      contentLines.push("");
      contentLines.push(rawContent);
    }

    const fullContent = frontmatterLines.join("\n") + "\n\n" + contentLines.join("\n");
    fs.writeFileSync(vaultFullPath, fullContent, "utf-8");
  }

  private async generateOverview(entries: CodeIndexEntry[]) {
    const overviewPath = path.join(this.opts.vaultRoot, this.opts.vaultOutputDir, "README.md");
    const byDir = new Map<string, CodeIndexEntry[]>();
    for (const e of entries) {
      const dir = path.dirname(e.filePath);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(e);
    }

    const lines: string[] = [
      "---",
      "id: code-index-overview",
      "type: code-index",
      `created: ${new Date().toISOString().slice(0, 10)}`,
      "tags: [code, index, overview]",
      "---",
      "",
      "# 代码索引总览",
      "",
      `> 自动生成于 ${new Date().toLocaleString("zh-CN")}`,
      `> 共索引 ${entries.length} 个文件`,
      "",
      "## 目录结构",
      "",
    ];

    for (const [dir, items] of byDir) {
      lines.push(`### ${dir === "." ? "根目录" : dir}`);
      lines.push("");
      for (const e of items) {
        const noteName = path.basename(e.vaultPath, ".md");
        lines.push(`- [[${noteName}]] — ${e.summary}`);
      }
      lines.push("");
    }

    fs.writeFileSync(overviewPath, lines.join("\n"), "utf-8");
  }

  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { frontmatter: {}, body: content };
    const fm: Record<string, unknown> = {};
    const lines = match[1].split("\n");
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        if (val.startsWith("[") && val.endsWith("]")) {
          fm[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        } else {
          fm[key] = val.replace(/^["']|["']$/g, "");
        }
      }
    }
    return { frontmatter: fm, body: content.slice(match[0].length).trim() };
  }

  private extractTitle(body: string): string | undefined {
    const m = body.match(/^#\s+(.+)$/m);
    return m?.[1]?.trim();
  }
}

export default CodeIndexer;
