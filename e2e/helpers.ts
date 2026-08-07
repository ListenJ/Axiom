import type { Page } from '@playwright/test'

/** 服务端鉴权 Token：CI 用环境变量，本地默认与 .env 的 AXIOM_AUTH_TOKEN 一致 */
export const AUTH_TOKEN =
  process.env.AXIOM_AUTH_TOKEN || 'your-secure-random-token-at-least-16-chars'

/** 在导航前注入鉴权 token（本地回环 API 也要求 x-api-key/Authorization） */
export async function injectAuth(page: Page): Promise<void> {
  await page.addInitScript(
    (t) => {
      try {
        localStorage.setItem('token', t)
      } catch {
        /* ignore */
      }
    },
    AUTH_TOKEN,
  )
}
