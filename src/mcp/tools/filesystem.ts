import * as fs from "node:fs/promises";
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
    // Strict: path must be within cwd (prevent path traversal)
    // Use path.relative to check if path escapes cwd
    const relative = path.relative(cwd, resolved);
    if (relative.startsWith("..") || relative === "..") {
      return {
        safe: false,
        error: `Path '${targetPath}' escapes working directory. Only paths within the project are allowed.`,
      };
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
    await fs.mkdir(dir, { recursive: true });
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
    await fs.mkdir(dir, { recursive: true });
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
