/**
 * GitHub MCP 工具封装
 * 提供 GitHub 仓库管理、Issue/PR、代码审查、发布管理等能力
 *
 * API 文档: https://docs.github.com/en/rest
 * 配置: GITHUB_TOKEN 环境变量 (Personal Access Token 或 Fine-grained Token)
 *
 * 特性:
 * - Repository: list_repos, get_repo, create_repo, fork_repo
 * - Issues: list_issues, create_issue, get_issue, add_comment
 * - Pull Requests: list_prs, create_pr, review_pr, get_pr_files
 * - Code: get_file_contents, list_directory, search_code
 * - Releases: list_releases, create_release
 * - Actions: list_workflows, trigger_workflow, get_workflow_status
 */
import { proxyFetch } from "../../utils/proxy-fetch.js";
import { logger } from "../../utils/logger.js";
import { readString } from "../../utils/env.js";
import { TIMEOUTS } from "../../constants/timeouts.js";
import { withRetry, withTimeout } from "../../utils/resilience.js";

/** GitHub API 配置 */
interface GitHubConfig {
  token: string;
  baseUrl: string;
}

function getGitHubConfig(): GitHubConfig {
  const token = readString("GITHUB_TOKEN");
  if (!token) {
    throw new Error(
      "GitHub token not configured. Set GITHUB_TOKEN environment variable. " +
      "Generate a token at https://github.com/settings/tokens"
    );
  }
  const baseUrl = readString("GITHUB_API_URL", "https://api.github.com");
  return { token, baseUrl };
}

function buildHeaders(config: GitHubConfig): Record<string, string> {
  return {
    "Authorization": `Bearer ${config.token}`,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function callGitHubAPI<T>(
  endpoint: string,
  options?: {
    method?: string;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  }
): Promise<T> {
  const config = getGitHubConfig();
  let url = `${config.baseUrl}${endpoint}`;

  if (options?.params) {
    const searchParams = new URLSearchParams(options.params);
    url += `?${searchParams.toString()}`;
  }

  const response = await withTimeout(
    withRetry(
      async () => {
        const res = await proxyFetch(url, {
          method: options?.method || "GET",
          headers: buildHeaders(config),
          body: options?.body ? JSON.stringify(options.body) : undefined,
        });
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`GitHub API error ${res.status}: ${errorText}`);
        }
        if (res.status === 204) return {} as T;
        return res.json() as Promise<T>;
      },
      { maxAttempts: 2, baseDelay: 500 }
    ),
    TIMEOUTS.API_DEFAULT
  );

  return response;
}

// ==================== Repository Management ====================

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

export async function listRepos(options?: {
  type?: "all" | "owner" | "public" | "private" | "member";
  sort?: "created" | "updated" | "pushed" | "full_name";
  per_page?: number;
  page?: number;
}): Promise<GitHubRepo[]> {
  return callGitHubAPI<GitHubRepo[]>("/user/repos", {
    params: {
      type: options?.type || "owner",
      sort: options?.sort || "updated",
      per_page: String(options?.per_page || 30),
      page: String(options?.page || 1),
    },
  });
}

export async function getRepo(owner: string, repo: string): Promise<GitHubRepo> {
  return callGitHubAPI<GitHubRepo>(`/repos/${owner}/${repo}`);
}

export async function createRepo(options: {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  gitignore_template?: string;
  license_template?: string;
}): Promise<GitHubRepo> {
  return callGitHubAPI<GitHubRepo>("/user/repos", {
    method: "POST",
    body: options,
  });
}

export async function forkRepo(
  owner: string,
  repo: string,
  options?: { organization?: string; name?: string; default_branch_only?: boolean }
): Promise<GitHubRepo> {
  return callGitHubAPI<GitHubRepo>(`/repos/${owner}/${repo}/forks`, {
    method: "POST",
    body: options || {},
  });
}

// ==================== Issues ====================

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: { login: string; avatar_url: string };
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  comments: number;
}

export async function listIssues(
  owner: string,
  repo: string,
  options?: {
    state?: "open" | "closed" | "all";
    labels?: string;
    sort?: "created" | "updated" | "comments";
    direction?: "asc" | "desc";
    per_page?: number;
    page?: number;
  }
): Promise<GitHubIssue[]> {
  return callGitHubAPI<GitHubIssue[]>(`/repos/${owner}/${repo}/issues`, {
    params: {
      state: options?.state || "open",
      labels: options?.labels || "",
      sort: options?.sort || "created",
      direction: options?.direction || "desc",
      per_page: String(options?.per_page || 30),
      page: String(options?.page || 1),
    },
  });
}

export async function getIssue(
  owner: string,
  repo: string,
  issue_number: number
): Promise<GitHubIssue> {
  return callGitHubAPI<GitHubIssue>(`/repos/${owner}/${repo}/issues/${issue_number}`);
}

export async function createIssue(
  owner: string,
  repo: string,
  options: {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestone?: number;
  }
): Promise<GitHubIssue> {
  return callGitHubAPI<GitHubIssue>(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: options,
  });
}

export async function addIssueComment(
  owner: string,
  repo: string,
  issue_number: number,
  body: string
): Promise<{ id: number; body: string; html_url: string }> {
  return callGitHubAPI<{ id: number; body: string; html_url: string }>(
    `/repos/${owner}/${repo}/issues/${issue_number}/comments`,
    { method: "POST", body: { body } }
  );
}

// ==================== Pull Requests ====================

export interface GitHubPR {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  html_url: string;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  comments: number;
  review_comments: number;
}

export async function listPRs(
  owner: string,
  repo: string,
  options?: {
    state?: "open" | "closed" | "all";
    sort?: "created" | "updated" | "popularity" | "long-running";
    direction?: "asc" | "desc";
    per_page?: number;
    page?: number;
  }
): Promise<GitHubPR[]> {
  return callGitHubAPI<GitHubPR[]>(`/repos/${owner}/${repo}/pulls`, {
    params: {
      state: options?.state || "open",
      sort: options?.sort || "created",
      direction: options?.direction || "desc",
      per_page: String(options?.per_page || 30),
      page: String(options?.page || 1),
    },
  });
}

export async function getPR(
  owner: string,
  repo: string,
  pull_number: number
): Promise<GitHubPR> {
  return callGitHubAPI<GitHubPR>(`/repos/${owner}/${repo}/pulls/${pull_number}`);
}

export async function createPR(
  owner: string,
  repo: string,
  options: {
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }
): Promise<GitHubPR> {
  return callGitHubAPI<GitHubPR>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: options,
  });
}

export async function reviewPR(
  owner: string,
  repo: string,
  pull_number: number,
  options: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body?: string;
    comments?: Array<{
      path: string;
      position?: number;
      line?: number;
      body: string;
    }>;
  }
): Promise<{ id: number; state: string }> {
  return callGitHubAPI<{ id: number; state: string }>(
    `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`,
    { method: "POST", body: options }
  );
}

export async function getPRFiles(
  owner: string,
  repo: string,
  pull_number: number
): Promise<Array<{
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}>> {
  return callGitHubAPI<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }>
  >(`/repos/${owner}/${repo}/pulls/${pull_number}/files`);
}

// ==================== Code ====================

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: "file" | "dir";
  content?: string;
  encoding?: string;
}

export async function getFileContents(
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<GitHubFileContent> {
  const params: Record<string, string> = {};
  if (ref) params.ref = ref;
  return callGitHubAPI<GitHubFileContent>(`/repos/${owner}/${repo}/contents/${path}`, {
    params,
  });
}

export async function listDirectory(
  owner: string,
  repo: string,
  path: string = "",
  ref?: string
): Promise<GitHubFileContent[]> {
  const params: Record<string, string> = {};
  if (ref) params.ref = ref;
  return callGitHubAPI<GitHubFileContent[]>(
    `/repos/${owner}/${repo}/contents/${path}`,
    { params }
  );
}

export async function searchCode(
  query: string,
  options?: {
    owner?: string;
    repo?: string;
    per_page?: number;
    page?: number;
  }
): Promise<{
  total_count: number;
  items: Array<{
    name: string;
    path: string;
    html_url: string;
    repository: { full_name: string };
    score: number;
  }>;
}> {
  let q = query;
  if (options?.owner && options?.repo) {
    q += ` repo:${options.owner}/${options.repo}`;
  }

  return callGitHubAPI<{
    total_count: number;
    items: Array<{
      name: string;
      path: string;
      html_url: string;
      repository: { full_name: string };
      score: number;
    }>;
  }>("/search/code", {
    params: {
      q,
      per_page: String(options?.per_page || 30),
      page: String(options?.page || 1),
    },
  });
}

// ==================== Releases ====================

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  author: { login: string };
  created_at: string;
  published_at: string;
  assets: Array<{
    name: string;
    size: number;
    download_count: number;
    browser_download_url: string;
  }>;
}

export async function listReleases(
  owner: string,
  repo: string,
  options?: { per_page?: number; page?: number }
): Promise<GitHubRelease[]> {
  return callGitHubAPI<GitHubRelease[]>(`/repos/${owner}/${repo}/releases`, {
    params: {
      per_page: String(options?.per_page || 30),
      page: String(options?.page || 1),
    },
  });
}

export async function createRelease(
  owner: string,
  repo: string,
  options: {
    tag_name: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    target_commitish?: string;
  }
): Promise<GitHubRelease> {
  return callGitHubAPI<GitHubRelease>(`/repos/${owner}/${repo}/releases`, {
    method: "POST",
    body: options,
  });
}

// ==================== Actions (Workflows) ====================

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_number: number;
  event: string;
}

export async function listWorkflows(
  owner: string,
  repo: string
): Promise<{ workflows: GitHubWorkflow[] }> {
  return callGitHubAPI<{ workflows: GitHubWorkflow[] }>(
    `/repos/${owner}/${repo}/actions/workflows`
  );
}

export async function triggerWorkflow(
  owner: string,
  repo: string,
  workflow_id: string | number,
  options: {
    ref: string;
    inputs?: Record<string, string>;
  }
): Promise<void> {
  await callGitHubAPI<void>(
    `/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`,
    { method: "POST", body: options }
  );
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  options?: {
    workflow_id?: string | number;
    status?: "completed" | "action_required" | "cancelled" | "failure" | "neutral";
    per_page?: number;
    page?: number;
  }
): Promise<{ workflow_runs: GitHubWorkflowRun[] }> {
  const endpoint = options?.workflow_id
    ? `/repos/${owner}/${repo}/actions/workflows/${options.workflow_id}/runs`
    : `/repos/${owner}/${repo}/actions/runs`;

  return callGitHubAPI<{ workflow_runs: GitHubWorkflowRun[] }>(endpoint, {
    params: {
      status: options?.status || "",
      per_page: String(options?.per_page || 30),
      page: String(options?.page || 1),
    },
  });
}

export async function getWorkflowRun(
  owner: string,
  repo: string,
  run_id: number
): Promise<GitHubWorkflowRun> {
  return callGitHubAPI<GitHubWorkflowRun>(
    `/repos/${owner}/${repo}/actions/runs/${run_id}`
  );
}

// ==================== Health Check ====================

export async function checkGitHubHealth(): Promise<{
  ok: boolean;
  latency: number;
  user?: string;
  error?: string;
}> {
  const start = Date.now();
  try {
    const config = getGitHubConfig();
    const res = await proxyFetch(`${config.baseUrl}/user`, {
      method: "GET",
      headers: buildHeaders(config),
    });

    if (res.ok) {
      const data = (await res.json()) as { login: string };
      return { ok: true, latency: Date.now() - start, user: data.login };
    }

    const errorText = await res.text();
    return {
      ok: false,
      latency: Date.now() - start,
      error: `HTTP ${res.status}: ${errorText}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, latency: Date.now() - start, error: message };
  }
}

export function getGitHubInfo(): {
  configured: boolean;
  baseUrl: string;
  tokenPrefix: string;
} {
  try {
    const config = getGitHubConfig();
    return {
      configured: true,
      baseUrl: config.baseUrl,
      tokenPrefix: config.token.substring(0, 6) + "...",
    };
  } catch {
    return {
      configured: false,
      baseUrl: "",
      tokenPrefix: "",
    };
  }
}
