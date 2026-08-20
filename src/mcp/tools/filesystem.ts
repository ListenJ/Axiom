import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

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

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(process.cwd(), filePath);
}

function isPathSafe(targetPath: string): { safe: boolean; error?: string } {
  try {
    const resolved = path.resolve(targetPath);
    const cwd = process.cwd();
    const relative = path.relative(cwd, resolved);

    // Check 1: ".."-prefixed relative path means path escapes cwd (standard traversal)
    // Check 2: absolute relative path means cross-drive on Windows
    //          (e.g., path.relative("D:\\proj", "C:\\Users") → "C:\\Users")
    //          This bypasses the ".." check because the result doesn't start with ".."
    if (relative.startsWith("..") || relative === ".." || path.isAbsolute(relative)) {
      return {
        safe: false,
        error: `Path '${targetPath}' escapes working directory. Only paths within the project are allowed.`,
      };
    }

    // 安全（2026-07-26 审查修复）：沙箱内敏感区域拒绝访问。
    // fs 工具沙箱根 = 仓库根，.env / 数据库 / git 元数据含密钥与运行状态，
    // 不得经 agent 工具读取或改写。
    const DENIED_SEGMENTS: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /(^|[\\/])\.env([\\/].*)?$|(^|[\\/])\.env\.[^\\/]+$/i, label: ".env 密钥文件" },
      { pattern: /(^|[\\/])\.git([\\/]|$)/i, label: ".git 元数据" },
      { pattern: /(^|[\\/])data[\\/][^\\/]*\.db(-\w+)?$/i, label: "运行时数据库" },
      { pattern: /(^|[\\/])data[\\/]model-config\.json$/i, label: "模型密钥配置" },
    ];
    for (const { pattern, label } of DENIED_SEGMENTS) {
      if (pattern.test(relative)) {
        return { safe: false, error: `Path '${targetPath}' is in a denied area (${label}).` };
      }
    }

    // Check 3: resolve symlinks to prevent symlink-based traversal
    // A symlink within cwd could point outside cwd, bypassing the relative check above.
    // Only check if the path exists (writeFile to a new file won't exist yet).
    try {
      const realPath = fsSync.realpathSync(resolved);
      const realRelative = path.relative(cwd, realPath);
      if (realRelative.startsWith("..") || realRelative === ".." || path.isAbsolute(realRelative)) {
        return {
          safe: false,
          error: `Path '${targetPath}' resolves to a location outside the working directory (symlink escape).`,
        };
      }
    } catch {
      // Path doesn't exist yet (e.g., new file write) — parent directory check
      const parentDir = path.dirname(resolved);
      try {
        const realParent = fsSync.realpathSync(parentDir);
        const parentRelative = path.relative(cwd, realParent);
        if (parentRelative.startsWith("..") || parentRelative === ".." || path.isAbsolute(parentRelative)) {
          return {
            safe: false,
            error: `Path '${targetPath}' parent directory resolves outside the working directory.`,
          };
        }
      } catch {
        // Parent doesn't exist either — allow (mkdir will create it within cwd)
      }
    }

    return { safe: true };
  } catch {
    return { safe: false, error: "Invalid path" };
  }
}

export async function readFile(
  filePath: string,
  options?: { offset?: number; limit?: number }
): Promise<FileResult> {
  const resolved = resolvePath(filePath);
  const safety = isPathSafe(resolved);
  if (!safety.safe) {
    return { success: false, error: safety.error, path: filePath };
  }

  try {
    // Check file size to prevent memory exhaustion
    const stats = await fs.stat(resolved);
    if (stats.size > 10 * 1024 * 1024) {
      return { success: false, error: `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB > 10MB limit)`, path: filePath };
    }
    const content = await fs.readFile(resolved, "utf-8");
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
  const resolved = resolvePath(filePath);
  const safety = isPathSafe(resolved);
  if (!safety.safe) {
    return { success: false, error: safety.error, path: filePath };
  }

  try {
    const dir = path.dirname(resolved);
    // 原子 mkdir -p + 捕获 EEXIST/竞态（H-03 TOCTOU 修复）
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
    // TOCTOU 重校验：mkdir 后再次解析真实路径，防止 check→mkdir 窗口的 symlink 抢占
    const postSafety = isPathSafe(resolved);
    if (!postSafety.safe) {
      return { success: false, error: postSafety.error, path: filePath };
    }
    if (options?.append) {
      await fs.appendFile(resolved, content, "utf-8");
    } else {
      await fs.writeFile(resolved, content, "utf-8");
    }
    return { success: true, path: filePath };
  } catch (err: unknown) {
    return {
      success: false,
      error: `Failed to write '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      path: filePath,
    };
  }
}

export async function listDirectory(dirPath: string): Promise<DirectoryResult> {
  const resolved = resolvePath(dirPath);
  const safety = isPathSafe(resolved);
  if (!safety.safe) {
    return { success: false, error: safety.error, path: dirPath };
  }

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const result = await Promise.all(
      entries.map(async (entry) => {
        const type: "file" | "directory" | "symlink" = entry.isDirectory()
          ? "directory"
          : entry.isSymbolicLink()
            ? "symlink"
            : "file";
        let size: number | undefined;
        let modified: string | undefined;
        if (entry.isFile()) {
          try {
            const stat = await fs.stat(path.join(resolved, entry.name));
            size = stat.size;
            modified = stat.mtime.toISOString();
          } catch {
            // ignore stat errors
          }
        }
        return { name: entry.name, type, size, modified };
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
  const searchPath = resolvePath(options?.path ?? ".");
  const safety = isPathSafe(searchPath);
  if (!safety.safe) {
    return {
      success: false,
      error: safety.error,
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
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        await scan(fullPath);
      } else if (entry.isFile()) {
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
          const content = await fs.readFile(fullPath, "utf-8");
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
      const content = await fs.readFile(searchPath, "utf-8");
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
  const resolved = resolvePath(filePath);
  const safety = isPathSafe(resolved);
  if (!safety.safe) {
    return { success: false, error: safety.error, path: filePath };
  }

  try {
    await fs.unlink(resolved);
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
  const srcResolved = resolvePath(source);
  const dstResolved = resolvePath(destination);
  const srcSafety = isPathSafe(srcResolved);
  const dstSafety = isPathSafe(dstResolved);
  if (!srcSafety.safe) {
    return { success: false, error: srcSafety.error, path: source };
  }
  if (!dstSafety.safe) {
    return { success: false, error: dstSafety.error, path: destination };
  }

  try {
    const dir = path.dirname(dstResolved);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
    const postDstSafety = isPathSafe(dstResolved);
    if (!postDstSafety.safe) {
      return { success: false, error: postDstSafety.error, path: destination };
    }
    // 源在重命名前再次校验，防止源在 check 后被替换为外链
    const postSrcSafety = isPathSafe(srcResolved);
    if (!postSrcSafety.safe) {
      return { success: false, error: postSrcSafety.error, path: source };
    }
    await fs.rename(srcResolved, dstResolved);
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
  const resolved = resolvePath(filePath);
  const safety = isPathSafe(resolved);
  if (!safety.safe) return false;
  try {
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

export function getProjectRoot(): string {
  return process.cwd();
}
