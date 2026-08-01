// Lightweight typed API client mirroring the legacy endpoints.
// Supports interceptors, GET caching, AbortController timeout, and streaming.

interface RequestConfig {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeout: number
  signal?: AbortSignal
}

interface CacheOptions {
  ttl?: number
}

type RequestInterceptor = (config: RequestConfig) => RequestConfig | Promise<RequestConfig>
type ResponseInterceptor = (data: unknown, response: Response) => unknown
type UnauthorizedHandler = () => void

interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
  cache?: boolean | CacheOptions
  timeout?: number
  signal?: AbortSignal
}

class HttpError extends Error {
  status: number
  data: unknown
  constructor(message: string, status: number, data: unknown) {
    super(message)
    this.status = status
    this.data = data
  }
}

/**
 * Structured events emitted by `APIClient.stream` while parsing an
 * `text/event-stream` response. The discriminator is `type` so callers
 * can use exhaustive switch narrowing. Extra fields from the upstream
 * payload (model, usage, role, ...) are preserved via the index
 * signature and accessible through the `extra` namespace.
 */
export type ChatStreamEvent =
  | ({ type: 'start' } & ChatStreamMeta)
  | ({ type: 'token'; content: string } & ChatStreamMeta)
  | ({ type: 'done' } & ChatStreamMeta)
  | ({ type: 'error'; message?: string; content?: string } & ChatStreamMeta)

interface ChatStreamMeta {
  model?: string
  provider?: string
  role?: string
  usage?: Record<string, unknown>
}

export type ChatStreamHandler = (event: ChatStreamEvent) => void

/**
 * OpenAI-style chat message shape expected by the backend
 * (`POST /chat/stream` and `POST /chat`). `role` is intentionally
 * typed as `string` (instead of a literal union) so that custom
 * system/tool messages from upstream providers pass through
 * unchanged. `content` is the textual payload of the message.
 */
export interface ChatMessage {
  role: string
  content: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 构造 name 为 'AbortError' 的错误，与 fetch abort 行为保持一致。 */
function abortError(): Error {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/** Best-effort extraction of the assistant message from a legacy `/chat` JSON response. */
function extractChatMessage(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (!isPlainObject(payload)) return JSON.stringify(payload)
  const obj = payload as Record<string, unknown>
  const candidates = ['message', 'content', 'text', 'reply', 'response']
  for (const key of candidates) {
    const value = obj[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return JSON.stringify(payload)
}

function pickMeta(parsed: Record<string, unknown>): ChatStreamMeta {
  const meta: ChatStreamMeta = {}
  if (typeof parsed.model === 'string') meta.model = parsed.model
  if (typeof parsed.provider === 'string') meta.provider = parsed.provider
  if (typeof parsed.role === 'string') meta.role = parsed.role
  if (isPlainObject(parsed.usage)) meta.usage = parsed.usage
  return meta
}

function dispatchSseEvent(parsed: Record<string, unknown>, onEvent: ChatStreamHandler): void {
  const meta = pickMeta(parsed)
  const type = typeof parsed.type === 'string' ? parsed.type : ''
  const content = parsed.content !== undefined ? String(parsed.content) : undefined
  switch (type) {
    case 'start':
      onEvent({ type: 'start', ...meta })
      return
    case 'token':
      onEvent({ type: 'token', content: content ?? '', ...meta })
      return
    case 'done':
      onEvent({ type: 'done', ...meta })
      return
    case 'error': {
      const errorEvent: ChatStreamEvent = {
        type: 'error',
        ...meta,
      }
      if (typeof parsed.message === 'string') errorEvent.message = parsed.message
      if (content !== undefined) errorEvent.content = content
      onEvent(errorEvent)
      return
    }
    default:
      onEvent({ type: 'token', content: content ?? '', ...meta })
  }
}

function handleSseLine(rawLine: string, onEvent: ChatStreamHandler): void {
  const trimmed = rawLine.trim()
  if (!trimmed || trimmed.startsWith(':')) return
  if (!trimmed.startsWith('data:')) return
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') {
    onEvent({ type: 'done' })
    return
  }
  try {
    const parsed = JSON.parse(payload) as unknown
    if (isPlainObject(parsed)) {
      dispatchSseEvent(parsed, onEvent)
      return
    }
    onEvent({ type: 'token', content: payload })
  } catch {
    onEvent({ type: 'token', content: payload })
  }
}

export class APIClient {
  baseURL: string
  timeout: number
  defaultHeaders: Record<string, string>
  private requestInterceptors: RequestInterceptor[] = []
  private responseInterceptors: ResponseInterceptor[] = []
  private unauthorizedHandlers: UnauthorizedHandler[] = []
  private cache = new Map<string, { time: number; data: unknown; ttl: number }>()
  cacheEnabled: boolean

  constructor(options: { baseURL?: string; timeout?: number; headers?: Record<string, string>; cache?: boolean } = {}) {
    this.baseURL = options.baseURL ?? ''
    this.timeout = options.timeout ?? 30000
    this.defaultHeaders = options.headers ?? {}
    this.cacheEnabled = options.cache !== false
  }

  requestInterceptor(fn: RequestInterceptor) {
    this.requestInterceptors.push(fn)
    return this
  }

  responseInterceptor(fn: ResponseInterceptor) {
    this.responseInterceptors.push(fn)
    return this
  }

  /** 注册 401 处理器：任何请求收到 401 时依次调用（清除 token、跳转登录页等）。 */
  onUnauthorized(fn: UnauthorizedHandler) {
    this.unauthorizedHandlers.push(fn)
    return this
  }

  private notifyUnauthorized() {
    for (const fn of this.unauthorizedHandlers) {
      try {
        fn()
      } catch {
        /* 处理器异常不应掩盖原始 401 错误 */
      }
    }
  }

  private buildURL(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const base = this.baseURL.replace(/\/$/, '') + '/' + path.replace(/^\//, '')
    if (!params) return base
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue
      qs.append(k, String(v))
    }
    const s = qs.toString()
    return s ? `${base}?${s}` : base
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { params, body, headers, cache, timeout = this.timeout } = options
    const fullURL = this.buildURL(path, params)
    const cacheKey = `${method}:${fullURL}`

    if (method === 'GET' && cache !== false && this.cacheEnabled) {
      const cached = this.cache.get(cacheKey)
      if (cached && Date.now() - cached.time < cached.ttl) {
        return cached.data as T
      }
    }

    let config: RequestConfig = {
      method,
      url: fullURL,
      headers: { ...this.defaultHeaders, ...(headers ?? {}) },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      timeout,
    }
    for (const i of this.requestInterceptors) {
      config = await i(config)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeout)
    const onExternalAbort = () => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const response = await fetch(config.url, {
        method: config.method,
        headers: config.headers,
        body: config.body,
        signal: controller.signal,
      })
      clearTimeout(timer)

      const contentType = response.headers.get('content-type') || ''
      let data: unknown = contentType.includes('application/json') ? await response.json() : await response.text()

      if (!response.ok) {
        if (response.status === 401) this.notifyUnauthorized()
        const dataObj = data as Record<string, unknown> | null
        const messageField =
          dataObj && typeof dataObj === 'object' && 'message' in dataObj
            ? String(dataObj.message)
            : null
        const textField = typeof data === 'string' ? data : null
        const msg = messageField ?? textField ?? `HTTP ${response.status}`
        throw new HttpError(msg, response.status, data)
      }

      for (const i of this.responseInterceptors) {
        data = (await i(data, response)) ?? data
      }

      if (method === 'GET' && cache !== false && this.cacheEnabled) {
        const ttl = typeof cache === 'object' && cache?.ttl ? cache.ttl : 60000
        this.cache.set(cacheKey, { time: Date.now(), data, ttl })
      }
      return data as T
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HttpError('Request timeout', 0, null)
      }
      throw err
    }
  }

  get<T = unknown>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, options)
  }
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('POST', path, { ...(options ?? {}), body })
  }
  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('PUT', path, { ...(options ?? {}), body })
  }
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('PATCH', path, { ...(options ?? {}), body })
  }
  delete<T = unknown>(path: string, options?: RequestOptions) {
    return this.request<T>('DELETE', path, options)
  }

  async stream(
    path: string,
    body: unknown,
    onEvent: (event: ChatStreamEvent) => void,
    options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<AbortController> {
    const url = this.buildURL(path)
    const controller = new AbortController()
    // 外部 signal 与内部 controller 联动：fetch 始终挂在内部 signal 上，
    // 这样调用方 abort 外部 signal 或内部 controller 都能中止请求。
    const onExternalAbort = () => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...this.defaultHeaders, ...(options.headers ?? {}), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      if (response.status === 401) this.notifyUnauthorized()
      throw new HttpError(`HTTP ${response.status}`, response.status, null)
    }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      // The backend responded with a non-SSE payload (legacy JSON endpoint or
      // a transitional response). Drain and discard the body, then fall back
      // to the non-streaming chat endpoint so the same caller keeps working
      // against older backends that haven't deployed `/chat/stream` yet.
      await response.body?.cancel()
      const fallbackBody = isPlainObject(body) ? body : { message: body }
      const fallback = await api.post('/chat', fallbackBody, { signal: controller.signal })
      const text = extractChatMessage(fallback)
      onEvent({ type: 'token', content: text })
      onEvent({ type: 'done' })
      return controller
    }
    const reader = response.body.getReader()
    // abort 时主动 cancel reader，让挂起的 read() 立即返回，不再向调用方派发事件
    const cancelReader = () => {
      reader.cancel().catch(() => {})
    }
    if (controller.signal.aborted) cancelReader()
    else controller.signal.addEventListener('abort', cancelReader, { once: true })
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (controller.signal.aborted) break
          handleSseLine(line, onEvent)
        }
      }
      if (controller.signal.aborted) {
        throw abortError()
      }
      if (buffer.trim()) {
        handleSseLine(buffer, onEvent)
      }
      onEvent({ type: 'done' })
    } catch (err) {
      // abort 期间 reader/read 抛出的任意错误统一归一化为 AbortError，
      // 让调用方（Chat/Home 的 catch）走“用户主动中止”分支
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw abortError()
      }
      throw err
    } finally {
      controller.signal.removeEventListener('abort', cancelReader)
      options.signal?.removeEventListener('abort', onExternalAbort)
      try {
        reader.releaseLock()
      } catch {
        /* already released */
      }
    }
    return controller
  }

  clearCache(pattern?: string) {
    if (!pattern) {
      this.cache.clear()
      return
    }
    for (const key of Array.from(this.cache.keys())) {
      if (key.includes(pattern)) this.cache.delete(key)
    }
  }
}

export const api = new APIClient({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
})

api.requestInterceptor((config) => {
  if (typeof localStorage !== 'undefined') {
    const token = localStorage.getItem('token')
    if (token) config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.responseInterceptor((data) => {
  if (typeof localStorage !== 'undefined' && data && typeof data === 'object' && 'token' in (data as Record<string, unknown>)) {
    localStorage.setItem('token', String((data as Record<string, unknown>).token))
  }
  return data
})

// 401 闭环：清除本地 token 并跳转登录页。
// 注意：api.ts 位于 React 树之外，拿不到 router 实例，这里用 location.assign
// 做整页跳转（顺带丢弃内存中的过期状态）。只在后端真正返回 401 时触发——
// 本地回环请求后端豁免鉴权（见 src/utils/auth-check.ts），不会走到这里，
// 因此不会把本地开发锁死。已在 /login 时跳过，避免重定向循环。
api.onUnauthorized(() => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('token')
  }
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    const from = window.location.pathname + window.location.search
    window.location.assign(`/login?from=${encodeURIComponent(from)}`)
  }
})

export const endpoints = {
  stats: () => api.get('/api/stats'),
  tokenDetails: (days?: number) => api.get(`/api/token-details${days ? `?days=${days}` : ''}`),
  chat: {
    send: (message: string, options: Record<string, unknown> = {}) =>
      api.post('/chat', { message, ...options }),
    stream: (
      messages: ChatMessage[],
      onEvent: ChatStreamHandler,
      options: {
        intent?: boolean
        preferNativeStream?: boolean
        signal?: AbortSignal
        model?: string
        reasoningEffort?: 'low' | 'medium' | 'high'
      } = {},
    ) => {
      // Destructure `signal` so it is NEVER serialized into the JSON body.
      // The signal belongs on the fetch init, not in the request payload.
      const { signal, ...bodyOptions } = options
      // Defensive: if a caller ever passes a `signal`-shaped key inside the
      // body options (e.g. via a loose `Record<string, unknown>`), strip it
      // so it cannot leak into `JSON.stringify` and corrupt the request.
      const safeBodyOptions: Record<string, unknown> = { ...bodyOptions }
      if ('signal' in safeBodyOptions) {
        delete safeBodyOptions.signal
      }
      return api.stream(
        '/chat/stream',
        { messages, taskType: 'general-chat', ...safeBodyOptions },
        onEvent,
        signal !== undefined ? { signal } : {},
      )
    },
    history: () => api.get('/chat/history'),
  },
  search: {
    vault: (query: string, options: Record<string, unknown> = {}) =>
      api.get('/search', { params: { q: query, ...options } }),
    code: (query: string) => api.get('/search/code', { params: { q: query } }),
    suggest: (query: string) => api.get('/search/suggest', { params: { q: query } }),
  },
  codegraph: {
    status: () => api.get('/codegraph/status'),
    search: (query: string, options: Record<string, unknown> = {}) =>
      api.get('/codegraph/search', { params: { q: query, ...options } }),
    init: () => api.post('/codegraph/init'),
    fileIndex: () => api.get('/file-index'),
  },
  agents: {
    status: () => api.get('/agents/status'),
    generate: (code: string, options: Record<string, unknown> = {}) =>
      api.post('/agents/opencode/generate', { code, ...options }),
    refactor: (code: string, instructions: string) =>
      api.post('/agents/opencode/refactor', { code, instructions }),
    review: (code: string) => api.post('/agents/opencode/review', { code }),
    test: (code: string) => api.post('/agents/opencode/test', { code }),
  },
  router: {
    status: () => api.get('/advisor/status'),
    health: () => api.get('/advisor/health'),
    tokenStats: () => api.get('/memory/usage'),
  },
  vault: {
    stats: () => api.get('/vault/stats'),
    tags: () => api.get('/vault/tags'),
    para: () => api.get('/vault/para'),
    network: (path: string) => api.get(`/vault/network/${encodeURIComponent(path)}`),
  },
  kg: {
    stats: () => api.get('/kg/stats'),
    entities: () => api.get('/kg/entities'),
    graph: () => api.get('/kg/graph'),
  },
  perf: {
    metrics: () => api.get('/metrics'),
    native: () => api.get('/native/stats').catch(() => null),
  },
  eval: {
    stats: () => api.get('/eval/stats'),
    results: (params?: Record<string, string | number | boolean | undefined>) =>
      api.get('/eval/results', { params }),
    model: (id: string) => api.get(`/eval/model/${encodeURIComponent(id)}`),
    trend: (id: string, params?: Record<string, string | number | boolean | undefined>) =>
      api.get(`/eval/trend/${encodeURIComponent(id)}`, { params }),
    models: (params?: Record<string, string | number | boolean | undefined>) =>
      api.get('/eval/models', { params }),
    run: (body: Record<string, unknown>) => api.post('/eval/run', body),
    assign: (body?: Record<string, unknown>) => api.post('/eval/assign', body),
    assignments: () => api.get('/eval/assignments'),
    assignReport: () => api.get('/eval/assign/report'),
  },
  plugins: {
    list: () => api.get('/plugins'),
    available: () => api.get('/plugins/available'),
    detail: (id: string) => api.get(`/plugins/${encodeURIComponent(id)}`),
    install: (path: string, enable = true) => api.post('/plugins/install', { path, enable }),
    uninstall: (id: string) => api.post(`/plugins/${encodeURIComponent(id)}/uninstall`),
    enable: (id: string) => api.post(`/plugins/${encodeURIComponent(id)}/enable`),
    disable: (id: string) => api.post(`/plugins/${encodeURIComponent(id)}/disable`),
    config: (id: string, config: Record<string, unknown>) =>
      api.post(`/plugins/${encodeURIComponent(id)}/config`, config),
    activeTools: () => api.get('/plugins/active-tools'),
  },
  memory: {
    sessions: () => api.get('/memory/sessions'),
    conversations: (sessionId: string, options?: Record<string, string | number | boolean | undefined>) =>
      api.get('/memory/conversations', { params: { session: sessionId, ...options } }),
    knowledge: (query: string, options?: Record<string, string | number | boolean | undefined>) =>
      api.get('/memory/knowledge', { params: { q: query, ...options } }),
    tasks: (params?: Record<string, string | number | boolean | undefined>) =>
      api.get('/memory/tasks', { params }),
    usage: (days: number) => api.get('/memory/usage', { params: { days } }),
  },
  trends: {
    summary: (days: number) => api.get('/stats/trends', { params: { days } }),
  },
  ocr: {
    status: () => api.get('/ocr/status'),
    scan: (body: { path?: string; url?: string; languages?: string[] }) =>
      api.post('/ocr/scan', { image: body.path || body.url, options: { languages: body.languages } }),
    export: (body: { path?: string; format?: 'md' | 'txt' | 'json' }) =>
      api.post('/ocr/export', { image: body.path, format: body.format === 'md' ? 'markdown' : body.format === 'txt' ? 'text' : 'json', options: {} }),
  },
  research: {
    run: (body: { query: string; depth?: number; maxSources?: number }) =>
      api.post('/research/run', body),
  },
  knowledge: {
    pendingReview: () => api.get('/knowledge/pending-review'),
    reviewAction: (body: { file: string; action: 'approve' | 'reject' }) =>
      api.post('/knowledge/pending-review/action', body),
  },
  proxies: {
    list: () => api.get('/proxies'),
  },
  system: {
    health: () => api.get('/health'),
    version: () => api.get('/version'),
    config: () => api.get('/config'),
  },
  traces: {
    list: () => api.get('/traces'),
    detail: (id: string) => api.get(`/traces/${encodeURIComponent(id)}`),
  },
  permissions: {
    check: (body: { type: 'command' | 'file'; command?: string; path?: string; operation?: string }) =>
      api.post('/permissions/check', body),
    confirm: (confirmationId: string) =>
      api.post('/permissions/confirm', { confirmationId }),
    getMode: () => api.get<{ autoAccept: boolean; highRiskAlwaysConfirmed: boolean }>('/permissions/mode'),
    setMode: (autoAccept: boolean) =>
      api.post<{ autoAccept: boolean; highRiskAlwaysConfirmed: boolean }>('/permissions/mode', { autoAccept }),
  },
  settings: {
    catalog: () => api.get<{ sections: Array<{ id: string; label: string }>; items: Array<{ key: string; section: string; label: string; desc: string; keywords: string[]; type: string; source: string }> }>('/settings/catalog'),
    search: (q: string, limit?: number) =>
      api.post<{ query: string; engine: 'semantic' | 'keyword' | 'hybrid'; results: Array<{ key: string; label: string; desc: string; section: string; score: number; matchType: 'semantic' | 'keyword' }> }>('/settings/search', { q, limit }),
  },
  apiKeys: {
    list: () => api.get('/api-keys'),
    set: (body: { provider: string; apiKey: string; baseURL?: string }) =>
      api.post('/api-keys', body),
    clear: (provider: string) => api.delete(`/api-keys/${encodeURIComponent(provider)}`),
    test: (provider: string) =>
      api.post<{ ok: boolean; latency?: number; modelCount?: number; error?: string }>(
        `/api-keys/${encodeURIComponent(provider)}/test`,
      ),
  },
  models: {
    list: () => api.get<{ models: Array<{ id: string; name: string; provider: string; enabled: boolean }> }>('/models'),
  },
}

export { HttpError }
export default api
