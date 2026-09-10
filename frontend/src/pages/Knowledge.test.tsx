// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Knowledge from './Knowledge'

function renderWithRoutes() {
  return render(
    <MemoryRouter initialEntries={['/knowledge']}>
      <Routes>
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/vault" element={<div>VAULT_TARGET</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Knowledge page — legacy redirect', () => {
  it('renders the migration notice and navigates to the new hub', async () => {
    renderWithRoutes()
    expect(screen.getByRole('heading', { name: '知识库' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /前往知识 Hub · 待审核/ }))
    expect(await screen.findByText('VAULT_TARGET')).toBeInTheDocument()
  })
})
