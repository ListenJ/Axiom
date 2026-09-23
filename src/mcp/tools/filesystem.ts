import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  authorizePath,
  readDir as safeReadDir,
  readFile as safeReadFile,
  writeFile as safeWriteFile,
  move as safeMove,
  remove as safeRemove,
} from "../../utils/safe-fs.js";

/** 调用主体标识：只进审计，不参与放行判定 */
const PRINCIPAL = "mcp:filesystem";

/**
 * 本文件不再自带路径守卫：围栏语义（越界/锚点/realpath）与写盘机制
 * （串行化、原子替换、mkdir 后重校验）都由 utils/safe-fs.ts 在执行点完成（S3 / I2）。
 * utils/path-safety.ts 已于 ADR-007 C-0 下线（其最后一个消费者 docker-sandbox 挂载栅栏
 * 改走同一 authorizePath）⇒ 全仓路径围栏只剩 utils/safe-fs.ts 一份实现。
 */

export interface FileResult {
  success: boolean;
  content?: string;
  error?: string;
  path: string;
}

export interface DirectoryResult {
  success: boolean;
  entries?: Array<{
    name: string;
    type: "file" | "directory" | "symlink";
    size?: number;
    modified?: string;
  }>;
  error?: string;
  path: string;
}

export interface SearchResult {
  success: boolean;
  matches?: Array<{
    file: string;
    line: number;
    content: string;
  }>;
  error?: string;
  searched: number;
  matched: number;
}


/** 把 safeFs 的拒绝原因映射回工具返回值（保持既有 {success:false,error} 契约） */
function deniedMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function readFile(
  filePath: string,
  options?: { offset?: number; limit?: number }
): Promise<FileResult> {
  try {
    const abs = authorizePath(filePath, "fs.read", { principal: PRINCIPAL });
    // Check file size to prevent memory exhaustion
    const stats = await fs.stat(abs);
    if (stats.size > 10 * 1024 * 1024) {
      return { success: false, error: `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB > 10MB limit)`, path: filePath };
    }
    const content = (await safeReadFile(filePath, { principal: PRINCIPAL })).toString("utf-8");
    let result = content;
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const lines = content.split("\n");
      const start = options.offset ?? 0;
      const end = options.limit !== undefined ? start + options.limit : lines.length;
      result = lines.slice(start, end).join("\n");
    }
    return { success: true, content: result, path: filePath };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Failed to read '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      path: filePath,
    };
  }
}

export async function writeFile(
  filePath: string,
  content: string,
  options?: { append?: boolean }
): Promise<FileResult> {
  try {
    await safeWriteFile(filePath, content, { append: options?.append, principal: PRINCIPAL });
    return { success: true, path: filePath };
  } catch (err: unknown) {
    return {
      success: false,
      error: deniedMessage(err),
      path: filePath,
    };
  }
}

export async function listDirectory(dirPath: string): Promise<DirectoryResult> {
  try {
    const resolved = authorizePath(dirPath, "fs.glob", { principal: PRINCIPAL });
    const entries = await safeReadDir(dirPath, { principal: PRINCIPAL });
    const result = await Promise.all(
      entries.map(async (entry) => {
        let size: number | undefined;
        let modified: string | undefined;
        if (entry.type === "file") {
          try {
            const stat = await fs.stat(path.join(resolved, entry.name));
            size = stat.size;
            modified = stat.mtime.toISOString();
          } catch {
            // ignore stat errors
          }
        }
        return { name: entry.name, type: entry.type, size, modified };
      })
    );
    return { success: true, entries: result, path: dirPath };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Failed to list '${dirPath}': ${err instanceof Error ? err.message : String(err)}`,
      path: dirPath,
    };
  }
}

export async function searchFiles(
  query: string,
  options?: {
    path?: string;
    pattern?: string;
    maxResults?: number;
  }
): Promise<SearchResult> {
  let searchPath: string;
  try {
    searchPath = authorizePath(options?.path ?? ".", "fs.glob", { principal: PRINCIPAL });
  } catch (err: unknown) {
    return {
      success: false,
      error: deniedMessage(err),
      searched: 0,
      matched: 0,
    };
  }

  const results: Array<{ file: string; line: number; content: string }> = [];
  const maxResults = options?.maxResults ?? 50;
  let regex: RegExp;
  try {
    regex = options?.pattern
      ? new RegExp(options.pattern, "i")
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch (e: unknown) {
    return {
      success: false,
      error: `Invalid search pattern: ${options?.pattern ?? query}`,
      searched: 0,
      matched: 0,
    };
  }

  async function scan(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    // 逐项判定：safeReadDir 会剔除无权访问的条目（.env / .git / 数据库……），
    // 旧实现对 root 过检后直接回显子项内容，构成 L2 外泄通道。
    const entries = await safeReadDir(dir, { principal: PRINCIPAL });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.type === "directory") {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        await scan(fullPath);
      } else if (entry.type === "file") {
        // Skip binary files
        const ext = path.extname(entry.name).toLowerCase();
        const binaryExts = [
          ".exe",
          ".dll",
          ".so",
          ".dylib",
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".ico",
          ".pdf",
          ".zip",
          ".tar",
          ".gz",
          ".7z",
          ".woff",
          ".woff2",
          ".ttf",
          ".eot",
        ];
        if (binaryExts.includes(ext)) continue;

        try {
          const content = (await safeReadFile(fullPath, { principal: PRINCIPAL })).toString("utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push({
                file: path.relative(searchPath, fullPath),
                line: i + 1,
                content: lines[i].trim().substring(0, 200),
              });
              if (results.length >= maxResults) break;
            }
          }
        } catch {
          // skip files that can't be read as text
        }
      }
    }
  }

  try {
    const stat = await fs.stat(searchPath);
    if (stat.isFile()) {
      const content = (await safeReadFile(searchPath, { principal: PRINCIPAL })).toString("utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({
            file: path.relative(searchPath, searchPath),
            line: i + 1,
            content: lines[i].trim().substring(0, 200),
          });
          if (results.length >= maxResults) break;
        }
      }
    } else {
      await scan(searchPath);
    }
    return {
      success: true,
      matches: results,
      searched: 1,
      matched: results.length,
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      searched: 0,
      matched: 0,
    };
  }
}

export async function deleteFile(filePath: string): Promise<FileResult> {
  try {
    await safeRemove(filePath, { principal: PRINCIPAL });
    return { success: true, path: filePath };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Failed to delete '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      path: filePath,
    };
  }
}

export async function moveFile(
  source: string,
  destination: string
): Promise<FileResult> {
  try {
    await safeMove(source, destination, { principal: PRINCIPAL });
    return { success: true, path: destination };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Failed to move '${source}' to '${destination}': ${err instanceof Error ? err.message : String(err)}`,
      path: source,
    };
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const resolved = authorizePath(filePath, "fs.read", { principal: PRINCIPAL });
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

export function getProjectRoot(): string {
  return process.cwd();
}
