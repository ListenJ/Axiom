import { executeCommand } from "./terminal.js";

export interface GitStatusResult {
  success: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  modified?: string[];
  added?: string[];
  deleted?: string[];
  untracked?: string[];
  conflicted?: string[];
  clean?: boolean;
  error?: string;
}

export interface GitDiffResult {
  success: boolean;
  diff?: string;
  files?: Array<{
    path: string;
    status: "modified" | "added" | "deleted" | "renamed";
    additions?: number;
    deletions?: number;
  }>;
  error?: string;
}

export interface GitLogResult {
  success: boolean;
  commits?: Array<{
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
    refs?: string;
  }>;
  error?: string;
}

export interface GitBranchResult {
  success: boolean;
  current?: string;
  branches?: Array<{
    name: string;
    current: boolean;
    remote?: boolean;
  }>;
  error?: string;
}

export async function gitStatus(
  repoPath: string = "."
): Promise<GitStatusResult> {
  const result = await executeCommand("git status --porcelain --branch", {
    cwd: repoPath,
    timeout: 10000,
  });

  if (!result.success && result.exitCode !== 0) {
    return {
      success: false,
      error: result.stderr || result.error || "git status failed",
    };
  }

  const lines = result.stdout.split("\n").filter((l) => l.length > 0);
  const status: GitStatusResult = {
    success: true,
    modified: [],
    added: [],
    deleted: [],
    untracked: [],
    conflicted: [],
    clean: true,
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Branch info: ## master...origin/master [ahead 2, behind 1]
      const branchInfo = line.substring(3);
      const match = branchInfo.match(/^([^\.\s]+)(?:\.\.\.(\S+))?\s*(?:\[([^\]]+)\])?/);
      if (match) {
        status.branch = match[1];
        const aheadBehind = match[3];
        if (aheadBehind) {
          const aheadMatch = aheadBehind.match(/ahead\s+(\d+)/);
          const behindMatch = aheadBehind.match(/behind\s+(\d+)/);
          if (aheadMatch) status.ahead = parseInt(aheadMatch[1], 10);
          if (behindMatch) status.behind = parseInt(behindMatch[1], 10);
        }
      }
      continue;
    }

    if (line.length < 2) continue;

    const code = line.substring(0, 2);
    const file = line.substring(3).trim();

    status.clean = false;

    // XY format: X=index, Y=working tree
    if (code === "??") {
      status.untracked!.push(file);
    } else if (code === "UU" || code === "AA" || code === "DD") {
      status.conflicted!.push(file);
    } else if (code.startsWith("D") || code.endsWith("D")) {
      status.deleted!.push(file);
    } else if (code.startsWith("A") || code.startsWith("?")) {
      status.added!.push(file);
    } else {
      status.modified!.push(file);
    }
  }

  return status;
}

export async function gitDiff(
  repoPath: string = ".",
  options?: {
    staged?: boolean;
    file?: string;
    since?: string;
  }
): Promise<GitDiffResult> {
  // S3 审计修复（2026-08-25）：file/since 等客户端可控参数改走数组通道，
  // 不经 shell 解释，注入面消除（since 字符集校验保留作纵深防御）。
  if (options?.since !== undefined && !/^[A-Za-z0-9._\-\/]+$/.test(options.since)) {
    return {
      success: false,
      error: "Invalid revision: contains unsafe characters",
    };
  }
  const diffArgs = ["diff"];
  if (options?.staged) {
    diffArgs.push("--staged");
  }
  if (options?.since) {
    diffArgs.push(`${options.since}..HEAD`);
  }
  if (options?.file) {
    diffArgs.push("--", options.file);
  }
  diffArgs.push("--stat");

  const result = await executeCommand("git", { args: diffArgs, cwd: repoPath, timeout: 15000 });

  if (!result.success) {
    return {
      success: false,
      error: result.stderr || result.error || "git diff failed",
    };
  }

  const files: Array<{
    path: string;
    status: "modified" | "added" | "deleted" | "renamed";
    additions?: number;
    deletions?: number;
  }> = [];

  const lines = result.stdout.split("\n").filter((l) => l.includes("|") && !l.startsWith(" "));
  for (const line of lines) {
    const match = line.match(/^(.+?)\s*\|\s*(\d+)\s*([\+\-]*)/);
    if (match) {
      const adds = (match[3].match(/\+/g) || []).length;
      const dels = (match[3].match(/\-/g) || []).length;
      files.push({
        path: match[1].trim(),
        status: "modified",
        additions: adds,
        deletions: dels,
      });
    }
  }

  // Also get full diff if a specific file was requested
  let fullDiff: string | undefined;
  if (options?.file) {
    const fullDiffArgs = ["diff"];
    if (options.staged) {
      fullDiffArgs.push("--staged");
    }
    fullDiffArgs.push("--", options.file);
    const diffResult = await executeCommand("git", {
      args: fullDiffArgs,
      cwd: repoPath,
      timeout: 15000,
    });
    if (diffResult.success) {
      fullDiff = diffResult.stdout;
    }
  }

  return { success: true, diff: fullDiff, files };
}

export async function gitLog(
  repoPath: string = ".",
  options?: {
    maxCount?: number;
    file?: string;
    author?: string;
    since?: string;
    grep?: string;
  }
): Promise<GitLogResult> {
  // S3 审计修复（2026-08-25）：author/since/grep/file 客户端可控参数全走数组通道，
  // 不经 shell 解释（原引号转义在 cmd /c 下不可靠）。
  const logArgs = [
    "log",
    "--pretty=format:%H|%h|%s|%an|%ai|%D",
    "-n",
    String(options?.maxCount || 20),
  ];
  if (options?.file) {
    logArgs.push("--", options.file);
  }
  if (options?.author) {
    logArgs.push(`--author=${options.author}`);
  }
  if (options?.since) {
    logArgs.push(`--since=${options.since}`);
  }
  if (options?.grep) {
    logArgs.push(`--grep=${options.grep}`);
  }

  const result = await executeCommand("git", { args: logArgs, cwd: repoPath, timeout: 15000 });

  if (!result.success) {
    return {
      success: false,
      error: result.stderr || result.error || "git log failed",
    };
  }

  const commits: Array<{
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
    refs?: string;
  }> = [];

  const lines = result.stdout.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length >= 5) {
      commits.push({
        hash: parts[0],
        shortHash: parts[1],
        message: parts[2],
        author: parts[3],
        date: parts[4],
        refs: parts[5] || undefined,
      });
    }
  }

  return { success: true, commits };
}

export async function gitBranch(
  repoPath: string = "."
): Promise<GitBranchResult> {
  const result = await executeCommand("git branch -a", {
    cwd: repoPath,
    timeout: 10000,
  });

  if (!result.success) {
    return {
      success: false,
      error: result.stderr || result.error || "git branch failed",
    };
  }

  const branches: Array<{
    name: string;
    current: boolean;
    remote?: boolean;
  }> = [];
  let current: string | undefined;

  const lines = result.stdout.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    const trimmed = line.trim();
    const isCurrent = trimmed.startsWith("* ");
    const name = isCurrent ? trimmed.substring(2).trim() : trimmed;
    const isRemote = name.startsWith("remotes/");
    const cleanName = isRemote ? name.substring(8) : name;

    branches.push({
      name: cleanName,
      current: isCurrent,
      remote: isRemote,
    });

    if (isCurrent) {
      current = cleanName;
    }
  }

  return { success: true, current, branches };
}

export async function gitShow(
  repoPath: string = ".",
  ref: string = "HEAD"
): Promise<{ success: boolean; content?: string; error?: string }> {
  // Validate ref to prevent command injection (only allow safe characters)
  const safeRef = ref.replace(/[^a-zA-Z0-9_\-\.\/\^~@{}]/g, "");
  if (safeRef !== ref) {
    return {
      success: false,
      error: "Invalid git ref: contains unsafe characters",
    };
  }
  const result = await executeCommand(`git show --stat ${safeRef}`, {
    cwd: repoPath,
    timeout: 10000,
  });

  if (!result.success) {
    return {
      success: false,
      error: result.stderr || result.error || "git show failed",
    };
  }

  return { success: true, content: result.stdout };
}

export async function gitBlame(
  repoPath: string = ".",
  file: string,
  line?: number
): Promise<{
  success: boolean;
  lines?: Array<{
    commit: string;
    author: string;
    date: string;
    line: string;
    lineNumber: number;
  }>;
  error?: string;
}> {
  // S3 审计修复（2026-08-25）：file 客户端可控，改走数组通道不经 shell 解释
  const blameArgs = ["blame", "--porcelain"];
  if (line) {
    blameArgs.push("-L", `${line},${line + 20}`);
  }
  blameArgs.push("--", file);

  const result = await executeCommand("git", { args: blameArgs, cwd: repoPath, timeout: 15000 });

  if (!result.success) {
    return {
      success: false,
      error: result.stderr || result.error || "git blame failed",
    };
  }

  const lines: Array<{
    commit: string;
    author: string;
    date: string;
    line: string;
    lineNumber: number;
  }> = [];

  const rawLines = result.stdout.split("\n");
  let currentCommit = "";
  let currentAuthor = "";
  let currentDate = "";
  let lineNumber = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.match(/^[a-f0-9]{40}/)) {
      const parts = line.split(" ");
      currentCommit = parts[0];
      lineNumber = parseInt(parts[2], 10);
    } else if (line.startsWith("author ")) {
      currentAuthor = line.substring(7);
    } else if (line.startsWith("author-time ")) {
      const ts = parseInt(line.substring(12), 10);
      currentDate = new Date(ts * 1000).toISOString();
    } else if (line.startsWith("\t")) {
      lines.push({
        commit: currentCommit.substring(0, 8),
        author: currentAuthor,
        date: currentDate,
        line: line.substring(1),
        lineNumber,
      });
    }
  }

  return { success: true, lines };
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  shortHash?: string;
  message?: string;
  files?: string[];
  error?: string;
}

/**
 * Git commit — stage 指定文件（或全部）并提交。
 * S3 审计修复（2026-08-25）：message 与 files 客户端全可控，原引号转义在
 * cmd /c 下不可靠（%VAR%/命令替换在双引号内仍生效）→ 全部改走数组通道，
 * 参数逐项传递不经 shell，注入面消除。
 */
export async function gitCommit(
  repoPath: string = ".",
  message: string,
  files?: string[]
): Promise<GitCommitResult> {
  if (!message || !message.trim()) {
    return { success: false, error: "commit message is required" };
  }

  // Stage files (or all changes if no files specified)
  if (files && files.length > 0) {
    const addResult = await executeCommand("git", {
      args: ["add", "--", ...files],
      cwd: repoPath,
      timeout: 10000,
    });
    if (!addResult.success) {
      return {
        success: false,
        error: addResult.stderr || addResult.error || "git add failed",
      };
    }
  } else {
    const addResult = await executeCommand("git add -A", {
      cwd: repoPath,
      timeout: 10000,
    });
    if (!addResult.success) {
      return {
        success: false,
        error: addResult.stderr || addResult.error || "git add failed",
      };
    }
  }

  // Commit with message (array channel — message passed verbatim, no shell interpretation)
  const commitResult = await executeCommand("git", {
    args: ["commit", "-m", message],
    cwd: repoPath,
    timeout: 15000,
  });

  if (!commitResult.success) {
    // "nothing to commit" is not a hard error
    if (commitResult.stdout?.includes("nothing to commit")) {
      return {
        success: true,
        message: "nothing to commit, working tree clean",
        files: [],
      };
    }
    return {
      success: false,
      error: commitResult.stderr || commitResult.error || "git commit failed",
    };
  }

  // Get the commit hash
  const hashResult = await executeCommand("git rev-parse HEAD", {
    cwd: repoPath,
    timeout: 5000,
  });
  const hash = hashResult.success ? hashResult.stdout.trim() : undefined;
  const shortHash = hash ? hash.substring(0, 8) : undefined;

  // Get staged files list
  const diffResult = await executeCommand(
    "git diff-tree --no-commit-id --name-only -r HEAD",
    { cwd: repoPath, timeout: 5000 }
  );
  const committedFiles = diffResult.success
    ? diffResult.stdout.split("\n").filter((l) => l.length > 0)
    : [];

  return {
    success: true,
    hash,
    shortHash,
    message,
    files: committedFiles,
  };
}

export interface GitPushResult {
  success: boolean;
  remote?: string;
  branch?: string;
  pushed?: string[];
  error?: string;
}

/**
 * Git push — 推送当前分支到指定 remote（默认 origin）。
 */
export async function gitPush(
  repoPath: string = ".",
  options?: { remote?: string; branch?: string; force?: boolean }
): Promise<GitPushResult> {
  const remote = options?.remote || "origin";

  // Get current branch if not specified
  let branch = options?.branch;
  if (!branch) {
    const branchResult = await executeCommand(
      "git rev-parse --abbrev-ref HEAD",
      { cwd: repoPath, timeout: 5000 }
    );
    if (!branchResult.success) {
      return {
        success: false,
        error: branchResult.stderr || "failed to detect current branch",
      };
    }
    branch = branchResult.stdout.trim();
  }

  // Validate remote and branch names (prevent injection)
  const safeRemote = remote.replace(/[^a-zA-Z0-9_\-\/\.]/g, "");
  const safeBranch = branch.replace(/[^a-zA-Z0-9_\-\/\.]/g, "");
  if (safeRemote !== remote || safeBranch !== branch) {
    return {
      success: false,
      error: "invalid remote or branch name: contains unsafe characters",
    };
  }

  const forceFlag = options?.force ? " --force-with-lease" : "";
  const pushResult = await executeCommand(
    `git push ${safeRemote} ${safeBranch}${forceFlag}`,
    { cwd: repoPath, timeout: 30000 }
  );

  if (!pushResult.success) {
    return {
      success: false,
      remote: safeRemote,
      branch: safeBranch,
      error: pushResult.stderr || pushResult.error || "git push failed",
    };
  }

  return {
    success: true,
    remote: safeRemote,
    branch: safeBranch,
    pushed: [`${safeRemote}/${safeBranch}`],
  };
}
