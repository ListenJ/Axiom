// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import KG from './KG'

function renderWithRoutes() {
  return render(
    <MemoryRouter initialEntries={['/kg']}>
      <Routes>
        <Route path="/kg" element={<KG />} />
        <Route path="/code" element={<div>CODE_TARGET</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('KG page — legacy redirect', () => {
  it('renders the migration notice and navigates to the new hub', async () => {
    renderWithRoutes()
    expect(screen.getByRole('heading', { name: '知识图谱' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /前往代码 Hub/ }))
    expect(await screen.findByText('CODE_TARGET')).toBeInTheDocument()
  })
})
