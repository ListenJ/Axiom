import { describe, it, expect } from 'vitest'
import {
  buildCursorUrl,
  buildFileManagerUrl,
  buildVscodeUrl,
  normalizeOpenPath,
} from './open-in'

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
