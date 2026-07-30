import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Input } from '@/components/ui'

/**
 * 登录页：输入访问令牌（对应后端 AXIOM_AUTH_TOKEN）。
 * 仅在 API 返回 401 时由 api 客户端跳转过来（见 src/lib/api.ts），
 * 本地回环开发后端豁免鉴权，不会强制经过此页。
 * 提交成功后跳回原本请求的路径（?from=）。
 */
export default function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [token, setToken] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const value = token.trim()
    if (!value) {
      setError('请输入访问令牌')
      return
    }
    localStorage.setItem('token', value)
    const from = searchParams.get('from')
    // 仅接受站内路径，防止开放式重定向
    navigate(from && from.startsWith('/') && !from.startsWith('//') ? from : '/', { replace: true })
  }

  return (
    <div className="fade-in flex h-screen items-center justify-center bg-[var(--bg)] p-6">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-[var(--shadow-md)]">
        <h1 className="text-xl font-semibold text-[var(--text)]">需要身份验证</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          当前服务端已开启访问令牌（AXIOM_AUTH_TOKEN）鉴权，请输入令牌后继续。
        </p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <Input
            label="访问令牌"
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value)
              if (error) setError('')
            }}
            placeholder="请输入访问令牌"
            error={error || undefined}
            autoFocus
          />
          <Button type="submit" className="w-full">
            登录
          </Button>
        </form>
      </div>
    </div>
  )
}
