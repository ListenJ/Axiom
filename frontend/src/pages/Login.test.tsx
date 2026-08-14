// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Login from './Login'

function renderLogin(from = '/chat') {
  return render(
    <MemoryRouter initialEntries={['/login?from=' + encodeURIComponent(from)]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/chat" element={<div>CHAT_TARGET</div>} />
        <Route path="/" element={<div>HOME_TARGET</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Login page — usage scenarios', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('validates an empty token', async () => {
    renderLogin()
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('请输入访问令牌')).toBeInTheDocument()
  })

  it('stores the token and navigates back to the original path', async () => {
    renderLogin('/chat')
    await userEvent.type(screen.getByPlaceholderText('请输入访问令牌'), 'secret-token')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(localStorage.getItem('token')).toBe('secret-token')
    expect(await screen.findByText('CHAT_TARGET')).toBeInTheDocument()
  })

  it('blocks external redirect targets (open-redirect protection)', async () => {
    renderLogin('//evil.example.com')
    await userEvent.type(screen.getByPlaceholderText('请输入访问令牌'), 'secret-token')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('HOME_TARGET')).toBeInTheDocument()
  })
})
