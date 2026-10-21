// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ApproverSettingsSection from './ApproverSettingsSection'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  }
})

/** 与后端 GET /settings/approver 的真实响应形状对齐（src/routes/settings.ts）。 */
function approverPayload(overrides: Record<string, unknown> = {}) {
  return {
    resolution: {
      ok: true,
      provider: 'zhipu',
      model: 'glm-4.6',
      source: 'review-role',
      candidates: [
        { provider: 'zhipu', model: 'glm-4.6', role: 'review', priority: 10, keyAvailable: true },
        { provider: 'kimi', model: 'k2', role: 'decision', priority: 20, keyAvailable: false },
      ],
      message: '未显式指定审批模型，使用 review 角色中可用的最高优先级：zhipu/glm-4.6。',
    },
    modelCount: 2,
    mode: 'multi-model',
    hint: '你配置了 2 个模型。可以在这里指定专门用于审批高危操作的模型；不指定时按 review → decision 的顺序自动选择。',
    configuredModels: [
      { provider: 'zhipu', model: 'glm-4.6', role: 'review', priority: 10, keyAvailable: true },
      { provider: 'kimi', model: 'k2', role: 'decision', priority: 20, keyAvailable: false },
    ],
    explicit: '',
    envVar: 'AXIOM_APPROVER_MODEL',
    ...overrides,
  }
}

function renderSection(toast = vi.fn()) {
  render(<ApproverSettingsSection toast={toast} />)
  return toast
}

/** 等待 GET 落地：当前审批模型那一行可见（model 文本同时出现在 option 里，故用 testid）。 */
async function waitLoaded() {
  return screen.findByTestId('approver-current-model')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.apiGet.mockResolvedValue(approverPayload())
})

describe('ApproverSettingsSection', () => {
  it('① 挂载时 GET 并展示当前审批模型与候选列表', async () => {
    renderSection()
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/settings/approver', { cache: false }))

    const current = await waitLoaded()
    expect(current).toHaveTextContent('zhipu/glm-4.6')
    expect(current).toHaveTextContent('review 角色自动选择')

    // 候选列表：下拉含自动选择哨兵 + 全部候选
    const select = screen.getByLabelText('审批模型') as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(['__auto__', 'zhipu/glm-4.6', 'kimi/k2'])
    // GET 时 explicit 为空 ⇒ 默认选中自动选择
    expect(select.value).toBe('__auto__')
    expect(screen.getByText(/写入目标/)).toHaveTextContent('AXIOM_APPROVER_MODEL')
  })

  it('② 选择具体模型后保存，POST 发送 { model } 并回显成功', async () => {
    const toast = renderSection()
    const user = userEvent.setup()
    await waitLoaded()

    mocks.apiPost.mockResolvedValue({ ok: true, model: 'kimi/k2', envPath: '/repo/.env' })
    await user.selectOptions(screen.getByLabelText('审批模型'), 'kimi/k2')

    const save = screen.getByRole('button', { name: '保存' })
    await waitFor(() => expect(save).toBeEnabled())
    await user.click(save)

    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith('/settings/approver', { model: 'kimi/k2' }),
    )
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('kimi/k2'), 'success'))
    // 回显：下拉与来源都切到显式配置
    await waitFor(() => expect((screen.getByLabelText('审批模型') as HTMLSelectElement).value).toBe('kimi/k2'))
    expect(await waitLoaded()).toHaveTextContent('显式配置')
  })

  it('②b 保存按钮在「自动选择」下禁用（后端拒绝空 model）', async () => {
    renderSection()
    await waitLoaded()
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(mocks.apiPost).not.toHaveBeenCalled()
    expect(screen.getByText(/后端 POST 只接受非空 model/)).toBeInTheDocument()
  })

  it('③ 保存失败时显示错误并回滚到后端确认过的值', async () => {
    const toast = renderSection()
    const user = userEvent.setup()
    await waitLoaded()

    // 400 + { error } —— api.ts 对 4xx 优先找 message，这里走 HttpError.data.error 分支
    mocks.apiPost.mockRejectedValue(
      Object.assign(new Error('HTTP 400'), { status: 400, data: { error: '审批模型写入失败：.env 只读' } }),
    )
    await user.selectOptions(screen.getByLabelText('审批模型'), 'kimi/k2')
    const save = screen.getByRole('button', { name: '保存' })
    await waitFor(() => expect(save).toBeEnabled())
    await user.click(save)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('审批模型写入失败：.env 只读')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('.env 只读'), 'error')
    // 回滚：下拉回到后端确认过的 explicit（这里为空 ⇒ 自动选择）
    await waitFor(() => expect((screen.getByLabelText('审批模型') as HTMLSelectElement).value).toBe('__auto__'))
    // 回滚后与后端状态一致 ⇒ 无待保存变更，保存按钮禁用
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('GET 失败时行内显示错误，不静默吞掉', async () => {
    mocks.apiGet.mockRejectedValue(
      Object.assign(new Error('HTTP 500'), { status: 500, data: { error: '读取审批配置失败' } }),
    )
    renderSection()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('读取审批配置失败')
  })

  it('GET 返回格式异常时提示而非空白', async () => {
    mocks.apiGet.mockResolvedValue({ nope: true })
    renderSection()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/响应格式异常/)
    expect(screen.queryByLabelText('审批模型')).not.toBeInTheDocument()
  })

  it('候选为空时下拉禁用并给出指引（无可用模型）', async () => {
    mocks.apiGet.mockResolvedValue(
      approverPayload({
        resolution: { ok: false, source: 'none', candidates: [], message: '当前没有任何可用模型。' },
        modelCount: 0,
        mode: 'none',
        hint: '尚未检测到可用模型。',
        configuredModels: [],
      }),
    )
    renderSection()
    const current = await waitLoaded()
    expect(current).toHaveTextContent('无可用审批人')
    expect((screen.getByLabelText('审批模型') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText(/当前没有可用模型/)).toBeInTheDocument()
  })
})