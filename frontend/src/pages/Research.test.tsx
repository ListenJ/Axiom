// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Research from './Research'

function renderWithRoutes() {
  return render(
    <MemoryRouter initialEntries={['/research']}>
      <Routes>
        <Route path="/research" element={<Research />} />
        <Route path="/search" element={<div>SEARCH_TARGET</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Research page — legacy redirect', () => {
  it('renders the migration notice and navigates to the new hub', async () => {
    renderWithRoutes()
    expect(screen.getByRole('heading', { name: '深度研究' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /前往搜索 Hub/ }))
    expect(await screen.findByText('SEARCH_TARGET')).toBeInTheDocument()
  })
})
