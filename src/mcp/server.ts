/**
 * MCP 服务器入口 v2.2
 * 基于 @modelcontextprotocol/sdk，使用 ToolRegistry 统一注册，消除 stdio/HTTP 重复
 *
 * 所有记忆操作通过 Obsidian Vault 文件系统进行，确保所有 Agent 共享同一记忆库。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { DataPipeline } from "../crawl/data-pipeline.js";
import { searchAggregator } from "../crawl/search-engines.js";
import { SerpApiClient } from "../crawl/serpapi-client.js";
import { getGlobalVault } from "../memory/vault-manager.js";
import { withRetry, withTimeout } from "../utils/resilience.js";
import { logger } from "../utils/logger.js";
import { TIMEOUTS } from "../constants/timeouts.js";
import { registerVaultTools, registerWebTools } from "./server/vault-tools.js";
import { registerSkillTools } from "./server/skill-tools.js";
import { registerDreTools, shutdownKernel } from "./server/dre-tools.js";
import { registerKgTools } from "./server/kg-tools.js";
import { registerCodeAgentTools } from "./server/code-agent-tools.js";
import { registerHermesTools } from "./server/hermes-tools.js";
import { registerRouterTools } from "./server/router-tools.js";
import { registerDbTools } from "./server/db-tools.js";
import { registerLspTools } from "./server/lsp-tools.js";
import { registerTokenTools } from "./server/token-tools.js";
import { registerModeTools } from "./server/mode-tools.js";
import { registerArenaTools } from "./server/arena-tools.js";
import { registerPromptTools } from "./server/prompt-tools.js";
import { registerOrchestratorTools } from "./server/orchestrator-tools.js";
import { SceneRouter, DEFAULT_SCENES } from "./scene-router.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  createSnapshot,
  revertSnapshot,
  listSnapshots,
  diffSnapshot,
  getSnapshotStatus,
} from "./tools/workspace-snapshot.js";
import {
  listRepos,
  getRepo,
  createRepo,
  forkRepo,
  listIssues,
  createIssue,
  addIssueComment,
  listPRs,
  getPR,
  createPR,
  reviewPR,
  getPRFiles,
  getFileContents,
  listDirectory as listGitHubDirectory,
  searchCode as searchGitHubCode,
  listReleases,
  createRelease,
  listWorkflows,
  triggerWorkflow,
  listWorkflowRuns,
  getWorkflowRun,
  checkGitHubHealth,
  getGitHubInfo,
  getIssue as getGitHubIssue,
} from "./tools/github.js";
import { getProxyStatus } from "../utils/adaptive-proxy.js";
import { registerExternalTools } from "./register-external-tools.js";
import { readString } from "../utils/env.js";
import { adaptTools } from "./adapt-tool.js";
import { readTool } from "../tools/read-tool.js";
import { writeTool } from "../tools/write-tool.js";
import { queryTool } from "../tools/query-tool.js";


const dbPath = readString("DATABASE_PATH", "./data/agent.db");
const db = new Database(dbPath);

// 初始化 Vault（共享记忆库）
const vault = getGlobalVault();

const mcp = new McpServer({
  name: "Axiom Agent MCP Server",
  version: "2.9.2",
});

// ===== 工具定义（单一事实来源） =====

const registry = new ToolRegistry();

// Register self-contained external tools (MiniMax / fs / terminal / git / code-analysis).
// Moved to mcp/register-external-tools.ts to reduce this file from ~3500 to ~3200 lines.
// Remaining internal tools (memory, scene, pipeline, dre, kg, persona …) follow below.
registerExternalTools(registry);

// -- Pipeline 通用工具 (缓存优先/循环检测/进度/资源限制) --
for (const td of adaptTools([readTool, writeTool, queryTool])) registry.add(td);

registerVaultTools(registry, vault);

const pipeline = new DataPipeline();
registerWebTools(registry, pipeline);

// -- SerpAPI 深度搜索工具 --
registry.add({
  name: "serpapi_search",
  description: "使用 SerpAPI 执行 Google 深度搜索，结果以结构化 Markdown 保存到 Vault，含完整原始 JSON",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    location: z.string().optional().describe("地理位置"),
    lang: z.string().optional().default("en").describe("界面语言"),
    region: z.string().optional().default("us").describe("国家代码"),
    num: z.number().optional().default(10).describe("结果数量 1-100"),
    safe: z.enum(["active", "off"]).optional().default("active").describe("安全搜索"),
    timeRange: z.string().optional().describe("时间范围"),
    site: z.string().optional().describe("限定站点"),
    saveToVault: z.boolean().optional().default(true).describe("是否保存到 Vault"),
  },
  handler: async (args) => {
    const client = new SerpApiClient();
    const start = performance.now();
    const response = await client.search({
      q: args.query as string,
      location: args.location as string,
      hl: args.lang as string,
      gl: args.region as string,
      num: Math.min((args.num as number) || 10, 100),
      safe: args.safe as "active" | "off",
      ...(args.timeRange ? { tbs: args.timeRange as string } : {}),
      ...(args.site ? { as_sitesearch: args.site as string } : {}),
    });
    const latency = Math.round(performance.now() - start);

    let vaultPath = "";
    if (args.saveToVault !== false) {
      vaultPath = await vault.writeSerpApiResult(args.query as string, response as Record<string, unknown>, {
        location: args.location as string,
        lang: args.lang as string,
        region: args.region as string,
        latencyMs: latency,
      });
    }

    try {
      db.run(
        `INSERT INTO search_history (query, query_hash, engines, results_count, top_result_url, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          args.query as string,
          String(Bun.hash(args.query as string)),
          "serpapi:google",
          response.organic_results?.length ?? 0,
          (response.organic_results?.[0]?.link as string | null) ?? null,
          latency,
          Date.now(),
        ]
      );
    } catch { /* ignore */ }

    return {
      query: args.query,
      search_id: response.search_metadata?.id ?? null,
      organic_count: response.organic_results?.length ?? 0,
      knowledge_graph: !!response.knowledge_graph,
      related_questions: response.related_questions?.length ?? 0,
      related_searches: response.related_searches?.length ?? 0,
      images: response.images_results?.length ?? 0,
      videos: response.videos_results?.length ?? 0,
      news: response.news_results?.length ?? 0,
      latency_ms: latency,
      vault_path: vaultPath || null,
    };
  },
});

// -- GitHub MCP 工具（仓库管理 / Issue / PR / 代码审查 / 发布 / Actions）--
registry.add({
  name: "github_list_repos",
  description: "列出 GitHub 仓库",
  inputSchema: {
    type: z.enum(["all", "owner", "public", "private", "member"]).optional().default("owner").describe("仓库类型"),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional().default("updated").describe("排序方式"),
    per_page: z.number().optional().default(30).describe("每页数量"),
    page: z.number().optional().default(1).describe("页码"),
  },
  handler: async (args) => {
    const repos = await listRepos({
      type: args.type as "owner",
      sort: args.sort as "updated",
      per_page: args.per_page as number,
      page: args.page as number,
    });
    return repos.map((r) => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      private: r.private,
      html_url: r.html_url,
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language,
      default_branch: r.default_branch,
      updated_at: r.updated_at,
    }));
  },
});

registry.add({
  name: "github_get_repo",
  description: "获取 GitHub 仓库详情",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
  },
  handler: async (args) => {
    const repo = await getRepo(args.owner as string, args.repo as string);
    return {
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      html_url: repo.html_url,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      open_issues: repo.open_issues_count,
      language: repo.language,
      default_branch: repo.default_branch,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
    };
  },
});

registry.add({
  name: "github_create_repo",
  description: "创建 GitHub 仓库",
  inputSchema: {
    name: z.string().describe("仓库名称"),
    description: z.string().optional().describe("仓库描述"),
    private: z.boolean().optional().default(false).describe("是否私有"),
    auto_init: z.boolean().optional().default(true).describe("自动初始化（创建 README）"),
    gitignore_template: z.string().optional().describe("Gitignore 模板（如 'Node'）"),
    license_template: z.string().optional().describe("许可证模板（如 'mit'）"),
  },
  handler: async (args) => {
    const repo = await createRepo({
      name: args.name as string,
      description: args.description as string,
      private: args.private as boolean,
      auto_init: args.auto_init as boolean,
      gitignore_template: args.gitignore_template as string,
      license_template: args.license_template as string,
    });
    return {
      name: repo.name,
      full_name: repo.full_name,
      html_url: repo.html_url,
      private: repo.private,
      clone_url: `https://github.com/${repo.full_name}.git`,
    };
  },
});

registry.add({
  name: "github_fork_repo",
  description: "Fork GitHub 仓库",
  inputSchema: {
    owner: z.string().describe("源仓库所有者"),
    repo: z.string().describe("源仓库名称"),
    organization: z.string().optional().describe("Fork 到的组织（可选）"),
    name: z.string().optional().describe("Fork 后的仓库名（可选）"),
  },
  handler: async (args) => {
    const forked = await forkRepo(args.owner as string, args.repo as string, {
      organization: args.organization as string,
      name: args.name as string,
    });
    return {
      name: forked.name,
      full_name: forked.full_name,
      html_url: forked.html_url,
      fork: true,
    };
  },
});

registry.add({
  name: "github_list_issues",
  description: "列出 GitHub Issues",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    state: z.enum(["open", "closed", "all"]).optional().default("open").describe("Issue 状态"),
    labels: z.string().optional().describe("标签过滤（逗号分隔）"),
    sort: z.enum(["created", "updated", "comments"]).optional().default("created").describe("排序方式"),
    per_page: z.number().optional().default(30).describe("每页数量"),
    page: z.number().optional().default(1).describe("页码"),
  },
  handler: async (args) => {
    const issues = await listIssues(args.owner as string, args.repo as string, {
      state: args.state as "open",
      labels: args.labels as string,
      sort: args.sort as "created",
      per_page: args.per_page as number,
      page: args.page as number,
    });
    return issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user.login,
      labels: i.labels.map((l) => l.name),
      comments: i.comments,
      html_url: i.html_url,
      created_at: i.created_at,
    }));
  },
});

registry.add({
  name: "github_create_issue",
  description: "创建 GitHub Issue",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    title: z.string().describe("Issue 标题"),
    body: z.string().optional().describe("Issue 内容"),
    labels: z.array(z.string()).optional().describe("标签列表"),
    assignees: z.array(z.string()).optional().describe("指派用户列表"),
  },
  handler: async (args) => {
    const issue = await createIssue(args.owner as string, args.repo as string, {
      title: args.title as string,
      body: args.body as string,
      labels: args.labels as string[],
      assignees: args.assignees as string[],
    });
    return {
      number: issue.number,
      title: issue.title,
      html_url: issue.html_url,
      state: issue.state,
    };
  },
});

registry.add({
  name: "github_add_issue_comment",
  description: "添加 GitHub Issue 评论",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    issue_number: z.number().describe("Issue 编号"),
    body: z.string().describe("评论内容"),
  },
  handler: async (args) => {
    const comment = await addIssueComment(
      args.owner as string,
      args.repo as string,
      args.issue_number as number,
      args.body as string
    );
    return {
      id: comment.id,
      html_url: comment.html_url,
    };
  },
});

registry.add({
  name: "github_list_prs",
  description: "列出 GitHub Pull Requests",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    state: z.enum(["open", "closed", "all"]).optional().default("open").describe("PR 状态"),
    sort: z.enum(["created", "updated", "popularity", "long-running"]).optional().default("created").describe("排序方式"),
    per_page: z.number().optional().default(30).describe("每页数量"),
    page: z.number().optional().default(1).describe("页码"),
  },
  handler: async (args) => {
    const prs = await listPRs(args.owner as string, args.repo as string, {
      state: args.state as "open",
      sort: args.sort as "created",
      per_page: args.per_page as number,
      page: args.page as number,
    });
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      user: pr.user.login,
      head: pr.head.ref,
      base: pr.base.ref,
      html_url: pr.html_url,
      created_at: pr.created_at,
    }));
  },
});

registry.add({
  name: "github_create_pr",
  description: "创建 GitHub Pull Request",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    title: z.string().describe("PR 标题"),
    head: z.string().describe("源分支"),
    base: z.string().describe("目标分支"),
    body: z.string().optional().describe("PR 描述"),
    draft: z.boolean().optional().default(false).describe("是否为草稿"),
  },
  handler: async (args) => {
    const pr = await createPR(args.owner as string, args.repo as string, {
      title: args.title as string,
      head: args.head as string,
      base: args.base as string,
      body: args.body as string,
      draft: args.draft as boolean,
    });
    return {
      number: pr.number,
      title: pr.title,
      html_url: pr.html_url,
      state: pr.state,
      draft: (pr as any).draft,
    };
  },
});

registry.add({
  name: "github_review_pr",
  description: "审查 GitHub Pull Request",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    pull_number: z.number().describe("PR 编号"),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("审查操作"),
    body: z.string().optional().describe("审查评论"),
  },
  handler: async (args) => {
    const review = await reviewPR(
      args.owner as string,
      args.repo as string,
      args.pull_number as number,
      {
        event: args.event as "APPROVE",
        body: args.body as string,
      }
    );
    return {
      id: review.id,
      state: review.state,
    };
  },
});

registry.add({
  name: "github_get_pr_files",
  description: "获取 GitHub PR 变更文件列表",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    pull_number: z.number().describe("PR 编号"),
  },
  handler: async (args) => {
    const files = await getPRFiles(
      args.owner as string,
      args.repo as string,
      args.pull_number as number
    );
    return files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
  },
});

registry.add({
  name: "github_get_file_contents",
  description: "获取 GitHub 文件内容",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    path: z.string().describe("文件路径"),
    ref: z.string().optional().describe("分支或 commit SHA（默认为默认分支）"),
  },
  handler: async (args) => {
    const file = await getFileContents(
      args.owner as string,
      args.repo as string,
      args.path as string,
      args.ref as string
    );
    if (file.type === "dir") {
      return {
        type: "directory",
        name: file.name,
        path: file.path,
      };
    }
    const content = file.content
      ? Buffer.from(file.content, "base64").toString("utf-8")
      : null;
    return {
      type: "file",
      name: file.name,
      path: file.path,
      size: file.size,
      sha: file.sha,
      content: content?.slice(0, 50000),
      encoding: file.encoding,
      html_url: file.html_url,
    };
  },
});

registry.add({
  name: "github_list_directory",
  description: "列出 GitHub 仓库目录内容",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    path: z.string().optional().default("").describe("目录路径（默认为根目录）"),
    ref: z.string().optional().describe("分支或 commit SHA"),
  },
  handler: async (args) => {
    const items = await listGitHubDirectory(
      args.owner as string,
      args.repo as string,
      (args.path as string) || "",
      args.ref as string
    );
    return items.map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size,
      sha: item.sha,
    }));
  },
});

registry.add({
  name: "github_search_code",
  description: "搜索 GitHub 代码",
  inputSchema: {
    query: z.string().describe("搜索查询（GitHub 搜索语法）"),
    owner: z.string().optional().describe("限定仓库所有者"),
    repo: z.string().optional().describe("限定仓库名称"),
    per_page: z.number().optional().default(30).describe("每页数量"),
    page: z.number().optional().default(1).describe("页码"),
  },
  handler: async (args) => {
    const result = await searchGitHubCode(args.query as string, {
      owner: args.owner as string,
      repo: args.repo as string,
      per_page: args.per_page as number,
      page: args.page as number,
    });
    return {
      total_count: result.total_count,
      items: result.items.map((item) => ({
        name: item.name,
        path: item.path,
        html_url: item.html_url,
        repository: item.repository.full_name,
        score: item.score,
      })),
    };
  },
});

registry.add({
  name: "github_list_releases",
  description: "列出 GitHub Releases",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    per_page: z.number().optional().default(30).describe("每页数量"),
    page: z.number().optional().default(1).describe("页码"),
  },
  handler: async (args) => {
    const releases = await listReleases(
      args.owner as string,
      args.repo as string,
      { per_page: args.per_page as number, page: args.page as number }
    );
    return releases.map((r) => ({
      tag_name: r.tag_name,
      name: r.name,
      body: r.body?.slice(0, 1000),
      draft: r.draft,
      prerelease: r.prerelease,
      html_url: r.html_url,
      author: r.author.login,
      published_at: r.published_at,
      assets_count: r.assets.length,
    }));
  },
});

registry.add({
  name: "github_create_release",
  description: "创建 GitHub Release",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    tag_name: z.string().describe("标签名"),
    name: z.string().optional().describe("Release 标题"),
    body: z.string().optional().describe("Release 描述"),
    draft: z.boolean().optional().default(false).describe("是否为草稿"),
    prerelease: z.boolean().optional().default(false).describe("是否为预发布"),
    target_commitish: z.string().optional().describe("目标分支或 commit SHA"),
  },
  handler: async (args) => {
    const release = await createRelease(args.owner as string, args.repo as string, {
      tag_name: args.tag_name as string,
      name: args.name as string,
      body: args.body as string,
      draft: args.draft as boolean,
      prerelease: args.prerelease as boolean,
      target_commitish: args.target_commitish as string,
    });
    return {
      tag_name: release.tag_name,
      name: release.name,
      html_url: release.html_url,
      draft: release.draft,
      prerelease: release.prerelease,
    };
  },
});

registry.add({
  name: "github_list_workflows",
  description: "列出 GitHub Actions 工作流",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
  },
  handler: async (args) => {
    const result = await listWorkflows(args.owner as string, args.repo as string);
    return result.workflows.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      state: w.state,
      html_url: w.html_url,
    }));
  },
});

registry.add({
  name: "github_trigger_workflow",
  description: "触发 GitHub Actions 工作流",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    workflow_id: z.string().describe("工作流 ID 或文件名"),
    ref: z.string().describe("触发分支"),
    inputs: z.record(z.string()).optional().describe("工作流输入参数"),
  },
  handler: async (args) => {
    await triggerWorkflow(args.owner as string, args.repo as string, args.workflow_id as string, {
      ref: args.ref as string,
      inputs: args.inputs as Record<string, string>,
    });
    return { triggered: true, workflow_id: args.workflow_id, ref: args.ref };
  },
});

registry.add({
  name: "github_list_workflow_runs",
  description: "列出 GitHub Actions 工作流运行记录",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    workflow_id: z.string().optional().describe("工作流 ID（可选）"),
    status: z.enum(["completed", "action_required", "cancelled", "failure", "neutral"]).optional().describe("运行状态过滤"),
    per_page: z.number().optional().default(30).describe("每页数量"),
    page: z.number().optional().default(1).describe("页码"),
  },
  handler: async (args) => {
    const result = await listWorkflowRuns(args.owner as string, args.repo as string, {
      workflow_id: args.workflow_id as string,
      status: args.status as "completed",
      per_page: args.per_page as number,
      page: args.page as number,
    });
    return result.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name,
      head_branch: run.head_branch,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      run_number: run.run_number,
      event: run.event,
      created_at: run.created_at,
    }));
  },
});

registry.add({
  name: "github_get_workflow_run",
  description: "获取 GitHub Actions 工作流运行详情",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    run_id: z.number().describe("运行 ID"),
  },
  handler: async (args) => {
    const run = await getWorkflowRun(
      args.owner as string,
      args.repo as string,
      args.run_id as number
    );
    return {
      id: run.id,
      name: run.name,
      head_branch: run.head_branch,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      run_number: run.run_number,
      event: run.event,
      created_at: run.created_at,
      updated_at: run.updated_at,
    };
  },
});

registry.add({
  name: "github_health",
  description: "检查 GitHub API 连接状态",
  inputSchema: {},
  handler: async () => {
    const health = await checkGitHubHealth();
    const info = getGitHubInfo();
    return {
      ok: health.ok,
      latency_ms: health.latency,
      user: health.user,
      error: health.error,
      configured: info.configured,
      base_url: info.baseUrl,
      token_prefix: info.tokenPrefix,
    };
  },
});

registry.add({
  name: "serpapi_search_and_crawl",
  description: "SerpAPI 搜索 + 自动爬取前 N 个结果",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    location: z.string().optional().describe("地理位置"),
    lang: z.string().optional().default("en").describe("界面语言"),
    region: z.string().optional().default("us").describe("国家代码"),
    num: z.number().optional().default(10).describe("搜索结果数量"),
    crawlTopN: z.number().optional().default(3).describe("爬取前 N 个结果"),
    safe: z.enum(["active", "off"]).optional().default("active").describe("安全搜索"),
  },
  handler: async (args) => {
    const client = new SerpApiClient();
    const pipeline = new DataPipeline();
    const searchStart = performance.now();
    const response = await client.search({
      q: args.query as string,
      location: args.location as string,
      hl: args.lang as string,
      gl: args.region as string,
      num: Math.min((args.num as number) || 10, 100),
      safe: args.safe as "active" | "off",
    });
    const searchLatency = Math.round(performance.now() - searchStart);

    const vaultPath = await vault.writeSerpApiResult(args.query as string, response as Record<string, unknown>, {
      location: args.location as string,
      lang: args.lang as string,
      region: args.region as string,
      latencyMs: searchLatency,
    });

    const organic = (response.organic_results || []).slice(0, Math.min((args.crawlTopN as number) || 3, 10));
    const crawled: Array<{ url: string; title: string; success: boolean; error?: string }> = [];

    for (const item of organic) {
      if (!item.link) continue;
      try {
        const result = await pipeline.crawlStructured(item.link);
        if (result) {
          await pipeline.saveCrawlResult(result);
          crawled.push({ url: item.link, title: result.title, success: true });
        } else {
          crawled.push({ url: item.link, title: item.title || item.link, success: false, error: "Crawl returned null" });
        }
      } catch (e: unknown) {
        crawled.push({ url: item.link, title: item.title || item.link, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    try {
      db.run(
        `INSERT INTO search_history (query, query_hash, engines, results_count, top_result_url, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [args.query as string, String(Bun.hash(args.query as string)), "serpapi:google+crawl", organic.length, (organic[0]?.link as string | null) ?? null, searchLatency, Date.now()]
      );
    } catch { /* ignore */ }

    return {
      query: args.query,
      search_id: response.search_metadata?.id ?? null,
      search_vault_path: vaultPath,
      organic_count: organic.length,
      crawled_count: crawled.filter((c) => c.success).length,
      failed_count: crawled.filter((c) => !c.success).length,
      crawled,
    };
  },
});

registerCodeAgentTools(registry);

registerHermesTools(registry);

registerRouterTools(registry);

registerDbTools(registry, db);

registerLspTools(registry);

// -- Skill 管理工具 (extracted to server/skill-tools.ts) --
const skillDirs = [
  readString("SKILL_DIR", "./skills"),
  "./axiom-memory/03-Resources/skills",
];
registerSkillTools(registry, skillDirs);

registerTokenTools(registry);

registerModeTools(registry);

// ===== Workspace Snapshot 工具 =====

registry.add({
  name: "snapshot_create",
  description: "创建工作区快照（保存当前所有文件状态）",
  inputSchema: {
    message: z.string().optional().describe("快照说明信息"),
  },
  handler: async (args: { message?: string }) => {
    return await createSnapshot(args.message);
  },
});

registry.add({
  name: "snapshot_revert",
  description: "回退到指定快照",
  inputSchema: {
    snapshotId: z.string().describe("快照ID（commit hash）"),
  },
  handler: async (args: Record<string, unknown>) => {
    return await revertSnapshot(args.snapshotId as string);
  },
});

registry.add({
  name: "snapshot_list",
  description: "列出所有工作区快照",
  inputSchema: {},
  handler: async () => {
    return await listSnapshots();
  },
});

registry.add({
  name: "snapshot_diff",
  description: "查看快照差异",
  inputSchema: {
    snapshotId: z.string().optional().describe("快照ID，不提供则对比最近两次快照"),
  },
  handler: async (args: { snapshotId?: string }) => {
    return await diffSnapshot(args.snapshotId);
  },
});

registry.add({
  name: "snapshot_status",
  description: "获取快照系统状态",
  inputSchema: {},
  handler: async () => {
    return { success: true, ...getSnapshotStatus() };
  },
});

registerArenaTools(registry);

registerPromptTools(registry);

registerOrchestratorTools(registry);

// ===== DRE 工具 (extracted to server/dre-tools.ts) =====
registerDreTools(registry);

// ===== KG / DIP / KAL 工具 (extracted to server/kg-tools.ts) =====
registerKgTools(registry, db);

// ===== 补充缺失的工具 =====

registry.add({
  name: "proxy_status",
  description: "获取代理状态信息",
  inputSchema: {},
  handler: async () => {
    try {
      const status = getProxyStatus();
      return { success: true, data: status };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
});

registry.add({
  name: "github_get_issue",
  description: "获取 GitHub Issue 详情",
  inputSchema: {
    owner: z.string().describe("仓库所有者"),
    repo: z.string().describe("仓库名称"),
    issue_number: z.number().describe("Issue 编号"),
  },
  handler: async (args) => {
    const issue = await getGitHubIssue(
      args.owner as string,
      args.repo as string,
      args.issue_number as number
    );
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      user: issue.user.login,
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.map((a) => a.login),
      comments: issue.comments,
      html_url: issue.html_url,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    };
  },
});

// ===== 场景路由工具 (工具懒加载) =====

const sceneRouter = new SceneRouter(registry);
sceneRouter.addScenes(DEFAULT_SCENES);

registry.add({
  name: "scene_suggest_tools",
  description: "根据输入文本推荐工具子集 (降低 context token 消耗)",
  inputSchema: {
    input: z.string().describe("用户输入或任务描述"),
  },
  handler: async (args) => {
    const input = args.input as string;
    const scene = sceneRouter.match(input);
    if (!scene) {
      return {
        matched: false,
        suggestion: "core",
        tools: ["fs_read", "fs_list", "git_status", "terminal_info"],
        message: "未匹配到特定场景，使用核心工具集",
      };
    }
    return {
      matched: true,
      sceneId: scene.id,
      sceneName: scene.name,
      description: scene.description,
      tools: scene.tools,
      parallel: scene.parallel,
    };
  },
});

registry.add({
  name: "scene_list",
  description: "列出所有可用场景及其工具集",
  inputSchema: {},
  handler: async () => {
    return sceneRouter.listScenes();
  },
});

// ===== 进程退出清理 =====

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`[MCP] Received ${signal}, shutting down...`);
  try {
    await shutdownKernel();
  } catch (err) {
    logger.warn("[MCP] Shutdown error", { error: (err as Error).message });
  }
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

// ===== 启动服务器 =====

const transport = process.argv.includes("--stdio") ? "stdio" : "http";

if (transport === "stdio") {
  // stdio 传输：注册所有工具
  registry.registerWithMcp(mcp);
  const stdio = new StdioServerTransport();
  mcp.connect(stdio);
} else {
  // HTTP 传输：构建 handlers 和 meta
  const toolHandlers = registry.buildHttpHandlers();
  const toolsMeta = registry.getToolsMeta();
  const port = Number(readString("MCP_PORT", "3001"));

  Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") return Response.json({ error: "Only POST supported" }, { status: 405 });
      try {
        const body = await req.json();
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "Axiom Agent MCP Server", version: "4.0.0" },
            },
          });
        }
        if (body.method === "initialized") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: { tools: toolsMeta },
          });
        }
        if (body.method === "tools/call") {
          const { name, arguments: args } = body.params;
          const handler = toolHandlers[name];
          if (!handler) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              error: { code: -32602, message: `Tool '${name}' not found` },
            }, { status: 400 });
          }
          try {
            const result = await withTimeout(
              withRetry(() => handler(args || {}), { maxAttempts: 2, baseDelay: 500 }),
              TIMEOUTS.MCP_TOOL_DEFAULT
            );
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
              },
            });
          } catch (err) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
                isError: true,
              },
            });
          }
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    },
  });
  logger.info(`[MCP] Server running on http://localhost:${port}`);
}
