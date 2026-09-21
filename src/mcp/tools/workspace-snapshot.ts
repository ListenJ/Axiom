import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { logger } from "../../utils/logger.js";
import {
  readFile as safeReadFile,
  writeFile as safeWriteFile,
} from "../../utils/safe-fs.js";

/** 快照目录相对工作区根的路径（safeFs 的判定以此为基准，不用绝对路径绕过逐跳） */
const SNAPSHOT_REL = ".axiom/snapshots";
const PRINCIPAL = "mcp:workspace-snapshot";

/**
 * 把工作区文件复制进快照树。读写都过 safeFs（S3 / I2）：
 * 锚点文件（.env、运行时库、git 元数据）既读不到也写不进快照树，
 * 否则等于把凭据二次落地到一个可被还原/读回的位置。
 */
async function copyIntoSnapshot(file: string): Promise<void> {
  const content = await safeReadFile(file, { principal: PRINCIPAL });
  await safeWriteFile(path.join(SNAPSHOT_REL, file), content, { principal: PRINCIPAL });
}

/** snapshotId 白名单校验（P1-T5）：仅 HEAD 或 6-64 位十六进制，防 git 选项/引用注入 */
export function assertValidSnapshotId(id: string): void {
  if (!/^(HEAD|[0-9a-fA-F]{6,64})$/.test(id)) {
    throw new Error(`Invalid snapshotId: ${id.slice(0, 32)}`);
  }
}

export interface SnapshotResult {
  success: boolean;
  snapshotId?: string;
  message?: string;
  error?: string;
  /** 整改 D5（2026-08-25）：部分文件恢复失败时的失败路径列表（success=false 时提供） */
  errors?: string[];
  timestamp?: string;
}

export interface SnapshotListResult {
  success: boolean;
  snapshots?: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: string;
  }>;
  error?: string;
}

export interface SnapshotDiffResult {
  success: boolean;
  diff?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  error?: string;
}

function getSnapshotDir(): string {
  return path.join(process.cwd(), SNAPSHOT_REL);
}

function ensureSnapshotRepo(): string {
  const snapshotDir = getSnapshotDir();
  if (!existsSync(path.join(snapshotDir, ".git"))) {
    try {
      execSync("git init", { cwd: snapshotDir, stdio: "pipe" });
      execSync('git config user.email "axiom@local"', { cwd: snapshotDir, stdio: "pipe" });
      execSync('git config user.name "Axiom"', { cwd: snapshotDir, stdio: "pipe" });
    } catch (e) {
      logger.warn("Failed to init snapshot repo: " + e);
    }
  }
  return snapshotDir;
}

function getWorkspaceFiles(): string[] {
  const cwd = process.cwd();
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--cached"],
      { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !f.includes(".axiom/"));
  } catch {
    // Fallback: use find/dir
    try {
      const output = execSync(
        'find . -type f -not -path "*/\\.git/*" -not -path "*/node_modules/*" -not -path "*/\\.axiom/*" 2>/dev/null',
        { cwd, encoding: "utf-8" }
      );
      return output
        .split("\n")
        .map((f) => f.replace(/^\.\//, ""))
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }
}

export async function createSnapshot(
  message?: string
): Promise<SnapshotResult> {
  try {
    const snapshotDir = ensureSnapshotRepo();
    const files = getWorkspaceFiles();

    if (files.length === 0) {
      return {
        success: false,
        error: "No workspace files found to snapshot",
      };
    }

    // Copy files to snapshot directory
    for (const file of files) {
      try {
        await copyIntoSnapshot(file);
      } catch (e) {
        logger.warn(`Skipped ${file} for snapshot: ` + e);
      }
    }

    // Stage and commit
    const timestamp = new Date().toISOString();
    const commitMsg = message || `Snapshot at ${timestamp}`;

    try {
      execSync("git add -A", { cwd: snapshotDir, stdio: "pipe" });
      const result = execFileSync(
        "git",
        ["commit", "-m", commitMsg, "--allow-empty"],
        { cwd: snapshotDir, encoding: "utf-8", stdio: "pipe" }
      );
      const hashMatch = result.match(/\[.*?([a-f0-9]{7,})/);
      const snapshotId = hashMatch ? hashMatch[1] : undefined;

      return {
        success: true,
        snapshotId,
        message: commitMsg,
        timestamp,
      };
    } catch (e: unknown) {
      // If nothing to commit, still return success
      const execError = e as { stdout?: string; stderr?: string };
      if (execError.stdout?.includes("nothing to commit") || execError.stderr?.includes("nothing to commit")) {
        return {
          success: true,
          message: commitMsg,
          timestamp,
          error: "No changes since last snapshot",
        };
      }
      throw e;
    }
  } catch (error) {
    logger.error("Failed to create snapshot: " + error);
    return {
      success: false,
      error: `Snapshot failed: ${error}`,
    };
  }
}

export async function revertSnapshot(
  snapshotId: string
): Promise<SnapshotResult> {
  try {
    const snapshotDir = getSnapshotDir();
    assertValidSnapshotId(snapshotId);

    // Validate snapshot exists
    try {
      execFileSync("git", ["cat-file", "-t", snapshotId], {
        cwd: snapshotDir,
        stdio: "pipe",
      });
    } catch {
      return {
        success: false,
        error: `Snapshot ${snapshotId} not found`,
      };
    }

    // Get list of files at that snapshot
    const filesOutput = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", snapshotId],
      { cwd: snapshotDir, encoding: "utf-8", stdio: "pipe" }
    );
    const files = filesOutput.split("\n").filter((f) => f.trim());

    // Restore each file
    // 整改 D5（2026-08-25）：execFileSync 不带 encoding 得 Buffer 原样写盘，
    // 保证二进制文件逐字节保真；单文件失败不再静默吞掉，聚合进 errors。
    const failures: string[] = [];
    for (const file of files) {
      try {
        const content = execFileSync("git", ["show", `${snapshotId}:${file}`], {
          cwd: snapshotDir,
          stdio: "pipe",
        });
        // 落点来自 git ls-tree，属外部可控输入：一律经 safeFs 判定后再写。
        // 锚点（.git/hooks、.env、CI 工作流、运行时库…）拒写 —— 还原不得成为写锚点的旁路（S3 / L1）。
        // safeFs.writeFile 内部已 mkdir -p 父目录，无需另行建目录。
        await safeWriteFile(file, content, { principal: PRINCIPAL });
      } catch (e) {
        logger.warn(`Failed to restore ${file}: ` + e);
        failures.push(file);
      }
    }

    return {
      success: failures.length === 0,
      snapshotId,
      message: `Reverted to snapshot ${snapshotId}`,
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
  } catch (error) {
    logger.error("Failed to revert snapshot: " + error);
    return {
      success: false,
      error: `Revert failed: ${error}`,
    };
  }
}

export async function listSnapshots(): Promise<SnapshotListResult> {
  try {
    const snapshotDir = getSnapshotDir();
    if (!existsSync(path.join(snapshotDir, ".git"))) {
      return {
        success: true,
        snapshots: [],
      };
    }

    const output = execSync(
      'git log --pretty=format:"%h|%s|%ci|%an" --all',
      { cwd: snapshotDir, encoding: "utf-8", stdio: "pipe" }
    );

    const snapshots = output
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const [id, message, timestamp, author] = line.split("|");
        return {
          id: id || "",
          message: message || "",
          timestamp: timestamp || "",
          author: author || "Axiom",
        };
      });

    return {
      success: true,
      snapshots,
    };
  } catch {
    return {
      success: true,
      snapshots: [],
    };
  }
}

export async function diffSnapshot(
  snapshotId?: string
): Promise<SnapshotDiffResult> {
  try {
    const snapshotDir = getSnapshotDir();
    const cwd = process.cwd();

    let diffOutput: string;
    let statOutput: string;

    if (snapshotId) {
      // Diff between current workspace and snapshot
      // We need to stage current workspace, then diff
      const currentFiles = getWorkspaceFiles();
      for (const file of currentFiles) {
        if (existsSync(path.join(cwd, file))) {
          try {
            await copyIntoSnapshot(file);
          } catch (e) {
            logger.warn(`Skipped ${file} for diff: ` + e);
          }
        }
      }
      execSync("git add -A", { cwd: snapshotDir, stdio: "pipe" });
      if (snapshotId) assertValidSnapshotId(snapshotId);
      diffOutput = execFileSync("git", ["diff", "--cached", snapshotId], {
        cwd: snapshotDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      statOutput = execFileSync("git", ["diff", "--cached", "--stat", snapshotId], {
        cwd: snapshotDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } else {
      // Diff between last two snapshots
      diffOutput = execSync("git diff HEAD~1 HEAD", {
        cwd: snapshotDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
      statOutput = execSync("git diff --stat HEAD~1 HEAD", {
        cwd: snapshotDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
    }

    // Parse stats
    const statLines = statOutput.split("\n");
    const lastLine = statLines[statLines.length - 2] || "";
    const fileMatch = lastLine.match(/(\d+) files? changed/);
    const insertMatch = lastLine.match(/(\d+) insertions?/);
    const deleteMatch = lastLine.match(/(\d+) deletions?/);

    return {
      success: true,
      diff: diffOutput,
      filesChanged: fileMatch ? parseInt(fileMatch[1]) : 0,
      insertions: insertMatch ? parseInt(insertMatch[1]) : 0,
      deletions: deleteMatch ? parseInt(deleteMatch[1]) : 0,
    };
  } catch (error) {
    return {
      success: false,
      error: `Diff failed: ${error}`,
    };
  }
}

export async function getCurrentSnapshotId(): Promise<
  string | undefined
> {
  try {
    const snapshotDir = getSnapshotDir();
    return execSync("git rev-parse --short HEAD", {
      cwd: snapshotDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return undefined;
  }
}

export function getSnapshotStatus(): {
  enabled: boolean;
  snapshotDir: string;
  currentId?: string;
} {
  const snapshotDir = getSnapshotDir();
  const enabled = existsSync(path.join(snapshotDir, ".git"));
  const currentId = enabled
    ? (() => {
        try {
          return execSync("git rev-parse --short HEAD", {
            cwd: snapshotDir,
            encoding: "utf-8",
            stdio: "pipe",
          }).trim();
        } catch {
          return undefined;
        }
      })()
    : undefined;

  return { enabled, snapshotDir, currentId };
}
