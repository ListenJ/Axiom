import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { APIClient, HttpError, api } from './api'

// In-memory fetch mock. Each test sets the next response.
type Json = unknown
let nextResponse: { status: number; body: Json; contentType?: string } = {
  status: 200,
  body: {},
}

function mockFetchOnce(response: typeof nextResponse) {
  nextResponse = response
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => {
    const { status, body, contentType = 'application/json' } = nextResponse
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('APIClient.buildURL', () => {
  it('strips trailing slash on baseURL and leading slash on path', async () => {
    const client = new APIClient({ baseURL: 'http://api/' })
    mockFetchOnce({ status: 200, body: { ok: true } })
    await client.get('/users')
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://api/users')
  })

  it('appends a query string from params, skipping undefined values', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 200, body: {} })
    await client.get('/search', { params: { q: 'hi', days: 7, skip: undefined } })
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://api/search?q=hi&days=7')
  })

  it('omits the query string when no params are provided', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 200, body: {} })
    await client.get('/health')
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://api/health')
  })
})

describe('APIClient.request', () => {
  it('parses JSON responses when content-type is application/json', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 200, body: { hello: 'world' } })
    const data = await client.get<{ hello: string }>('/x')
    expect(data).toEqual({ hello: 'world' })
  })

  it('falls back to text when content-type is not JSON', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 200, body: 'plain', contentType: 'text/plain' })
    const data = await client.get<string>('/x')
    expect(data).toBe('plain')
  })

  it('throws HttpError on non-2xx status with the message from the body when present', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 400, body: { message: 'bad input' } })
    await expect(client.get('/x')).rejects.toMatchObject({
      name: 'Error',
      message: 'bad input',
      status: 400,
    })
  })

  it('falls back to the raw text body when the error has no message field', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 500, body: 'oops', contentType: 'text/plain' })
    try {
      await client.get('/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as HttpError).message).toBe('oops')
      expect((e as HttpError).status).toBe(500)
    }
  })

  it('falls back to "HTTP <status>" when the error body has no message', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 503, body: {} })
    try {
      await client.get('/x')
      expect.fail('expected throw')
    } catch (e) {
      expect((e as HttpError).message).toBe('HTTP 503')
    }
  })

  it('serializes a non-string body to JSON and sends it as the request body', async () => {
    const client = new APIClient({ baseURL: 'http://api', headers: { 'Content-Type': 'application/json' } })
    mockFetchOnce({ status: 200, body: { ok: true } })
    await client.post('/users', { name: 'a' })
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'a' }))
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('aborts the request and throws an HttpError on timeout', async () => {
    vi.useFakeTimers()
    const client = new APIClient({ baseURL: 'http://api', timeout: 50 })
    // fetch that never resolves
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
    )
    const p = client.get('/slow')
    p.catch(() => {}) // avoid unhandled rejection
    vi.advanceTimersByTime(60)
    await expect(p).rejects.toMatchObject({ message: 'Request timeout', status: 0 })
    vi.useRealTimers()
  })
})

describe('APIClient caching', () => {
  it('returns cached GET responses within the TTL window', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 200, body: { v: 1 } })
    const a = await client.get('/cached', { cache: { ttl: 60_000 } })
    // Second call with different body — but the mock would still respond with v:1.
    // The point is to assert fetch is not called the second time.
    mockFetchOnce({ status: 200, body: { v: 2 } })
    const b = await client.get('/cached', { cache: { ttl: 60_000 } })
    expect(a).toEqual({ v: 1 })
    expect(b).toEqual({ v: 1 })
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('skips the cache when cache: false is passed', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 200, body: { v: 1 } })
    await client.get('/no-cache', { cache: false })
    mockFetchOnce({ status: 200, body: { v: 2 } })
    await client.get('/no-cache', { cache: false })
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('clearCache(pattern) only removes keys containing the pattern', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    mockFetchOnce({ status: 200, body: { a: 1 } })
    await client.get('/keep')
    mockFetchOnce({ status: 200, body: { b: 2 } })
    await client.get('/drop')
    client.clearCache('/drop')
    mockFetchOnce({ status: 200, body: { a: 99 } })
    mockFetchOnce({ status: 200, body: { b: 99 } })
    expect(await client.get('/keep', { cache: { ttl: 60_000 } })).toEqual({ a: 1 })
    expect(await client.get('/drop', { cache: { ttl: 60_000 } })).toEqual({ b: 99 })
  })
})

describe('APIClient.stream', () => {
  // 可手动推送/关闭的 SSE 响应流
  function makeSseResponse() {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        cancelled = true
      },
    })
    const encoder = new TextEncoder()
    const response = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    return {
      response,
      push(data: string) {
        // 模拟真实网络：对端已取消后，迟到的数据不会（也不能）再入队
        if (cancelled) return
        controller.enqueue(encoder.encode(data))
      },
      close() {
        if (cancelled) return
        controller.close()
      },
    }
  }

  function mockFetchStream(response: Response) {
    globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch
  }

  // 让流读取循环有机会处理已推送的 chunk
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('resolves only after the reader finishes, emitting the terminal done event', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    const sse = makeSseResponse()
    mockFetchStream(sse.response)

    const events: string[] = []
    let settled = false
    const p = client.stream('/chat/stream', { messages: [] }, (e) => events.push(e.type))
    void p.then(() => {
      settled = true
    })

    sse.push('data: {"type":"token","content":"he"}\n\n')
    await flush()
    // 流未结束：promise 不应提前 resolve（调用方靠它判断 streaming 终态）
    expect(events).toEqual(['token'])
    expect(settled).toBe(false)

    sse.push('data: {"type":"done"}\n\n')
    sse.close()
    await p
    expect(settled).toBe(true)
    expect(events[events.length - 1]).toBe('done')
  })

  it('stops emitting events and rejects with AbortError when aborted mid-stream', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    const sse = makeSseResponse()
    mockFetchStream(sse.response)

    const events: string[] = []
    const external = new AbortController()
    const p = client.stream('/chat/stream', { messages: [] }, (e) => events.push(e.type), {
      signal: external.signal,
    })
    // 避免未处理的 rejection 告警；断言在下方进行
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' })

    sse.push('data: {"type":"token","content":"a"}\n\n')
    await flush()
    expect(events).toEqual(['token'])

    external.abort()
    await flush()
    // abort 之后到达的数据不得再派发给调用方
    sse.push('data: {"type":"token","content":"b"}\n\n')
    sse.push('data: {"type":"done"}\n\n')
    sse.close()
    await flush()

    await assertion
    expect(events).toEqual(['token'])
    expect(events).not.toContain('done')
  })

  it('rejects when the underlying stream errors mid-way instead of swallowing it', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    const response = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch

    const events: string[] = []
    const p = client.stream('/chat/stream', { messages: [] }, (e) => events.push(e.type))
    controller.enqueue(new TextEncoder().encode('data: {"type":"token","content":"a"}\n\n'))
    await new Promise((r) => setTimeout(r, 0))
    controller.error(new Error('connection reset'))
    await expect(p).rejects.toThrow('connection reset')
    expect(events).toEqual(['token'])
  })
})

describe('APIClient interceptors', () => {
  it('runs request interceptors in order and lets them mutate config', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    client.requestInterceptor((c) => ({ ...c, headers: { ...c.headers, 'X-A': '1' } }))
    client.requestInterceptor((c) => ({ ...c, headers: { ...c.headers, 'X-B': '2' } }))
    mockFetchOnce({ status: 200, body: {} })
    await client.get('/x')
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.headers['X-A']).toBe('1')
    expect(init.headers['X-B']).toBe('2')
  })

  it('runs response interceptors and uses the returned data', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    client.responseInterceptor((data) => ({ wrapped: data }))
    mockFetchOnce({ status: 200, body: { ok: true } })
    const data = await client.get('/x')
    expect(data).toEqual({ wrapped: { ok: true } })
  })
})

describe('APIClient 401 unauthorized handling', () => {
  it('invokes the unauthorized handler on 401 and still throws HttpError', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    const spy = vi.fn()
    client.onUnauthorized(spy)
    mockFetchOnce({ status: 401, body: { message: 'unauthorized' } })
    await expect(client.get('/x')).rejects.toMatchObject({ status: 401 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not invoke the unauthorized handler on other error statuses', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    const spy = vi.fn()
    client.onUnauthorized(spy)
    mockFetchOnce({ status: 403, body: {} })
    await expect(client.get('/x')).rejects.toMatchObject({ status: 403 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('invokes the unauthorized handler when stream() gets a 401', async () => {
    const client = new APIClient({ baseURL: 'http://api' })
    const spy = vi.fn()
    client.onUnauthorized(spy)
    mockFetchOnce({ status: 401, body: {} })
    await expect(client.stream('/chat/stream', { messages: [] }, () => {})).rejects.toMatchObject({
      status: 401,
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('default api wiring clears the stored token on 401', async () => {
    localStorage.setItem('token', 'secret-token')
    mockFetchOnce({ status: 401, body: {} })
    await expect(api.get('/x')).rejects.toMatchObject({ status: 401 })
    expect(localStorage.getItem('token')).toBeNull()
  })
})
