// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Trends from './Trends'

function renderWithRoutes() {
  return render(
    <MemoryRouter initialEntries={['/trends']}>
      <Routes>
        <Route path="/trends" element={<Trends />} />
        <Route path="/search" element={<div>SEARCH_TARGET</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Trends page — legacy redirect', () => {
  it('renders the migration notice and navigates to the new hub', async () => {
    renderWithRoutes()
    expect(screen.getByRole('heading', { name: '趋势分析' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /前往搜索 Hub/ }))
    expect(await screen.findByText('SEARCH_TARGET')).toBeInTheDocument()
  })
})
