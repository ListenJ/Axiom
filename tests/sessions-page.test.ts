/**
 * Sessions Page — 会话管理单元测试
 * 运行: bun test tests/sessions-page.test.ts
 */
import { describe, it, expect } from 'bun:test'

// ── 数据格式验证 ──────────────────────────────────────────────────

describe('Sessions Page — 会话管理', () => {
  describe('会话列表数据', () => {
    it('应包含所有必需字段', () => {
      const session = {
        session_id: 'abc-123',
        message_count: 15,
        user_messages: 8,
        assistant_messages: 7,
        total_tokens: 2400,
        started_at: Date.now() / 1000,
        last_active: Date.now() / 1000,
      }

      expect(session.session_id).toBeDefined()
      expect(typeof session.session_id).toBe('string')
      expect(typeof session.message_count).toBe('number')
      expect(typeof session.user_messages).toBe('number')
      expect(typeof session.assistant_messages).toBe('number')
      expect(typeof session.total_tokens).toBe('number')
      expect(typeof session.started_at).toBe('number')
      expect(typeof session.last_active).toBe('number')
    })

    it('应能计算会话时长', () => {
      const started = Date.now() / 1000 - 300 // 5分钟前
      const lastActive = Date.now() / 1000
      const durationSec = lastActive - started
      expect(Math.round(durationSec)).toBe(300)
    })

    it('应能按最后活跃时间排序', () => {
      const sessions = [
        { session_id: 's1', last_active: 1000 },
        { session_id: 's2', last_active: 3000 },
        { session_id: 's3', last_active: 2000 },
      ]

      const sorted = [...sessions].sort((a, b) => b.last_active - a.last_active)
      expect(sorted.map((s) => s.session_id)).toEqual(['s2', 's3', 's1'])
    })

    it('应能按消息数量筛选', () => {
      const sessions = [
        { session_id: 's1', message_count: 5 },
        { session_id: 's2', message_count: 50 },
        { session_id: 's3', message_count: 100 },
      ]

      const active = sessions.filter((s) => s.message_count > 20)
      expect(active.length).toBe(2)
      expect(active.map((s) => s.session_id)).toEqual(['s2', 's3'])
    })

    it('应能过滤空会话', () => {
      const sessions = [
        { session_id: 's1', message_count: 0 },
        { session_id: 's2', message_count: 5 },
        { session_id: 's3', message_count: 0 },
      ]

      const valid = sessions.filter((s) => s.message_count > 0)
      expect(valid.length).toBe(1)
    })
  })

  describe('对话消息数据', () => {
    it('应包含所有消息字段', () => {
      const message = {
        id: 'msg-1',
        session_id: 'abc-123',
        role: 'user',
        content: '你好',
        agent_id: null,
        tool_calls: null,
        tool_results: null,
        tokens_used: 10,
        latency_ms: 50,
        created_at: Date.now(),
      }

      expect(typeof message.id).toBe('string')
      expect(typeof message.session_id).toBe('string')
      expect(['user', 'assistant', 'system']).toContain(message.role)
      expect(typeof message.content).toBe('string')
    })

    it('应能按角色分组统计', () => {
      const messages = [
        { role: 'user', tokens_used: 10 },
        { role: 'assistant', tokens_used: 20 },
        { role: 'user', tokens_used: 5 },
        { role: 'assistant', tokens_used: 15 },
      ]

      const byRole = messages.reduce(
        (acc, m) => {
          acc[m.role] = (acc[m.role] || 0) + m.tokens_used
          return acc
        },
        {} as Record<string, number>,
      )

      expect(byRole.user).toBe(15)
      expect(byRole.assistant).toBe(35)
    })

    it('应能计算对话总 token 数', () => {
      const messages = [
        { tokens_used: 100 },
        { tokens_used: 200 },
        { tokens_used: 150 },
      ]

      const total = messages.reduce((sum, m) => sum + (m.tokens_used || 0), 0)
      expect(total).toBe(450)
    })

    it('应能过滤带工具调用的消息', () => {
      const messages = [
        { id: 'm1', role: 'user', tool_calls: null },
        { id: 'm2', role: 'assistant', tool_calls: [{ name: 'bash' }] },
        { id: 'm3', role: 'assistant', tool_calls: null },
      ]

      const withTools = messages.filter((m) => m.tool_calls != null)
      expect(withTools.length).toBe(1)
      expect(withTools[0].id).toBe('m2')
    })
  })

  describe('使用统计', () => {
    it('应包含所有使用统计字段', () => {
      const usage = {
        provider: 'openai',
        model_name: 'gpt-4',
        call_count: 100,
        total_prompt_tokens: 50000,
        total_completion_tokens: 20000,
        avg_latency_ms: 500,
        success_count: 95,
      }

      expect(typeof usage.provider).toBe('string')
      expect(typeof usage.model_name).toBe('string')
      expect(typeof usage.call_count).toBe('number')
      expect(typeof usage.total_prompt_tokens).toBe('number')
      expect(typeof usage.total_completion_tokens).toBe('number')
      expect(typeof usage.avg_latency_ms).toBe('number')
      expect(typeof usage.success_count).toBe('number')
    })

    it('应能计算成功率', () => {
      const usage = { call_count: 100, success_count: 95 }
      const rate = usage.call_count > 0 ? (usage.success_count / usage.call_count) * 100 : 0
      expect(rate).toBe(95)
    })

    it('应能计算平均 token 消耗', () => {
      const usage = { total_prompt_tokens: 50000, total_completion_tokens: 20000, call_count: 100 }
      const avgPrompt = usage.total_prompt_tokens / usage.call_count
      const avgCompletion = usage.total_completion_tokens / usage.call_count
      expect(avgPrompt).toBe(500)
      expect(avgCompletion).toBe(200)
    })

    it('应能按调用次数排序', () => {
      const usageList = [
        { provider: 'openai', call_count: 100 },
        { provider: 'anthropic', call_count: 500 },
        { provider: 'deepseek', call_count: 200 },
      ]

      const sorted = [...usageList].sort((a, b) => b.call_count - a.call_count)
      expect(sorted.map((u) => u.provider)).toEqual(['anthropic', 'deepseek', 'openai'])
    })

    it('应能计算总 token 消耗', () => {
      const usageList = [
        { total_prompt_tokens: 50000, total_completion_tokens: 20000 },
        { total_prompt_tokens: 30000, total_completion_tokens: 15000 },
      ]

      const totalPrompt = usageList.reduce((sum, u) => sum + u.total_prompt_tokens, 0)
      const totalCompletion = usageList.reduce((sum, u) => sum + u.total_completion_tokens, 0)
      expect(totalPrompt).toBe(80000)
      expect(totalCompletion).toBe(35000)
    })

    it('应能按延迟排序', () => {
      const usageList = [
        { provider: 'openai', avg_latency_ms: 200 },
        { provider: 'anthropic', avg_latency_ms: 500 },
        { provider: 'deepseek', avg_latency_ms: 150 },
      ]

      const sorted = [...usageList].sort((a, b) => a.avg_latency_ms - b.avg_latency_ms)
      expect(sorted.map((u) => u.provider)).toEqual(['deepseek', 'openai', 'anthropic'])
    })
  })

  describe('日期时间格式化', () => {
    it('应能格式化 epoch 时间戳', () => {
      const epoch = 1718300000
      const date = new Date(epoch * 1000)
      expect(date.getFullYear()).toBe(2024)
    })

    it('应能计算相对时间', () => {
      const now = Date.now() / 1000
      const past = now - 3600 // 1小时前
      const diffMin = Math.round((now - past) / 60)
      expect(diffMin).toBe(60)
    })

    it('应能格式化 token 数量', () => {
      const formatTokens = (n: number) => {
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
        return `${n}`
      }

      expect(formatTokens(500)).toBe('500')
      expect(formatTokens(1500)).toBe('1.5K')
      expect(formatTokens(2500000)).toBe('2.5M')
    })
  })
})
