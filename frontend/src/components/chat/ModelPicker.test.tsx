/**
 * ModelPicker 组件测试（输入框右下角模型选择器）
 *
 * 行为：圆环展示当前模型首字母；点击展开弹窗；弹窗内模型列表支持
 * 滚轮滚动选择；思考强度三档可选；选择后回调携带 model + effort。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'

const MODELS = [
  { id: 'glm-4-flash', name: 'GLM-4-Flash (智谱)', provider: 'zhipu', enabled: true },
  { id: 'ds-r1', name: 'DeepSeek R1', provider: 'deepseek', enabled: true },
  { id: 'kimi-k2', name: 'Kimi K2', provider: 'kimi', enabled: true },
]

describe('ModelPicker', () => {
  it('默认显示圆环（当前模型名首字符）', () => {
    render(<ModelPicker models={MODELS} selectedModel="glm-4-flash" onSelect={() => {}} />)
    expect(screen.getByRole('combobox', { name: /G/ })).toBeVisible()
    expect(screen.queryByText('DeepSeek R1')).toBeNull()
  })

  it('点击圆环展开弹窗，展示全部模型', () => {
    render(<ModelPicker models={MODELS} selectedModel="glm-4-flash" onSelect={() => {}} />)
    fireEvent.click(screen.getByRole('combobox', { name: /G/ }))
    expect(screen.getByText('GLM-4-Flash (智谱)')).toBeVisible()
    expect(screen.getByText('DeepSeek R1')).toBeVisible()
    expect(screen.getByText('Kimi K2')).toBeVisible()
  })

  it('选择模型后回调并关闭弹窗', () => {
    const onSelect = vi.fn()
    render(<ModelPicker models={MODELS} selectedModel="glm-4-flash" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('combobox', { name: /G/ }))
    fireEvent.click(screen.getByText('DeepSeek R1'))
    expect(onSelect).toHaveBeenCalledWith('ds-r1')
  })

  it('思考强度三档可见且默认 medium', () => {
    const onSelect = vi.fn()
    render(<ModelPicker models={MODELS} selectedModel="glm-4-flash" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('combobox', { name: /G/ }))
    expect(screen.getByRole('radio', { name: '低' })).toBeVisible()
    expect(screen.getByRole('radio', { name: '中' })).toBeVisible()
    expect(screen.getByRole('radio', { name: '高' })).toBeVisible()
    expect(screen.getByRole('radio', { name: '中' })).toBeChecked()
  })

  it('选择思考强度后回调携带 effort', () => {
    const onSelect = vi.fn()
    render(<ModelPicker models={MODELS} selectedModel="glm-4-flash" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('combobox', { name: /G/ }))
    fireEvent.click(screen.getByRole('radio', { name: '高' }))
    expect(onSelect).toHaveBeenCalledWith('glm-4-flash', 'high')
  })

  it('空模型列表时圆环仍可点开（显示空态）', () => {
    render(<ModelPicker models={[]} selectedModel="x" onSelect={() => {}} />)
    expect(screen.getByRole('combobox', { name: /x/i })).toBeVisible()
    fireEvent.click(screen.getByRole('combobox', { name: /x/i }))
    expect(screen.getByText(/暂无可用模型/)).toBeVisible()
  })
})
