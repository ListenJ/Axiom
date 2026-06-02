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
  let cmd = "git diff";
  if (options?.staged) {
    cmd += " --staged";
  }
  if (options?.since) {
    cmd += ` ${options.since}..HEAD`;
  }
  if (options?.file) {
    cmd += ` -- "${options.file}"`;
  }
  cmd += " --stat";

  const result = await executeCommand(cmd, { cwd: repoPath, timeout: 15000 });

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
    const diffResult = await executeCommand(
      `git diff${options.staged ? " --staged" : ""} -- "${options.file}"`,
      { cwd: repoPath, timeout: 15000 }
    );
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
  let cmd = 'git log --pretty=format:"%H|%h|%s|%an|%ai|%D"';
  if (options?.maxCount) {
    cmd += ` -n ${options.maxCount}`;
  } else {
    cmd += " -n 20";
  }
  if (options?.file) {
    cmd += ` -- "${options.file}"`;
  }
  if (options?.author) {
    cmd += ` --author="${options.author}"`;
  }
  if (options?.since) {
    cmd += ` --since="${options.since}"`;
  }
  if (options?.grep) {
    cmd += ` --grep="${options.grep}"`;
  }

  const result = await executeCommand(cmd, { cwd: repoPath, timeout: 15000 });

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
  const result = await executeCommand(`git show --stat ${ref}`, {
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
  let cmd = `git blame --porcelain "${file}"`;
  if (line) {
    cmd += ` -L ${line},${line + 20}`;
  }

  const result = await executeCommand(cmd, { cwd: repoPath, timeout: 15000 });

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
