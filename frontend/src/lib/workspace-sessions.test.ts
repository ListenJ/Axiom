import { describe, expect, it } from 'vitest'
import {
  groupSessionsForWorkspace,
  summarizeGitDiff,
  workspaceKeyForPath,
  type SessionSummary,
  type WorkspaceSummary,
} from './workspace-sessions'

describe('workspace-sessions 纯函数', () => {
  it('按最近活动排序会话并限制每工作区数量', () => {
    const workspaces: WorkspaceSummary[] = [
      { id: 'ws-1', name: 'openclaw-fusion', path: '.', branch: 'master', clean: true, sessionCount: 3 },
    ]
    const sessions: SessionSummary[] = [
      { session_id: 'old', message_count: 1, last_active: 100 },
      { session_id: 'new', message_count: 2, last_active: 300 },
      { session_id: 'mid', message_count: 3, last_active: 200 },
    ]
    const grouped = groupSessionsForWorkspace(workspaces, sessions, 2)
    expect(grouped.get('')).toEqual([
      expect.objectContaining({ session_id: 'new' }),
      expect.objectContaining({ session_id: 'mid' }),
    ])
  })

  it('归一化 Windows 路径与 ./ 前缀', () => {
    expect(workspaceKeyForPath('.\\src\\routes')).toBe('src/routes')
    expect(workspaceKeyForPath('./src/routes')).toBe('src/routes')
    expect(workspaceKeyForPath('D:\\repo\\')).toBe('D:/repo')
  })

  it('聚合 git diff 的增删行与文件数', () => {
    expect(summarizeGitDiff({ success: true, files: [] })).toEqual({ files: 0, additions: 0, deletions: 0 })
    expect(
      summarizeGitDiff({
        success: true,
        files: [
          { path: 'a.ts', status: 'modified', additions: 3, deletions: 1 },
          { path: 'b.ts', status: 'added', additions: 5 },
          { path: 'c.ts', status: 'deleted', deletions: 2 },
        ],
      }),
    ).toEqual({ files: 3, additions: 8, deletions: 3 })
  })
})
