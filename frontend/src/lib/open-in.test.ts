import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isTauri } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import {
  buildCursorUrl,
  buildFileManagerUrl,
  buildVscodeUrl,
  normalizeOpenPath,
  openWorkspaceIn,
} from './open-in'

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false) }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }))
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

describe('openWorkspaceIn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens via tauri shell plugin in Tauri environment', () => {
    vi.mocked(isTauri).mockReturnValue(true)
    expect(openWorkspaceIn('vscode', 'D:\\openclaw-fusion')).toBe(true)
    expect(shellOpen).toHaveBeenCalledWith('vscode://file/D:/openclaw-fusion')
  })

  it('toasts a fallback hint when tauri shell open fails', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(shellOpen).mockRejectedValueOnce(new Error('not installed'))
    openWorkspaceIn('cursor', '/home/dev/repo')
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Cursor'), 'warning')
  })

  it('falls back to anchor protocol click outside Tauri', () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    expect(openWorkspaceIn('file-manager', '/home/dev/repo')).toBe(true)
    expect(shellOpen).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })
})
