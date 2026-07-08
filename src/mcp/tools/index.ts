/**
 * MCP Programming Tools — Unified Exports
 * 
 * Filesystem, terminal, git, and code-analysis tools for the MCP server.
 */
export {
  readFile,
  writeFile,
  listDirectory,
  searchFiles,
  deleteFile,
  moveFile,
  fileExists,
  getProjectRoot,
  type FileResult,
  type DirectoryResult,
  type SearchResult as FileSearchResult,
} from "./filesystem.js";

export {
  executeCommand,
  listProcesses,
  killProcess,
  getSystemInfo,
  type CommandResult,
} from "./terminal.js";

export {
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitShow,
  gitBlame,
  type GitStatusResult,
  type GitDiffResult,
  type GitLogResult,
  type GitBranchResult,
} from "./git.js";

export {
  findSymbols,
  findReferences,
  getDiagnostics,
  getFileOutline,
  analyzeCode,
  getCallGraph,
  type SymbolInfo,
  type SymbolSearchResult,
  type DiagnosticsResult,
  type ReferenceResult,
  type OutlineResult,
} from "./code-analysis.js";

export {
  minimaxWebSearch,
  minimaxImageUnderstand,
  checkMiniMaxHealth,
  getMiniMaxInfo,
  type MiniMaxWebSearchResult,
  type MiniMaxWebSearchResponse,
  type MiniMaxImageUnderstandResult,
  type MiniMaxImageUnderstandResponse,
} from "./minimax.js";

export {
  listRepos,
  getRepo,
  createRepo,
  forkRepo,
  listIssues,
  getIssue,
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
  type GitHubRepo,
  type GitHubIssue,
  type GitHubPR,
  type GitHubFileContent,
  type GitHubRelease,
  type GitHubWorkflow,
  type GitHubWorkflowRun,
} from "./github.js";
