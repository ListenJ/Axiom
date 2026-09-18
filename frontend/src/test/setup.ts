import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
  // Clear localStorage between tests to keep store/initial-state tests isolated
  if (typeof localStorage !== 'undefined') {
    localStorage.clear()
  }
})
