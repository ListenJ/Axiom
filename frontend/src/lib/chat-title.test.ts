import { describe, it, expect, beforeEach } from 'vitest'
import { generateChatTitle, loadChatTitle, saveChatTitle } from './chat-title'

describe('chat-title', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('collapses whitespace and trims the generated title', () => {
    expect(generateChatTitle('  hello   world  ')).toBe('hello world')
  })

  it('truncates long titles at 28 characters with ellipsis', () => {
    const title = generateChatTitle('a'.repeat(60))
    expect(title).toHaveLength(29)
    expect(title.endsWith('…')).toBe(true)
    expect(title.slice(0, 28)).toBe('a'.repeat(28))
  })

  it('saves and loads a title by session id', () => {
    saveChatTitle('s-1', '  Deep Research  ')
    expect(loadChatTitle('s-1')).toBe('Deep Research')
  })

  it('returns null for missing session or unknown id', () => {
    expect(loadChatTitle(null)).toBeNull()
    expect(loadChatTitle(undefined)).toBeNull()
    expect(loadChatTitle('nope')).toBeNull()
  })

  it('ignores save without a session id', () => {
    saveChatTitle(null, 'x')
    saveChatTitle(undefined, 'y')
    expect(loadChatTitle('x')).toBeNull()
    expect(loadChatTitle('y')).toBeNull()
  })
})
