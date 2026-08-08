import { test, expect } from '@playwright/test'

/** 服务端鉴权 Token：优先取 CI 环境变量，本地默认与 .env 的 AXIOM_AUTH_TOKEN 一致 */
const AUTH_TOKEN = process.env.AXIOM_AUTH_TOKEN || 'your-secure-random-token-at-least-16-chars'

/**
 * 页面整洁化 + 动画进出 + 动效设置 测试
 *
 * 覆盖：
 *  1. 底部全局状态栏已移除，系统状态迁入右栏「工作摘要」
 *  2. 右栏为按需弹出的悬浮抽屉（动画进出，不占位、不推挤主内容）
 *  3. 终端为覆盖式浮层动画（不推挤主内容）
 *  4. 动效强度 off 时终端无运行动画
 */

test.describe('页面整洁化与动画', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      (t) => { try { localStorage.setItem('token', t) } catch (e) { /* ignore */ } },
      AUTH_TOKEN,
    )
  })

  test('底部无全局状态栏，系统状态迁入右栏摘要（环境信息/子智能体/来源）', async ({ page }) => {
    await page.goto('/chat')
    // 右栏默认收起（按需唤起），先点工具栏「打开摘要」
    await page.getByLabel('打开摘要').click()
    await page.waitForSelector('#rightbar-panel')

    const aside = page.getByRole('complementary', { name: '右侧工具台' })
    const panel = aside.locator('#rightbar-panel')
    await expect(panel).toContainText('环境信息')
    await expect(panel).toContainText('子智能体')
    await expect(panel).toContainText('来源')
    await expect(panel).toContainText('缓存命中')

    // 「缓存命中」可见元素仅 1 处（底部无状态条；隐藏的移动端抽屉不计）
    await expect(page.getByText('缓存命中', { exact: true }).filter({ visible: true })).toHaveCount(1)

    // 底部输入框存在且可用（此前被状态栏占据的位置现在直接是输入区）
    const input = page.getByLabel('消息输入框')
    await expect(input).toBeVisible()
  })

  test('右栏为悬浮浮层：滑入/滑出动画、不占用工作区空间', async ({ page }) => {
    await page.goto('/chat')
    const aside = page.getByRole('complementary', { name: '右侧工具台' })
    // 默认收起 → 通过系统菜单「视图 → 打开工具台」唤起
    await page.getByRole('button', { name: '视图' }).click()
    await page.getByRole('menuitem', { name: '打开工具台' }).click()
    await expect(aside).toBeVisible()

    const widthOf = () => aside.evaluate((el) => el.getBoundingClientRect().width)
    const inputWidth = () =>
      page.locator('#home-input').evaluate((el) => el.getBoundingClientRect().width)

    // 默认展开：宽度 400（悬浮浮层）
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="右侧工具台"]')
      return el && el.getBoundingClientRect().width >= 399
    })
    expect(await widthOf()).toBeGreaterThan(399)
    expect(await widthOf()).toBeLessThan(401)
    const inputOpen = await inputWidth()

    // 收起：滑出动画（采样中间透明度），最终隐藏；工作区宽度不变（不占空间）
    await aside.getByLabel('收起工具台').click()
    const exitSeen = await page.evaluate(async () => {
      let seen = false
      for (let i = 0; i < 30; i++) {
        const el = document.querySelector('[aria-label="右侧工具台"]')
        if (!el) break
        const o = parseFloat(getComputedStyle(el).opacity)
        if (!Number.isNaN(o) && o > 0 && o < 1) seen = true
        await new Promise((r) => requestAnimationFrame(r))
      }
      return seen
    })
    expect(exitSeen).toBe(true)
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="右侧工具台"]')
      return el && parseFloat(getComputedStyle(el).opacity) < 0.05
    })
    expect(Math.abs((await inputWidth()) - inputOpen)).toBeLessThan(4)

    // 重新展开：视图 → 打开工具台 → 滑入浮层，工作区宽度仍不变
    await page.getByRole('button', { name: '视图' }).click()
    await page.getByRole('menuitem', { name: '打开工具台' }).click()
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="右侧工具台"]')
      return (
        el &&
        el.getBoundingClientRect().width >= 399 &&
        parseFloat(getComputedStyle(el).opacity) > 0.95
      )
    })
    expect(await widthOf()).toBeGreaterThan(399)
    expect(await widthOf()).toBeLessThan(401)
    expect(Math.abs((await inputWidth()) - inputOpen)).toBeLessThan(4)

    // 人机工效：Esc 收起
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="右侧工具台"]')
      return el && parseFloat(getComputedStyle(el).opacity) < 0.05
    })
    expect(Math.abs((await inputWidth()) - inputOpen)).toBeLessThan(4)

    // 人机工效：点击浮层外部收起
    await page.getByRole('button', { name: '视图' }).click()
    await page.getByRole('menuitem', { name: '打开工具台' }).click()
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="右侧工具台"]')
      return el && parseFloat(getComputedStyle(el).opacity) > 0.95
    })
    await page.locator('#home-input').click({ position: { x: 4, y: 4 } })
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="右侧工具台"]')
      return el && parseFloat(getComputedStyle(el).opacity) < 0.05
    })
  })

  test('终端为覆盖式浮层动画，不推挤主内容', async ({ page }) => {
    await page.goto('/chat')
    const mainHeightBefore = await page.locator('main').evaluate((el) => el.getBoundingClientRect().height)

    // 视图 → 打开终端
    await page.getByRole('button', { name: '视图' }).click()
    await page.getByRole('menuitem', { name: '打开终端' }).click()

    const terminal = page.getByRole('region', { name: '终端' })
    await expect(terminal).toBeVisible()

    // 覆盖式：存在 fixed 祖先（不参与文档流占位）
    const hasFixedAncestor = await terminal.evaluate((el) => {
      let n: HTMLElement | null = el as HTMLElement
      while (n) {
        if (getComputedStyle(n).position === 'fixed') return true
        n = n.parentElement
      }
      return false
    })
    expect(hasFixedAncestor).toBe(true)

    // 主内容高度不变（不推挤）
    const mainHeightAfter = await page.locator('main').evaluate((el) => el.getBoundingClientRect().height)
    expect(Math.abs(mainHeightAfter - mainHeightBefore)).toBeLessThan(4)

    // 关闭终端
    await page.getByLabel('关闭终端').click()
    await expect(terminal).toHaveCount(0)
  })

  test('动效强度 off 时终端无运行动画', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('axiom:motion', 'off'))
    await page.goto('/chat')
    await page.getByRole('button', { name: '视图' }).click()
    await page.getByRole('menuitem', { name: '打开终端' }).click()

    const terminal = page.getByRole('region', { name: '终端' })
    await expect(terminal).toBeVisible()
    const running = await terminal.evaluate((el) => {
      const all = el.getAnimations()
      return all.filter((a) => a.playState === 'running').length
    })
    expect(running).toBe(0)
  })
})
