import { describe, it, expect, vi } from 'vitest'
import {
  buildCursorUrl,
  buildFileManagerUrl,
  buildVscodeUrl,
  normalizeOpenPath,
  openWorkspaceIn,
} from './open-in'

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))

vi.mock('@/state/useApp', () => ({
  useApp: { getState: () => ({ toast: toastMock }) },
}))

describe('open-in url builders', () => {
  it('normalizes Windows backslashes and trailing slashes', () => {
    expect(normalizeOpenPath('D:\\openclaw-fusion\\')).toBe('D:/openclaw-fusion')
    expect(normalizeOpenPath('./frontend/')).toBe('frontend')
  })

  it('builds vscode urls for Windows and POSIX paths', () => {
    expect(buildVscodeUrl('D:\\openclaw-fusion')).toBe('vscode://file/D:/openclaw-fusion')
    expect(buildVscodeUrl('/home/dev/repo')).toBe('vscode://file/home/dev/repo')
  })

  it('builds cursor urls', () => {
    expect(buildCursorUrl('D:\\openclaw-fusion')).toBe('cursor://file/D:/openclaw-fusion')
  })

  it('builds file manager urls', () => {
    expect(buildFileManagerUrl('D:\\openclaw-fusion')).toBe('file:///D:/openclaw-fusion')
    expect(buildFileManagerUrl('/home/dev/repo')).toBe('file:///home/dev/repo')
  })
})

describe('openWorkspaceIn（纯 Web，2026-09-28 桌面壳退役）', () => {
  it('anchor 协议点击触发系统处理', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    expect(openWorkspaceIn('vscode', 'D:\\openclaw-fusion')).toBe(true)
    expect(openWorkspaceIn('file-manager', '/home/dev/repo')).toBe(true)
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })
})
