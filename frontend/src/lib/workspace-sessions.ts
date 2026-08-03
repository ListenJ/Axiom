/**
 * Workspace + session helpers for the agent layout.
 *
 * 纯类型与纯函数：不直接发请求（调用方通过 endpoints 获取数据），
 * 便于为左侧工作区/会话和右侧工作摘要提供可测试的聚合逻辑。
 */

export interface WorkspaceSummary {
  id: string
  name: string
  path: string
  branch: string
  clean: boolean
  sessionCount: number
}

export interface SessionSummary {
  session_id: string
  message_count: number
  user_messages?: number
  assistant_messages?: number
  total_tokens?: number
  started_at?: number
  last_active: number
}

export interface DiffFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  additions?: number
  deletions?: number
}

export interface GitDiffResult {
  success: boolean
  files?: DiffFile[]
  diff?: string
  error?: string
}

export interface GitDiffSummary {
  files: number
  additions: number
  deletions: number
}

export interface WebFetchResult {
  url?: string
  title?: string
  description?: string
  markdown?: string
  error?: string
}

export interface LightpandaStatus {
  available: boolean
  method: string
}

/** 规范化路径用于工作区归属比较（Windows 反斜杠 + ./ 前缀归一）。 */
export function workspaceKeyForPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  return normalized === '.' ? '' : normalized
}

/** 将会话列表按工作区归属分组（当前后端为单工作区实现）。 */
export function groupSessionsForWorkspace(
  workspaces: WorkspaceSummary[],
  sessions: SessionSummary[],
  maxPerWorkspace = 8,
): Map<string, SessionSummary[]> {
  const byWorkspace = new Map<string, SessionSummary[]>()
  const normalized = sessions
    .filter((s) => s && typeof s.session_id === 'string')
    .sort((a, b) => Number(b.last_active ?? 0) - Number(a.last_active ?? 0))

  for (const workspace of workspaces) {
    const key = workspaceKeyForPath(workspace.path)
    byWorkspace.set(key, normalized.slice(0, maxPerWorkspace))
  }
  return byWorkspace
}

/** 从 /api/git/diff 响应聚合变更文件数与增删行数。 */
export function summarizeGitDiff(raw: GitDiffResult): GitDiffSummary {
  const files = raw?.files ?? []
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions ?? 0
    deletions += file.deletions ?? 0
  }
  return { files: files.length, additions, deletions }
}
