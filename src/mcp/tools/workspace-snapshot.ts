import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { logger } from "../../utils/logger.js";

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
  return path.join(process.cwd(), ".axiom", "snapshots");
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
    const output = execSync(
      "git ls-files --others --exclude-standard --cached 2>nul || echo ''",
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
    const cwd = process.cwd();
    const files = getWorkspaceFiles();

    if (files.length === 0) {
      return {
        success: false,
        error: "No workspace files found to snapshot",
      };
    }

    // Copy files to snapshot directory
    for (const file of files) {
      const src = path.join(cwd, file);
      const dst = path.join(snapshotDir, file);
      try {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      } catch (e) {
        logger.warn(`Failed to copy ${file} for snapshot: ` + e);
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
    const cwd = process.cwd();
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
    for (const file of files) {
      try {
        const content = execFileSync("git", ["show", `${snapshotId}:${file}`], {
          cwd: snapshotDir,
          encoding: "utf-8",
          stdio: "pipe",
        });
        const dst = path.join(cwd, file);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.writeFile(dst, content, "utf-8");
      } catch (e) {
        logger.warn(`Failed to restore ${file}: ` + e);
      }
    }

    return {
      success: true,
      snapshotId,
      message: `Reverted to snapshot ${snapshotId}`,
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
        const src = path.join(cwd, file);
        const dst = path.join(snapshotDir, file);
        if (existsSync(src)) {
          await fs.mkdir(path.dirname(dst), { recursive: true });
          await fs.copyFile(src, dst);
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
