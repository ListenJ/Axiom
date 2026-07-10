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
import {
  openCodeSession,
  checkOpenCode,
  listOpenCodeModels,
  OPENCODE_FREE_MODELS,
  getOpenCodeInstallGuide,
  executeCodeGenerate,
  executeCodeRefactor,
  executeCodeReview,
  executeCodeTest,
} from "../agents/opencode-agent.js";
import {
  runHermesTask,
  deepResearch,
  checkHermes,
  getHermesInstallGuide,
  codeReview,
} from "../agents/hermes-agent.js";
import {
  loadSkillsFromDirectories,
  saveSkillFile,
  createSkillFileBoilerplate,
  clearSkillCache,
} from "../skills/skill-loader.js";
import {
  // LSP / quick-diagnostics tools still use these
  getQuickDiagnostics,
  getCodeActions,
  detectLanguage,
} from "./tools/code-analysis.js";
import { registerVaultTools, registerWebTools } from "./server/vault-tools.js";
import { SceneRouter, DEFAULT_SCENES } from "./scene-router.js";
import { router } from "../router/model-router.js";
import { getTokenTracker } from "../router/token-tracker.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  createSnapshot,
  revertSnapshot,
  listSnapshots,
  diffSnapshot,
  getSnapshotStatus,
} from "./tools/workspace-snapshot.js";
import {
  executionMode,
  type ExecutionMode,
  TOOL_CLASSIFICATIONS,
} from "../agents/execution-mode.js";
import { getConstitutionForMode } from "../agents/constitution.js";
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
import { getArenaCollector } from "../eval/arena-collector.js";
import { getPromptPool, type AgentRole } from "../agents/prompt-pool.js";
import { getProxyStatus } from "../utils/adaptive-proxy.js";
import { getAgentOrchestrator, type AgentTask } from "../agents/orchestrator.js";
import { DREngine, Kernel, CognitivePipeline, TaskGraph, ConfigLoader, type KnowledgeItem } from "../dre/index.js";
import { getResourceBudgetManager } from "../dre/system-resource.js";
import { KnowledgeGraphEnhanced, type KGNodeType, type KGEdgeType } from "../kg/enhanced.js";
import { registerExternalTools } from "./register-external-tools.js";
import { adaptTools } from "./adapt-tool.js";
import { readTool } from "../tools/read-tool.js";
import { writeTool } from "../tools/write-tool.js";
import { queryTool } from "../tools/query-tool.js";
import { KnowledgeAccessLayer } from "../kal/knowledge-access-layer.js";
import { createNodeId } from "../kal/node-id.js";
import { parseMarkdownAST, extractAllEntities } from "../crawl/processor/markdown-ast.js";
import { KGWriter } from "../crawl/processor/kg-writer.js";

const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
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

// -- 编码 Agent 工具 --
registry.add({
  name: "code_generate",
  description: "使用 AI 模型生成代码（自动注入 CodeGraph 上下文，支持免费模型）",
  inputSchema: {
    prompt: z.string().describe("代码生成需求描述"),
    language: z.string().optional().describe("编程语言"),
    context: z.string().optional().describe("现有代码上下文"),
    model: z.string().optional().describe("模型名称"),
  },
  handler: async (args) => {
    const result = await executeCodeGenerate({
      prompt: args.prompt as string,
      language: args.language as string | undefined,
      context: args.context as string | undefined,
      model: args.model as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "code_refactor",
  description: "使用 AI 模型重构代码（自动注入 CodeGraph 上下文）",
  inputSchema: {
    code: z.string().describe("要重构的代码"),
    description: z.string().describe("重构需求描述"),
    language: z.string().optional().describe("编程语言"),
  },
  handler: async (args) => {
    const result = await executeCodeRefactor({
      code: args.code as string,
      description: args.description as string,
      language: args.language as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "code_review",
  description: "使用 AI 模型审查代码（优先 GLM-5.1）",
  inputSchema: {
    code: z.string().describe("要审查的代码"),
    language: z.string().optional().describe("编程语言"),
    context: z.string().optional().describe("代码上下文"),
  },
  handler: async (args) => {
    const result = await executeCodeReview({
      code: args.code as string,
      language: args.language as string | undefined,
      context: args.context as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "code_test",
  description: "使用 AI 模型生成测试用例",
  inputSchema: {
    code: z.string().describe("要测试的代码"),
    language: z.string().optional().describe("编程语言"),
    framework: z.string().optional().describe("测试框架"),
  },
  handler: async (args) => {
    const result = await executeCodeTest({
      code: args.code as string,
      language: args.language as string | undefined,
      framework: args.framework as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "opencode_status",
  description: "检查 OpenCode Agent 状态和可用模型",
  inputSchema: {},
  handler: async () => {
    const available = await checkOpenCode();
    const models = available ? await listOpenCodeModels() : [];
    return { installed: available, freeModels: OPENCODE_FREE_MODELS, allModels: models.slice(0, 50) };
  },
});

// -- Hermes 工具 --
registry.add({
  name: "project_research",
  description: "使用 Hermes Agent 进行深度研究",
  inputSchema: {
    topic: z.string().describe("研究主题"),
    cwd: z.string().optional().describe("工作目录"),
  },
  handler: async (args) => {
    const result = await deepResearch(args.topic as string, args.cwd as string);
    return { success: result.success, output: result.stdout, errors: result.stderr };
  },
});

registry.add({
  name: "hermes_status",
  description: "检查 Hermes Agent 安装状态",
  inputSchema: {},
  handler: async () => {
    const available = await checkHermes();
    return { installed: available, installGuide: available ? "Hermes is ready" : "Run: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" };
  },
});

// -- 模型路由工具 --
registry.add({
  name: "model_chat",
  description: "通过多平台路由器发送聊天请求",
  inputSchema: {
    taskType: z.enum(["general-chat", "code-generation", "complex-reasoning"]).describe("任务类型"),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).describe("消息列表"),
  },
  handler: async (args) => {
    const messages = (args.messages as Array<{ role: string; content: string }>).map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));
    const result = await router.chat(args.taskType as string, messages);
    return { content: result.content || "" };
  },
});

// -- 数据库工具 --
registry.add({
  name: "db_query",
  description: "执行 SQLite 查询（只读）",
  inputSchema: {
    sql: z.string().describe("SELECT 查询语句"),
    params: z.array(z.any()).optional().default([]),
  },
  handler: async (args) => {
    const normalized = (args.sql as string).trim().toLowerCase();
    if (!normalized.startsWith("select")) {
      return { error: "Only SELECT queries are allowed" };
    }
    try {
      return db.query(args.sql as string).all(...((args.params || []) as (string | number | boolean | null)[]));
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

registry.add({
  name: "list_free_models",
  description: "列出当前可用的免费模型",
  inputSchema: {},
  handler: async () => {
    return db.query("SELECT id, name, provider, context_length FROM free_models WHERE is_available = 1").all();
  },
});

// -- LSP 增强工具 --

registry.add({
  name: "code_quick_diagnostics",
  description: "快速诊断单个文件（使用增量检查，更快）",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => getQuickDiagnostics(args.filePath as string),
});

registry.add({
  name: "code_actions",
  description: "获取代码修复建议（Code Actions）",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => getCodeActions(args.filePath as string),
});

registry.add({
  name: "code_detect_language",
  description: "检测文件编程语言",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => ({
    success: true,
    language: detectLanguage(args.filePath as string),
    filePath: args.filePath,
  }),
});

// -- Skill 管理工具 --
const skillDirs = [
  process.env.SKILL_DIR || "./skills",
  "./axiom-memory/03-Resources/skills",
];

registry.add({
  name: "skill_list",
  description: "列出所有已加载的 skills 和 prompt templates",
  inputSchema: {
    includeBuiltin: z.boolean().optional().default(true).describe("是否包含内置 skills"),
    includeFile: z.boolean().optional().default(true).describe("是否包含从文件加载的 skills"),
  },
  handler: async (args) => {
    const loaded = loadSkillsFromDirectories({ skillDirs });
    const includeBuiltin = args.includeBuiltin !== false;
    const includeFile = args.includeFile !== false;

    const skills = Array.from(loaded.skills.values())
      .filter((s) => {
        if (s.source === "builtin" && !includeBuiltin) return false;
        if (s.source === "file" && !includeFile) return false;
        return true;
      })
      .map((s) => ({
        id: s.id, name: s.name, description: s.description,
        triggers: s.triggers, outputFormat: s.outputFormat,
        version: s.version, source: s.source, filePath: s.filePath,
      }));

    const templates = Array.from(loaded.templates.values())
      .filter((t) => {
        if (t.source === "builtin" && !includeBuiltin) return false;
        if (t.source === "file" && !includeFile) return false;
        return true;
      })
      .map((t) => ({
        id: t.id, name: t.name, category: t.category,
        description: t.description, variables: t.variables,
        tags: t.tags, version: t.version, source: t.source, filePath: t.filePath,
      }));

    return { skills, templates, errors: loaded.errors };
  },
});

registry.add({
  name: "skill_reload",
  description: "重新从磁盘加载所有 skill 文件",
  inputSchema: {},
  handler: async () => {
    clearSkillCache();
    const loaded = loadSkillsFromDirectories({ skillDirs }, true);
    return {
      success: true,
      skillsLoaded: loaded.skills.size,
      templatesLoaded: loaded.templates.size,
      errors: loaded.errors,
    };
  },
});

registry.add({
  name: "skill_create",
  description: "创建新的 skill 文件",
  inputSchema: {
    filePath: z.string().describe("skill 文件路径（.json 或 .yaml）"),
    name: z.string().describe("skill 名称"),
    description: z.string().describe("skill 描述"),
    author: z.string().optional().describe("作者"),
  },
  handler: async (args) => {
    const boilerplate = createSkillFileBoilerplate({
      name: args.name as string,
      description: args.description as string,
      author: args.author as string | undefined,
    });
    saveSkillFile(args.filePath as string, boilerplate);
    return { success: true, filePath: args.filePath, boilerplate };
  },
});

// -- Token 使用统计工具 --
registry.add({
  name: "token_stats",
  description: "获取总体 token 使用统计（调用次数、token 消耗、成功率、延迟）",
  inputSchema: {
    since: z.number().optional().describe("起始时间戳（毫秒）"),
    until: z.number().optional().describe("结束时间戳（毫秒）"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getOverallStats({
      since: args.since as number | undefined,
      until: args.until as number | undefined,
    });
    return stats;
  },
});

registry.add({
  name: "token_stats_by_model",
  description: "按模型统计 token 使用情况",
  inputSchema: {
    since: z.number().optional().describe("起始时间戳（毫秒）"),
    limit: z.number().optional().default(20).describe("返回模型数量"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getStatsByModel({
      since: args.since as number | undefined,
      limit: args.limit as number | undefined,
    });
    return stats;
  },
});

registry.add({
  name: "token_stats_by_role",
  description: "按角色统计 token 使用情况",
  inputSchema: {
    since: z.number().optional().describe("起始时间戳（毫秒）"),
    limit: z.number().optional().default(20).describe("返回角色数量"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getStatsByRole({
      since: args.since as number | undefined,
      limit: args.limit as number | undefined,
    });
    return stats;
  },
});

registry.add({
  name: "token_daily_stats",
  description: "按天统计 token 使用情况",
  inputSchema: {
    days: z.number().optional().default(7).describe("最近多少天"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getDailyStats(args.days as number | undefined);
    return stats;
  },
});

// -- 执行模式管理工具 (CodeWhale-inspired) --
registry.add({
  name: "set_mode",
  description: "切换执行模式: plan(只读调查) / agent(默认,需审批) / yolo(自动批准)",
  inputSchema: {
    mode: z.enum(["plan", "agent", "yolo"]).describe("目标执行模式"),
    reason: z.string().optional().describe("切换原因"),
  },
  handler: async (args) => {
    const mode = args.mode as ExecutionMode;
    const previous = executionMode.getMode();
    executionMode.setMode(mode);
    return {
      success: true,
      previous,
      current: mode,
      reason: args.reason as string | undefined,
      config: executionMode.getConfig(),
      constitution: getConstitutionForMode(mode),
    };
  },
});

registry.add({
  name: "get_mode",
  description: "获取当前执行模式和宪法",
  inputSchema: {},
  handler: async () => {
    const mode = executionMode.getMode();
    return {
      mode,
      config: executionMode.getConfig(),
      constitution: getConstitutionForMode(mode),
      history: executionMode.getModeHistory(),
    };
  },
});

registry.add({
  name: "list_mode_tools",
  description: "列出当前模式下允许使用的工具",
  inputSchema: {
    category: z.string().optional().describe("按分类过滤"),
    risk: z.enum(["safe", "caution", "destructive"]).optional().describe("按风险等级过滤"),
  },
  handler: async (args) => {
    const tools = executionMode.getAllowedTools();
    let filtered = tools;
    if (args.category) {
      filtered = filtered.filter((t) => t.category === args.category);
    }
    if (args.risk) {
      filtered = filtered.filter((t) => t.risk === args.risk);
    }
    return {
      mode: executionMode.getMode(),
      total: TOOL_CLASSIFICATIONS.length,
      allowed: tools.length,
      filtered: filtered.length,
      tools: filtered.map((t) => ({
        name: t.name,
        risk: t.risk,
        category: t.category,
        description: t.description,
      })),
    };
  },
});

registry.add({
  name: "revert_mode",
  description: "回退到上一个执行模式",
  inputSchema: {},
  handler: async () => {
    const previous = executionMode.getMode();
    const current = executionMode.revertMode();
    return {
      success: true,
      previous,
      current,
      constitution: getConstitutionForMode(current),
    };
  },
});

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

// ===== 竞技场榜单采集工具 (Chapter 3) =====

registry.add({
  name: "arena_collect",
  description: "采集竞技场榜单数据 (LMSYS/OpenCompass/HuggingFace/LLM Stats)",
  inputSchema: {
    source: z.string().optional().describe("指定源名称 (如 'LMSYS Arena')，不指定则采集全部"),
  },
  handler: async (args) => {
    const collector = getArenaCollector();
    if (args.source) {
      const count = await collector.collectSource(args.source as string);
      return { success: true, source: args.source, recordsCollected: count };
    }
    return collector.collectAll();
  },
});

registry.add({
  name: "arena_search_models",
  description: "搜索竞技场榜单中的模型 (FTS5 BM25 确定性检索)",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    limit: z.number().optional().default(20).describe("返回数量"),
  },
  handler: async (args) => {
    const collector = getArenaCollector();
    return collector.searchModels(args.query as string, args.limit as number);
  },
});

registry.add({
  name: "arena_get_model_scores",
  description: "获取模型在所有基准上的分数",
  inputSchema: {
    model_name: z.string().describe("模型名称"),
  },
  handler: async (args) => {
    const collector = getArenaCollector();
    return collector.getModelScores(args.model_name as string);
  },
});

registry.add({
  name: "arena_benchmark_ranking",
  description: "获取基准上所有模型的排名",
  inputSchema: {
    benchmark: z.string().describe("基准名称 (如 'MMLU', 'HumanEval', 'arena-elo')"),
    limit: z.number().optional().default(50).describe("返回数量"),
  },
  handler: async (args) => {
    const collector = getArenaCollector();
    return collector.getBenchmarkRanking(args.benchmark as string, args.limit as number);
  },
});

registry.add({
  name: "arena_composite_ranking",
  description: "获取综合评分排名 (确定性加权公式)",
  inputSchema: {
    limit: z.number().optional().default(50).describe("返回数量"),
  },
  handler: async (args) => {
    const collector = getArenaCollector();
    return collector.getCompositeRanking(args.limit as number);
  },
});

registry.add({
  name: "arena_role_recommendation",
  description: "获取角色推荐 (确定性矩阵乘法匹配)",
  inputSchema: {
    role: z.enum(["code-generation", "research", "math", "general-chat", "architecture", "decision", "review", "general-tool"]).describe("角色类型"),
    limit: z.number().optional().default(10).describe("返回数量"),
  },
  handler: async (args) => {
    const collector = getArenaCollector();
    return collector.getRoleRecommendation(args.role as string, args.limit as number);
  },
});

registry.add({
  name: "arena_stats",
  description: "获取竞技场榜单统计信息",
  inputSchema: {},
  handler: async () => {
    const collector = getArenaCollector();
    return collector.getStats();
  },
});

registry.add({
  name: "arena_sources",
  description: "列出所有可用的榜单数据源",
  inputSchema: {},
  handler: async () => {
    const collector = getArenaCollector();
    return collector.listSources();
  },
});

// ===== Prompt 连接池工具 (Chapter 5) =====

registry.add({
  name: "prompt_pool_acquire",
  description: "从连接池获取角色的缓存友好提示词",
  inputSchema: {
    role: z.enum(["main_coding", "code_review", "research", "architecture", "decision", "general_chat", "tool_use", "computer_use"]).describe("角色类型"),
    task_description: z.string().describe("任务描述"),
    context: z.string().optional().describe("上下文信息"),
    user_input: z.string().optional().describe("用户输入"),
  },
  handler: async (args) => {
    const pool = getPromptPool();
    const result = pool.acquire(args.role as AgentRole, {
      task_description: args.task_description as string,
      context: args.context as string,
      user_input: args.user_input as string,
    });
    return {
      role: result.role,
      version: result.version,
      prefixHash: result.prefixHash,
      tokenCount: result.tokenCount,
      cacheControlMarker: result.cacheControlMarker,
      systemPromptLength: result.systemPrompt.length,
      staticPrefixLength: result.staticPrefix.length,
      dynamicSuffixLength: result.dynamicSuffix.length,
    };
  },
});

registry.add({
  name: "prompt_pool_metrics",
  description: "获取 Prompt 连接池缓存监控指标",
  inputSchema: {},
  handler: async () => {
    const pool = getPromptPool();
    return pool.getMetrics();
  },
});

registry.add({
  name: "prompt_pool_status",
  description: "获取 Prompt 连接池状态",
  inputSchema: {},
  handler: async () => {
    const pool = getPromptPool();
    return pool.getPoolStatus();
  },
});

registry.add({
  name: "prompt_pool_roles",
  description: "列出所有角色配置",
  inputSchema: {},
  handler: async () => {
    const pool = getPromptPool();
    return pool.listRoles();
  },
});

registry.add({
  name: "prompt_pool_warmup",
  description: "预热 Prompt 连接池缓存",
  inputSchema: {},
  handler: async () => {
    const pool = getPromptPool();
    pool.warmup();
    return { success: true, message: "Cache warmup initiated for all roles" };
  },
});

registry.add({
  name: "prompt_pool_evict",
  description: "执行连接池淘汰 (LRU/LFU/TTL 混合策略)",
  inputSchema: {},
  handler: async () => {
    const pool = getPromptPool();
    const evictedCount = pool.evict();
    return { evictedCount, message: `Evicted ${evictedCount} entries` };
  },
});

// ===== 多 Agent 编排工具 =====

registry.add({
  name: "orchestrator_execute_task",
  description: "执行单个 Agent 任务",
  inputSchema: {
    type: z.string().describe("任务类型 (如 code-generation, research, analysis)"),
    description: z.string().describe("任务描述"),
    input: z.record(z.unknown()).optional().describe("任务输入"),
    context: z.record(z.unknown()).optional().describe("任务上下文"),
    priority: z.number().optional().default(5).describe("优先级 (1-10)"),
    timeout: z.number().optional().describe("超时时间 (ms)"),
  },
  handler: async (args) => {
    const orchestrator = getAgentOrchestrator();
    const task: AgentTask = {
      id: `task-${Date.now()}`,
      type: args.type as string,
      description: args.description as string,
      input: (args.input as Record<string, unknown>) || {},
      context: args.context as Record<string, unknown>,
      priority: args.priority as number,
      timeout: args.timeout as number,
    };
    return orchestrator.executeTask(task);
  },
});

registry.add({
  name: "orchestrator_execute_plan",
  description: "执行编排计划 (串行/并行/DAG)",
  inputSchema: {
    name: z.string().describe("计划名称"),
    mode: z.enum(["sequential", "parallel", "dag"]).describe("执行模式"),
    steps: z.array(z.object({
      name: z.string(),
      agentId: z.string().optional(),
      taskType: z.string(),
      taskDescription: z.string(),
      dependsOn: z.array(z.string()).optional(),
      requireConfirmation: z.boolean().optional(),
    })).describe("执行步骤"),
  },
  handler: async (args) => {
    const orchestrator = getAgentOrchestrator();
    const planId = `plan-${Date.now()}`;

    const steps = (args.steps as Array<{
      name: string;
      agentId?: string;
      taskType: string;
      taskDescription: string;
      dependsOn?: string[];
      requireConfirmation?: boolean;
    }>).map((step, index) => ({
      id: `${planId}-step-${index}`,
      name: step.name,
      agentId: step.agentId || "internal",
      task: {
        id: `${planId}-task-${index}`,
        type: step.taskType,
        description: step.taskDescription,
        input: {},
      },
      dependsOn: step.dependsOn,
      requireConfirmation: step.requireConfirmation,
    }));

    const plan = {
      id: planId,
      name: args.name as string,
      steps,
      mode: args.mode as "sequential" | "parallel" | "dag",
    };

    const result = await orchestrator.executePlan(plan);
    return {
      planId: result.planId,
      success: result.success,
      totalDuration: result.totalDuration,
      errors: result.errors,
      stepResults: Object.fromEntries(result.stepResults),
    };
  },
});

registry.add({
  name: "orchestrator_list_agents",
  description: "列出所有注册的 Agent",
  inputSchema: {},
  handler: async () => {
    const orchestrator = getAgentOrchestrator();
    const agents = orchestrator.getRegistry().list();
    return agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
    }));
  },
});

registry.add({
  name: "orchestrator_health_check",
  description: "检查所有 Agent 健康状态",
  inputSchema: {},
  handler: async () => {
    const orchestrator = getAgentOrchestrator();
    const health = await orchestrator.getRegistry().healthCheckAll();
    return Object.fromEntries(health);
  },
});

registry.add({
  name: "orchestrator_status",
  description: "获取编排器状态",
  inputSchema: {},
  handler: async () => {
    const orchestrator = getAgentOrchestrator();
    return orchestrator.getStatus();
  },
});

// ===== DRE 确定性推理引擎工具 =====

// Kernel 单例 (替代裸 DREngine, 提供生命周期管理 + tick 循环)
let kernel: Kernel | null = null;

function getKernel(): Kernel {
  if (!kernel) {
    const config = new ConfigLoader().toKernelConfig();
    kernel = new Kernel({ ...config, tickInterval: 10000, autoTick: true });
    // 异步初始化 (不阻塞 MCP 启动)
    kernel.init().catch((err) => logger.warn("[MCP] Kernel init failed", { error: (err as Error).message }));
  }
  return kernel;
}

/** @deprecated 使用 getKernel().getEngine() 替代 */
function getDREngine(): DREngine {
  return getKernel().getEngine();
}

/** 关闭 Kernel */
async function shutdownKernel(): Promise<void> {
  if (kernel) {
    await kernel.shutdown();
    kernel = null;
  }
}

registry.add({
  name: "dre_write_knowledge",
  description: "写入知识 (触发三段甄别: 预筛→网络校验→LLM自推理，需要本地 LLM 服务)",
  inputSchema: {
    title: z.string().describe("知识标题"),
    content: z.string().describe("知识内容"),
    domain: z.string().optional().default("general").describe("分类: math/cs/bio/..."),
    paradigm: z.enum(["fact", "rule", "procedure", "concept"]).optional().default("fact").describe("范式"),
    sourceType: z.enum(["manual", "web", "llm", "ocr", "kg"]).optional().default("manual").describe("来源类型"),
    sourceUri: z.string().optional().describe("来源 URI"),
  },
  handler: async (args) => {
    try {
      const dre = getKernel().getEngine();
      const item: KnowledgeItem = {
        id: `kb-${Date.now()}`,
        title: args.title as string,
        content: args.content as string,
        domain: (args.domain as string) || "general",
        paradigm: (args.paradigm as KnowledgeItem["paradigm"]) || "fact",
        sourceType: (args.sourceType as KnowledgeItem["sourceType"]) || "manual",
        sourceUri: args.sourceUri as string,
      };

      const result = await dre.writeKnowledge(item);
      return {
        accepted: result.accepted,
        nodeId: item.id,
        verification: result.verification ? {
          verdict: result.verification.verdict,
          confidence: result.verification.confidence,
          chain: result.verification.chain,
          evidenceRefs: result.verification.evidenceRefs,
        } : undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        fallback: "memory_write",
        message: "DRE 引擎不可用 (需要本地 LLM 服务)。请使用 memory_write 将知识写入 Vault。",
      };
    }
  },
});

registry.add({
  name: "dre_read_knowledge",
  description: "读取知识条目",
  inputSchema: {
    nodeId: z.string().describe("知识条目 ID"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const node = dre.readKnowledge(args.nodeId as string);
    if (!node) {
      return { success: false, error: "Knowledge node not found" };
    }
    return {
      success: true,
      data: {
        nodeId: node.nodeId,
        title: node.title,
        content: node.content.slice(0, 5000),
        domain: node.domain,
        paradigm: node.paradigm,
        confidence: node.confidence,
        sourceType: node.sourceType,
        revision: node.revision,
        isVerified: node.isVerified,
      },
    };
  },
});

registry.add({
  name: "dre_search_knowledge",
  description: "搜索知识库",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    domain: z.string().optional().describe("分类过滤"),
    paradigm: z.enum(["fact", "rule", "procedure", "concept"]).optional().describe("范式过滤"),
    minConfidence: z.number().optional().describe("最低置信度"),
    limit: z.number().optional().default(10).describe("返回数量"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const results = dre.searchKnowledge(args.query as string, {
      domain: args.domain as string,
      paradigm: args.paradigm as string,
      minConfidence: args.minConfidence as number,
      limit: args.limit as number,
    });
    return results.map((r) => ({
      nodeId: r.nodeId,
      title: r.title,
      domain: r.domain,
      paradigm: r.paradigm,
      confidence: r.confidence,
      isVerified: r.isVerified,
    }));
  },
});

registry.add({
  name: "dre_subgraph",
  description: "知识图谱子图检索 (BFS)",
  inputSchema: {
    nodeId: z.string().describe("起始节点 ID"),
    depth: z.number().optional().default(2).describe("遍历深度"),
    maxNodes: z.number().optional().default(50).describe("最大节点数"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const nodes = dre.subgraph(args.nodeId as string, args.depth as number, args.maxNodes as number);
    return nodes.map((n) => ({
      nodeId: n.nodeId,
      title: n.title,
      domain: n.domain,
      confidence: n.confidence,
    }));
  },
});

registry.add({
  name: "dre_consciousness_step",
  description: "意识流处理步骤 (三级降级: 本地LLM → 云API → 规则推理)",
  inputSchema: {
    observation: z.string().describe("观察内容"),
    metadata: z.record(z.unknown()).optional().describe("元数据"),
  },
  handler: async (args) => {
    try {
      const dre = getKernel().getEngine();
      const result = await dre.consciousnessStep({
        observation: args.observation as string,
        metadata: args.metadata as Record<string, unknown>,
      });
      return {
        decision: result.decision,
        shouldReflect: result.shouldReflect,
        fallbackLevel: result.fallbackLevel || "local",
        reflection: result.reflection ? {
          issues: result.reflection.issues,
          lessons: result.reflection.lessons,
          rollback: result.reflection.rollback,
          checkpointTag: result.reflection.checkpointTag,
        } : undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        fallback: "memory_write",
        message: "DRE 引擎不可用 (所有降级路径均失败)。请使用 memory_write 将知识写入 Vault。",
      };
    }
  },
});

registry.add({
  name: "dre_status",
  description: "获取 DRE 引擎状态",
  inputSchema: {},
  handler: async () => {
    const dre = getKernel().getEngine();
    return dre.getStatus();
  },
});

registry.add({
  name: "resource_status",
  description: "获取系统资源预算状态 (可用内存、算力、是否可运行本地推理)",
  inputSchema: {},
  handler: async () => {
    const budget = getResourceBudgetManager();
    return budget.getStatus();
  },
});

// ===== Persona 工具 (v3.0.0 — 替代 AgentHarness) =====

registry.add({
  name: "persona_switch",
  description: "切换 Persona 模式 (plan/code/retrieve/reflect/audit/creative/general)",
  inputSchema: {
    mode: z.enum(["plan", "code", "retrieve", "reflect", "audit", "creative", "research", "general"]).describe("Persona 模式"),
    reason: z.string().optional().describe("切换原因 (可选)"),
  },
  handler: async (args) => {
    const loaded = getKernel().getEngine().switchPersona(args.mode as any, args.reason as string);
    return {
      mode: loaded.config.mode,
      name: loaded.config.name,
      allowWrite: loaded.config.allowWrite,
      temperature: loaded.config.temperature,
      loadedAt: loaded.loadedAt,
    };
  },
});

registry.add({
  name: "persona_status",
  description: "获取当前 Persona 状态和切换历史",
  inputSchema: {},
  handler: async () => {
    const persona = getKernel().getEngine().persona;
    return {
      ...persona.getContextSummary(),
      temperature: persona.getTemperature(),
      canWrite: persona.canWrite(),
      canUseTools: persona.canUseTools(),
      availableModes: persona.getAvailableModes(),
    };
  },
});

registry.add({
  name: "persona_list",
  description: "列出所有可用 Persona 模式",
  inputSchema: {},
  handler: async () => {
    return getKernel().getEngine().persona.getAvailableModes();
  },
});

registry.add({
  name: "cognitive_state",
  description: "获取统一认知状态 (Persona + 意识流 + 推理 + 约束 + 目标 + 信念 + 资源 + Atom数据)",
  inputSchema: {},
  handler: async () => {
    const engine = getKernel().getEngine();
    const state = engine.getCognitiveState();
    return {
      ...state,
      dataUnifier: engine.data.getAtomStats(),
    };
  },
});

// ===== 认知管道工具 (v3.1) =====

registry.add({
  name: "cognitive_pipeline_run",
  description: "运行认知管道 (含 LLM 降级链: L1确定→L2本地LLM→L3云→L4规则)",
  inputSchema: {
    input: z.string().describe("输入文本 (问题/任务描述)"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const pipeline = new CognitivePipeline(dre);
    pipeline.setToolExecutor(async (toolName, args) => {
      const handlers = registry.buildHttpHandlers();
      const handler = handlers[toolName];
      if (!handler) throw new Error('Tool not found: ' + toolName);
      return handler(args);
    });
    return pipeline.runWithLLM(args.input as string);
  },
});

registry.add({
  name: "cognitive_pipeline_run_full",
  description: "运行认知管道 + TaskGraph 执行 (含 LLM 降级链)",
  inputSchema: {
    input: z.string().describe("输入文本 (问题/任务描述)"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const pipeline = new CognitivePipeline(dre);
    pipeline.setToolExecutor(async (toolName, args) => {
      const handlers = registry.buildHttpHandlers();
      const handler = handlers[toolName];
      if (!handler) throw new Error('Tool not found: ' + toolName);
      return handler(args);
    });
    return pipeline.runFullWithLLM(args.input as string);
  },
});

// ===== 统一数据入口工具 (v3.1 DataUnifier) =====

registry.add({
  name: "data_write",
  description: "通过 DataUnifier 统一写入数据 (创建 Atom + 持久化到 KnowledgeStore)",
  inputSchema: {
    content: z.string().describe("数据内容"),
    kind: z.enum(["entity", "fact", "rule", "concept", "procedure", "observation", "insight"]).describe("数据类型"),
    domain: z.string().optional().describe("领域 (如 git, code, security)"),
    paradigm: z.string().optional().describe("范式 (fact, rule, procedure, concept)"),
    sourceType: z.string().optional().describe("来源类型 (manual, web, llm)"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const { atom } = dre.data.write({
      content: args.content as string,
      kind: args.kind as any,
      domain: args.domain as string,
      paradigm: args.paradigm as string,
      sourceType: args.sourceType as string,
    });
    return { atomId: atom.id, kind: atom.kind, content: atom.content.slice(0, 100) };
  },
});

registry.add({
  name: "data_search",
  description: "通过 DataUnifier 统一搜索 (Atom + KnowledgeStore)",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    limit: z.number().optional().default(10).describe("返回条数上限"),
    kind: z.enum(["entity", "fact", "rule", "concept", "procedure", "observation", "insight"]).optional().describe("按数据类型过滤"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const result = dre.data.search(args.query as string, {
      limit: (args.limit as number) ?? 10,
    });
    return {
      atoms: result.atoms.map((a) => ({ id: a.id, kind: a.kind, content: a.content.slice(0, 120) })),
      knowledgeNodes: result.knowledgeNodes.map((n) => ({ id: n.nodeId, domain: n.domain, content: n.content.slice(0, 120) })),
    };
  },
});

registry.add({
  name: "data_stats",
  description: "获取 DataUnifier / AtomEngine 统计信息",
  inputSchema: {},
  handler: async () => {
    const dre = getKernel().getEngine();
    return {
      atomStats: dre.data.getAtomStats(),
    };
  },
});

registry.add({
  name: "data_persist",
  description: "手动持久化所有 Atom 到 SQLite",
  inputSchema: {},
  handler: async () => {
    getKernel().getEngine().data.persist();
    return { success: true, timestamp: Date.now() };
  },

});

// ===== 心智模型工具 (v2.9.0 认知增强) =====

registry.add({
  name: "mental_model_list",
  description: "列出所有心智模型 (Git冲突/代码重构等领域模型)",
  inputSchema: {},
  handler: async () => {
    const dre = getKernel().getEngine();
    return dre.mentalModels.list().map((m) => ({
      id: m.id,
      name: m.name,
      domain: m.domain,
      description: m.description,
      concepts: m.concepts.length,
      transitions: m.transitions.length,
      currentState: m.currentState,
      usageCount: m.usageCount,
    }));
  },
});

registry.add({
  name: "mental_model_match",
  description: "在心智模型中匹配模式 (观察→概念链→状态路径)",
  inputSchema: {
    modelId: z.string().describe("心智模型 ID (如 git-conflict, code-refactor)"),
    observations: z.array(z.string()).describe("观察列表"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const result = dre.mentalModels.matchPattern(
      args.modelId as string,
      args.observations as string[]
    );
    if (!result) return { matched: false, message: "未匹配到模式" };
    return { matched: true, ...result };
  },
});

registry.add({
  name: "mental_model_predict",
  description: "基于心智模型预测下一步 (状态→触发→预测状态)",
  inputSchema: {
    modelId: z.string().describe("心智模型 ID"),
    observation: z.string().describe("当前观察"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const result = dre.mentalModels.predict(
      args.modelId as string,
      args.observation as string
    );
    if (!result) return { predicted: false, message: "无法预测" };
    return { predicted: true, ...result };
  },
});

// ===== 推理图工具 (v2.9.0 认知增强) =====

registry.add({
  name: "reasoning_build",
  description: "构建推理图 (添加前提→推理→结论，自动检测空洞)",
  inputSchema: {
    premises: z.array(z.string()).describe("前提列表"),
    conclusion: z.string().optional().describe("结论"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    dre.reasoning.clear();

    // 添加前提
    const premiseNodes = (args.premises as string[]).map((p) =>
      dre.reasoning.addPremise(p)
    );

    // 添加结论
    let conclusionNode = null;
    if (args.conclusion) {
      conclusionNode = dre.reasoning.addConclusion(
        args.conclusion as string,
        premiseNodes.map((n) => n.id)
      );
    }

    // 检测空洞
    const gaps = dre.reasoning.detectGaps();
    const stats = dre.reasoning.getStats();

    return {
      nodes: stats.totalNodes,
      edges: stats.totalEdges,
      gaps: gaps.length,
      gapDetails: gaps.map((g) => ({
        type: g.gapType,
        description: g.description,
        priority: g.priority,
        suggestedPrompt: g.suggestedPrompt,
      })),
    };
  },
});

registry.add({
  name: "reasoning_detect_gaps",
  description: "检测推理图中的空洞 (缺失的推理步骤/前提/证据)",
  inputSchema: {},
  handler: async () => {
    const dre = getKernel().getEngine();
    const gaps = dre.reasoning.detectGaps();
    return {
      totalGaps: gaps.length,
      gaps: gaps.map((g) => ({
        id: g.id,
        type: g.gapType,
        description: g.description,
        priority: g.priority,
        suggestedPrompt: g.suggestedPrompt,
      })),
    };
  },
});

registry.add({
  name: "reasoning_fill_gap",
  description: "用 LLM 结果填补推理图空洞",
  inputSchema: {
    gapId: z.string().describe("空洞 ID"),
    response: z.string().describe("LLM 回复内容"),
    confidence: z.number().optional().default(0.8).describe("置信度"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const node = dre.reasoning.fillGap(
      args.gapId as string,
      args.response as string,
      (args.confidence as number) || 0.8
    );
    if (!node) return { success: false, error: "空洞未找到" };

    // 重新检测空洞
    const remainingGaps = dre.reasoning.detectGaps();
    return {
      success: true,
      filledNode: { id: node.id, type: node.type, content: node.content.slice(0, 200) },
      remainingGaps: remainingGaps.length,
    };
  },
});

registry.add({
  name: "reasoning_result",
  description: "获取推理结果 (结论、推理链、总置信度)",
  inputSchema: {},
  handler: async () => {
    const dre = getKernel().getEngine();
    return dre.reasoning.getResult();
  },
});

// ===== 过程性知识工具 (v2.9.1 认知增强) =====

registry.add({
  name: "procedure_parse",
  description: "从知识节点中解析过程性知识 (步骤序列、条件分支、循环)",
  inputSchema: {
    nodeId: z.string().describe("知识节点 ID"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const node = dre.readKnowledge(args.nodeId as string);
    if (!node) return { success: false, error: "知识节点未找到" };
    const { ProcedureKnowledge } = await import("../dre/index.js");
    const procedure = ProcedureKnowledge.parseFromContent(node);
    if (!procedure) return { success: false, error: "无法解析为过程性知识" };
    const validation = ProcedureKnowledge.validate(procedure);
    return { success: true, procedure, validation };
  },
});

// ===== 约束求解器工具 (v2.9.2 认知增强) =====

registry.add({
  name: "constraint_check",
  description: "检查动作是否满足所有约束 (逻辑/物理/语义/策略/时间)",
  inputSchema: {
    action: z.string().describe("要检查的动作"),
    context: z.record(z.unknown()).optional().describe("额外上下文 (如 gpu_free_vram_mb, environment)"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    return dre.constraints.check(args.action as string, args.context as Record<string, unknown>);
  },
});

registry.add({
  name: "constraint_select_best",
  description: "从候选动作中选择满足约束的最佳动作",
  inputSchema: {
    candidates: z.array(z.string()).describe("候选动作列表"),
    context: z.record(z.unknown()).optional().describe("额外上下文"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    return dre.constraints.selectBest(args.candidates as string[], args.context as Record<string, unknown>);
  },
});

registry.add({
  name: "constraint_list",
  description: "列出所有约束 (可按维度过滤)",
  inputSchema: {
    dimension: z.enum(["logical", "physical", "field_match", "policy", "temporal"]).optional().describe("约束维度过滤"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const dimension = args.dimension as string | undefined;
    if (dimension) return dre.constraints.listByDimension(dimension as "logical" | "physical" | "field_match" | "policy" | "temporal");
    return dre.constraints.list();
  },
});

registry.add({
  name: "constraint_stats",
  description: "获取约束求解器统计信息",
  inputSchema: {},
  handler: async () => {
    const dre = getKernel().getEngine();
    return dre.constraints.getStats();
  },
});

// ===== Actor 系统工具 (v2.9.2 认知增强) =====

registry.add({
  name: "actor_list",
  description: "列出所有 Actor (知识/约束/心智模型/推理)",
  inputSchema: {},
  handler: async () => {
    const dre = getKernel().getEngine();
    return dre.actors.list();
  },
});

registry.add({
  name: "actor_send",
  description: "向 Actor 发送消息 (触发主动响应)",
  inputSchema: {
    to: z.string().describe("目标 Actor ID (knowledge/constraint/mental-model/reasoning)"),
    topic: z.string().describe("消息主题 (query/check/match/build)"),
    payload: z.record(z.unknown()).optional().describe("消息负载"),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    await dre.actors.send("user", args.to as string, "request", args.topic as string, args.payload || {});
    return { sent: true, to: args.to, topic: args.topic };
  },
});

// ===== 认知闭环 (CognitivePipeline) 工具 =====

registry.add({
  name: "cognitive_loop",
  description: "执行完整认知闭环 (Observation→State→Knowledge→Reasoning→Constraint→Action→Reflection), 零LLM确定性管道, 可追踪每一步的中间结果",
  inputSchema: {
    input: z.string().describe("用户输入或观察文本"),
  },
  tags: ["cognitive", "reasoning", "deterministic"],
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const pipeline = new CognitivePipeline(dre);
    pipeline.setToolExecutor(async (toolName, args) => {
      const handlers = registry.buildHttpHandlers();
      const handler = handlers[toolName];
      if (!handler) throw new Error('Tool not found: ' + toolName);
      return handler(args);
    });
    return pipeline.run(args.input as string);
  },
});

registry.add({
  name: "cognitive_loop_full",
  description: "认知闭环 + TaskGraph 执行 (包含认知推理+动作执行+回滚), 基于 runFull()",
  inputSchema: {
    input: z.string().describe("用户输入或任务描述"),
  },
  tags: ["cognitive", "reasoning", "execution", "deterministic"],
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const pipeline = new CognitivePipeline(dre);
    pipeline.setToolExecutor(async (toolName, args) => {
      const handlers = registry.buildHttpHandlers();
      const handler = handlers[toolName];
      if (!handler) throw new Error('Tool not found: ' + toolName);
      return handler(args);
    });
    return pipeline.runFull(args.input as string);
  },
});

registry.add({
  name: "task_graph_execute",
  description: "创建并执行任务图 (TaskGraph): 任务并行/依赖解析/失败回滚, 支持 Checkpoint/Resume",
  inputSchema: {
    tasks: z.array(z.object({
      id: z.string(),
      description: z.string(),
      dependsOn: z.array(z.string()).optional(),
      action: z.string().describe("发送到 Actor 的动作名"),
      payload: z.record(z.unknown()).optional(),
      hasRollback: z.boolean().optional().describe("是否注册回滚 (默认 false)"),
    })).min(1),
  },
  handler: async (args) => {
    const dre = getKernel().getEngine();
    const graph = new TaskGraph();

    for (const taskDef of (args.tasks as Array<Record<string, unknown>>)) {
      const id = taskDef.id as string;
      const desc = taskDef.description as string;
      const deps = taskDef.dependsOn as string[] | undefined;
      const action = taskDef.action as string;
      const payload = taskDef.payload as Record<string, unknown> | undefined;
      const hasRollback = taskDef.hasRollback as boolean | undefined;

      graph.addTask(id, desc, async () => {
        await dre.actors.send("user", "knowledge", "request", action, payload ?? {});
        return { dispatched: true, action };
      }, {
        dependsOn: deps,
        rollback: hasRollback ? async () => {
          await dre.actors.send("user", "knowledge", "notify", `rollback:${action}`, payload ?? {});
        } : undefined,
      });
    }

    await graph.executeAll();
    const checkpointId = await graph.checkpoint(dre.knowledgeStore);

    return {
      status: graph.getStatus(),
      tasksCompleted: graph.getAllTasks().filter((t) => t.status === "completed").length,
      tasksFailed: graph.getAllTasks().filter((t) => t.status === "failed").length,
      checkpointId,
    };
  },
});

// ===== 统一知识访问层 (KAL) 工具 =====

let kal: KnowledgeAccessLayer | null = null;

function getKAL(): KnowledgeAccessLayer {
  if (!kal) {
    kal = new KnowledgeAccessLayer(db);
  }
  return kal;
}

registry.add({
  name: "kal_query",
  description: "统一知识查询 (跨 Vault/KG/DRE 一次查询，自动 fan-out + 结果合并)",
  inputSchema: {
    query: z.string().describe("搜索关键词或自然语言查询"),
    store: z.enum(["vault", "kg", "dre"]).optional().describe("指定存储 (不指定则查询全部)"),
    typeFilter: z.array(z.string()).optional().describe("类型过滤 (如 function, fact, rule)"),
    tagFilter: z.array(z.string()).optional().describe("标签过滤"),
    limit: z.number().optional().default(20).describe("最大结果数"),
  },
  handler: async (args) => {
    const k = getKAL();
    const result = await k.query({
      query: args.query as string,
      targetStore: args.store as "vault" | "kg" | "dre" | undefined,
      typeFilter: args.typeFilter as string[],
      tagFilter: args.tagFilter as string[],
      limit: args.limit as number,
    });
    return result;
  },
});

registry.add({
  name: "kal_references",
  description: "查找知识条目的跨存储引用 (通过 node_id)",
  inputSchema: {
    nodeId: z.string().describe("全局 node_id (如 vault:note:xxx, kg:function:yyy)"),
  },
  handler: async (args) => {
    const k = getKAL();
    return k.getReferences(args.nodeId as string);
  },
});

// ===== 知识图谱工具 (PostgreSQL + SQLite 统一降级) =====

// 提前声明 SQLite KG 实例获取函数 (供 PG/DIP 工具使用)
let kgEnhancedSingleton: KnowledgeGraphEnhanced | null = null;
function getKGEnhancedInstance(): KnowledgeGraphEnhanced {
  if (!kgEnhancedSingleton) {
    kgEnhancedSingleton = new KnowledgeGraphEnhanced(db);
  }
  return kgEnhancedSingleton;
}

// ===== DIP 文档处理管道工具 =====

registry.add({
  name: "dip_ingest_document",
  description: "文档→KG管道: 解析 Markdown 为 AST → 提取实体 → 写入知识图谱 (零LLM)",
  inputSchema: {
    markdown: z.string().describe("Markdown 文档内容"),
    title: z.string().describe("文档标题"),
    sourceUrl: z.string().optional().describe("来源 URL"),
  },
  handler: async (args) => {
    const markdown = args.markdown as string;
    const title = args.title as string;
    const sourceUrl = args.sourceUrl as string;

    // 1. 解析 Markdown → AST
    const ast = parseMarkdownAST(markdown);

    // 2. 提取实体统计
    const entities = extractAllEntities(ast);
    const functions = entities.filter((e) => e.type === "function");
    const classes = entities.filter((e) => e.type === "class");
    const imports = entities.filter((e) => e.type === "import");

    // 3. 写入 KG
    const writer = new KGWriter(db);
    const writeResult = writer.writeAST(ast, title, sourceUrl);

    return {
      success: true,
      document: title,
      ast: {
        totalNodes: entities.length,
        functions: functions.map((f) => f.content),
        classes: classes.map((c) => c.content),
        imports: imports.map((i) => i.content),
      },
      kg: {
        nodesCreated: writeResult.nodesCreated,
        edgesCreated: writeResult.edgesCreated,
        errors: writeResult.errors,
      },
    };
  },
});

registry.add({
  name: "dip_query_ast",
  description: "确定性 AST 树查询 (在已索引的文档中搜索节点，零LLM)",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    nodeType: z.enum(["function", "class", "module", "concept", "document"]).optional().describe("节点类型过滤"),
    limit: z.number().optional().default(20).describe("最大结果数"),
  },
  handler: async (args) => {
    const query = args.query as string;
    const nodeType = args.nodeType as string | undefined;
    const limit = (args.limit as number) || 20;

    const kg = getKGEnhancedInstance();
    const nodes = kg.searchNodes(query, {
      type: nodeType as KGNodeType | undefined,
      limit,
    });

    return {
      query,
      results: nodes.map((n) => ({
        nodeId: createNodeId("kg", n.type, n.id),
        type: n.type,
        name: n.name,
        description: (n.description || "").slice(0, 300),
        importance: n.importance,
      })),
      count: nodes.length,
    };
  },
});

registry.add({
  name: "kg_stats",
  description: "获取知识图谱统计信息 (PostgreSQL 优先，自动降级到 SQLite)",
  inputSchema: {},
  handler: async () => {
    try {
      const { isPgAvailable, getPG } = await import("../db/pg-client.js");
      if (await isPgAvailable()) {
        const pg = getPG();
        const [entityCount] = await pg`SELECT COUNT(*)::int as count FROM kg_entities`;
        const [relCount] = await pg`SELECT COUNT(*)::int as count FROM kg_relationships`;
        return { success: true, backend: "postgresql", totalNodes: entityCount?.count || 0, totalEdges: relCount?.count || 0 };
      }
    } catch { /* PG not available, fall through to SQLite */ }
    // SQLite 降级
    const kg = getKGEnhancedInstance();
    return { success: true, backend: "sqlite", ...kg.getStats() };
  },
});

registry.add({
  name: "kg_entities",
  description: "查询知识图谱实体 (PostgreSQL 优先，自动降级到 SQLite)",
  inputSchema: {
    type: z.string().optional().describe("实体类型过滤"),
    query: z.string().optional().describe("搜索关键词"),
    limit: z.number().optional().default(50).describe("返回数量"),
  },
  handler: async (args) => {
    try {
      const { isPgAvailable, getPG } = await import("../db/pg-client.js");
      if (await isPgAvailable()) {
        const pg = getPG();
        const type = args.type as string;
        const search = args.query as string;
        const limit = (args.limit as number) || 50;
        let query = "SELECT id, name, type, description FROM kg_entities";
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
        if (search) { params.push(`%${search}%`); conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`); }
        if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
        query += " ORDER BY updated_at DESC LIMIT $" + (params.length + 1);
        params.push(limit);
        const entities = await pg.unsafe(query, params as any[]);
        return { success: true, backend: "postgresql", data: entities, count: entities.length };
      }
    } catch { /* fall through */ }
    // SQLite 降级
    const kg = getKGEnhancedInstance();
    const nodes = kg.searchNodes((args.query as string) || "", {
      type: args.type as KGNodeType | undefined,
      limit: (args.limit as number) || 50,
    });
    return { success: true, backend: "sqlite", data: nodes, count: nodes.length };
  },
});

registry.add({
  name: "kg_entity_detail",
  description: "获取知识图谱实体详情及关系 (PostgreSQL 优先，自动降级到 SQLite)",
  inputSchema: { name: z.string().describe("实体名称") },
  handler: async (args) => {
    try {
      const { isPgAvailable, getPG } = await import("../db/pg-client.js");
      if (await isPgAvailable()) {
        const pg = getPG();
        const entityName = args.name as string;
        const [entity] = await pg`SELECT * FROM kg_entities WHERE name = ${entityName}`;
        if (!entity) return { success: false, error: "Entity not found" };
        const relationships = await pg`
          SELECT r.relation_type, r.weight,
            CASE WHEN r.source_id = ${entity.id} THEN 'outgoing' ELSE 'incoming' END AS direction,
            CASE WHEN r.source_id = ${entity.id} THEN te.name ELSE se.name END AS other_entity,
            CASE WHEN r.source_id = ${entity.id} THEN te.type ELSE se.type END AS other_type
          FROM kg_relationships r
          JOIN kg_entities se ON se.id = r.source_id
          JOIN kg_entities te ON te.id = r.target_id
          WHERE r.source_id = ${entity.id} OR r.target_id = ${entity.id}
          ORDER BY r.weight DESC`;
        return { success: true, backend: "postgresql", data: { entity, relationships } };
      }
    } catch { /* fall through */ }
    // SQLite 降级: 按名称搜索节点，获取子图
    const kg = getKGEnhancedInstance();
    const nodes = kg.searchNodes(args.name as string, { limit: 1 });
    if (nodes.length === 0) return { success: false, error: "Entity not found" };
    const node = nodes[0];
    const subgraph = kg.subgraph(node.id, 2, 50);
    return { success: true, backend: "sqlite", data: { entity: node, ...subgraph } };
  },
});

registry.add({
  name: "kg_traverse",
  description: "知识图谱遍历 (PostgreSQL 优先，自动降级到 SQLite)",
  inputSchema: {
    entityName: z.string().describe("起始实体名称"),
    depth: z.number().optional().default(2).describe("遍历深度"),
  },
  handler: async (args) => {
    try {
      const { isPgAvailable, getPG } = await import("../db/pg-client.js");
      if (await isPgAvailable()) {
        const pg = getPG();
        const entityName = args.entityName as string;
        const depth = (args.depth as number) || 2;
        const [entity] = await pg`SELECT id FROM kg_entities WHERE name = ${entityName}`;
        if (!entity) return { success: false, error: "Entity not found" };
        const results = await pg`SELECT * FROM kg_traverse(${entity.id}, ${depth})`;
        return { success: true, backend: "postgresql", data: results, depth, startEntity: entityName };
      }
    } catch { /* fall through */ }
    // SQLite 降级
    const kg = getKGEnhancedInstance();
    const nodes = kg.searchNodes(args.entityName as string, { limit: 1 });
    if (nodes.length === 0) return { success: false, error: "Entity not found" };
    const subgraph = kg.subgraph(nodes[0].id, (args.depth as number) || 2, 100);
    return { success: true, backend: "sqlite", data: subgraph, depth: args.depth, startEntity: args.entityName };
  },
});

registry.add({
  name: "kg_build",
  description: "触发知识图谱构建",
  inputSchema: {
    projectPath: z.string().optional().describe("项目路径"),
    projectName: z.string().optional().describe("项目名称"),
  },
  handler: async (args) => {
    try {
      const { buildKnowledgeGraph } = await import("../memory/knowledge-graph-builder.js");
      const result = await buildKnowledgeGraph({
        projectPath: (args.projectPath as string) || process.cwd(),
        projectName: (args.projectName as string) || "current",
        generateEmbeddings: false,
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
});

registry.add({
  name: "kg_search",
  description: "知识图谱语义搜索",
  inputSchema: {
    query: z.string().describe("搜索查询"),
    projectName: z.string().optional().describe("项目名称"),
    maxDepth: z.number().optional().default(2).describe("最大深度"),
    maxEntities: z.number().optional().default(30).describe("最大实体数"),
  },
  handler: async (args) => {
    try {
      const { buildResearchContext } = await import("../memory/knowledge-graph-builder.js");
      const result = await buildResearchContext(args.query as string, {
        projectName: args.projectName as string,
        maxDepth: (args.maxDepth as number) || 2,
        maxEntities: (args.maxEntities as number) || 30,
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
});

registry.add({
  name: "kg_graph",
  description: "获取知识图谱可视化数据 (PostgreSQL 优先，自动降级到 SQLite)",
  inputSchema: {},
  handler: async () => {
    try {
      const { isPgAvailable, getPG } = await import("../db/pg-client.js");
      if (await isPgAvailable()) {
        const pg = getPG();
        const entities = await pg`SELECT id, name, type, description FROM kg_entities ORDER BY updated_at DESC LIMIT 500`;
        const nodeIds = entities.map((e: any) => String(e.id));
        const relationships = await pg.unsafe(
          `SELECT r.source_id, r.target_id, r.relation_type FROM kg_relationships r
           WHERE r.source_id = ANY($1::bigint[]) AND r.target_id = ANY($1::bigint[])
           ORDER BY r.weight DESC LIMIT 2000`, [nodeIds]);
        const nodes = entities.map((e: any) => ({ id: e.id, name: e.name, type: e.type, label: e.name.split("/").pop()?.split(".").pop() || e.name }));
        const edges = relationships.map((r: any) => ({ source: r.source_id, target: r.target_id, type: r.relation_type }));
        return { success: true, backend: "postgresql", data: { nodes, edges, stats: { nodeCount: nodes.length, edgeCount: edges.length } } };
      }
    } catch { /* fall through */ }
    // SQLite 降级
    const kg = getKGEnhancedInstance();
    return { success: true, backend: "sqlite", data: kg.toEChartsData({ maxNodes: 200, includeEdges: true }) };
  },
});

// ===== 知识图谱增强工具 (SQLite 后端，统一实例) =====

registry.add({
  name: "kg_add_node",
  description: "添加知识图谱节点",
  inputSchema: {
    type: z.enum(["function", "class", "module", "interface", "type", "variable", "file", "directory", "concept", "entity"]).describe("节点类型"),
    name: z.string().describe("节点名称"),
    description: z.string().optional().describe("节点描述"),
    filePath: z.string().optional().describe("文件路径"),
    lineNumber: z.number().optional().describe("行号"),
    signature: z.string().optional().describe("函数签名"),
    tags: z.array(z.string()).optional().describe("标签"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    kg.addNode({
      id: nodeId,
      type: args.type as KGNodeType,
      name: args.name as string,
      description: args.description as string,
      filePath: args.filePath as string,
      lineNumber: args.lineNumber as number,
      signature: args.signature as string,
      tags: args.tags as string[],
    });
    return { success: true, nodeId };
  },
});

registry.add({
  name: "kg_add_edge",
  description: "添加知识图谱边",
  inputSchema: {
    source: z.string().describe("源节点 ID"),
    target: z.string().describe("目标节点 ID"),
    type: z.enum(["calls", "imports", "extends", "implements", "contains", "depends-on", "related-to", "is-a", "part-of", "uses", "defines", "exports"]).describe("边类型"),
    weight: z.number().optional().default(1.0).describe("权重"),
    description: z.string().optional().describe("描述"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    const edgeId = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    kg.addEdge({
      id: edgeId,
      source: args.source as string,
      target: args.target as string,
      type: args.type as KGEdgeType,
      weight: (args.weight as number) || 1.0,
      description: args.description as string,
    });
    return { success: true, edgeId };
  },
});

registry.add({
  name: "kg_search_nodes",
  description: "搜索知识图谱节点",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    type: z.enum(["function", "class", "module", "interface", "type", "variable", "file", "directory", "concept", "entity"]).optional().describe("节点类型过滤"),
    limit: z.number().optional().default(20).describe("返回数量"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    const nodes = kg.searchNodes(args.query as string, {
      type: args.type as KGNodeType | undefined,
      limit: args.limit as number,
    });
    return nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      description: n.description,
      importance: n.importance,
    }));
  },
});

registry.add({
  name: "kg_subgraph",
  description: "获取知识图谱子图 (BFS)",
  inputSchema: {
    nodeId: z.string().describe("起始节点 ID"),
    depth: z.number().optional().default(2).describe("遍历深度"),
    maxNodes: z.number().optional().default(100).describe("最大节点数"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    const result = kg.subgraph(args.nodeId as string, args.depth as number, args.maxNodes as number);
    return {
      nodes: result.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        description: n.description,
      })),
      edges: result.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: e.type,
        weight: e.weight,
      })),
    };
  },
});

registry.add({
  name: "kg_shortest_path",
  description: "查找两个节点之间的最短路径",
  inputSchema: {
    startId: z.string().describe("起始节点 ID"),
    endId: z.string().describe("结束节点 ID"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    const path = kg.shortestPath(args.startId as string, args.endId as string);
    if (!path) {
      return { success: false, error: "No path found" };
    }
    return { success: true, path };
  },
});

registry.add({
  name: "kg_detect_communities",
  description: "检测知识图谱社区",
  inputSchema: {},
  handler: async () => {
    const kg = getKGEnhancedInstance();
    const communities = kg.detectCommunities();
    return communities.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      nodeCount: c.nodes.length,
    }));
  },
});

registry.add({
  name: "kg_echarts_data",
  description: "获取 ECharts 可视化数据",
  inputSchema: {
    maxNodes: z.number().optional().default(200).describe("最大节点数"),
    includeEdges: z.boolean().optional().default(true).describe("是否包含边"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    return kg.toEChartsData({
      maxNodes: args.maxNodes as number,
      includeEdges: args.includeEdges as boolean,
    });
  },
});

registry.add({
  name: "kg_d3_data",
  description: "获取 D3.js 可视化数据",
  inputSchema: {
    maxNodes: z.number().optional().default(200).describe("最大节点数"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    return kg.toD3Data({ maxNodes: args.maxNodes as number });
  },
});

registry.add({
  name: "kg_nl_query",
  description: "自然语言查询知识图谱",
  inputSchema: {
    question: z.string().describe("自然语言问题"),
  },
  handler: async (args) => {
    const kg = getKGEnhancedInstance();
    return kg.queryNL(args.question as string);
  },
});

registry.add({
  name: "kg_enhanced_stats",
  description: "获取知识图谱增强统计信息",
  inputSchema: {},
  handler: async () => {
    const kg = getKGEnhancedInstance();
    return kg.getStats();
  },
});

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
  const port = Number(process.env.MCP_PORT) || 3001;

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
