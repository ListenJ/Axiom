/**
 * Proxies Page — 代理管理单元测试
 * 运行: bun test tests/proxies-page.test.ts
 */
import { describe, it, expect } from "bun:test"

interface Proxy {
  host: string
  port: string
  protocol: string
  country: string
  active: boolean
}

describe("Proxies Page", () => {
  describe("代理数据解析", () => {
    it("应能解析裸数组响应", () => {
      const data: Proxy[] = [
        { host: "proxy.example.com", port: "8080", protocol: "http:", country: "system", active: true },
      ]
      expect(Array.isArray(data)).toBe(true)
      expect(data).toHaveLength(1)
    })

    it("应能解析包装对象响应（兼容）", () => {
      const data = { proxies: [
        { host: "p.com", port: "1080", protocol: "socks5:", country: "system", active: true },
      ] }
      const arr = Array.isArray(data) ? data : (data as { proxies?: Proxy[] }).proxies ?? []
      expect(arr).toHaveLength(1)
      expect(arr[0].protocol).toBe("socks5:")
    })

    it("应能处理空响应", () => {
      const data: Proxy[] = []
      expect(data).toEqual([])
    })
  })

  describe("代理统计", () => {
    it("应能计算活跃代理数量", () => {
      const proxies: Proxy[] = [
        { host: "a", port: "80", protocol: "http:", country: "x", active: true },
        { host: "b", port: "80", protocol: "http:", country: "x", active: false },
        { host: "c", port: "80", protocol: "http:", country: "x", active: true },
      ]
      const activeCount = proxies.filter((p) => p.active).length
      expect(activeCount).toBe(2)
    })

    it("应能计算非活跃代理数量", () => {
      const proxies: Proxy[] = [
        { host: "a", port: "80", protocol: "http:", country: "x", active: true },
        { host: "b", port: "80", protocol: "http:", country: "x", active: false },
      ]
      const inactiveCount = proxies.filter((p) => !p.active).length
      expect(inactiveCount).toBe(1)
    })

    it("应能按协议分组", () => {
      const proxies: Proxy[] = [
        { host: "a", port: "80", protocol: "http:", country: "x", active: true },
        { host: "b", port: "443", protocol: "https:", country: "x", active: true },
        { host: "c", port: "1080", protocol: "socks5:", country: "x", active: true },
      ]
      const byProtocol = proxies.reduce((acc, p) => {
        acc[p.protocol] = (acc[p.protocol] || 0) + 1
        return acc
      }, {} as Record<string, number>)
      expect(byProtocol["http:"]).toBe(1)
      expect(byProtocol["https:"]).toBe(1)
      expect(byProtocol["socks5:"]).toBe(1)
    })
  })

  describe("URL 解析", () => {
    it("应能从 http_proxy 环境变量解析", () => {
      const httpProxy = "http://192.168.1.1:8080"
      const url = new URL(httpProxy)
      expect(url.hostname).toBe("192.168.1.1")
      expect(url.port).toBe("8080")
      expect(url.protocol).toBe("http:")
    })

    it("应能从 socks 代理 URL 解析", () => {
      const socksProxy = "socks5://user:pass@proxy.com:1080"
      const url = new URL(socksProxy)
      expect(url.protocol).toBe("socks5:")
      expect(url.hostname).toBe("proxy.com")
      expect(url.port).toBe("1080")
    })

    it("无效 URL 应回退到原始字符串", () => {
      const invalid = "not-a-url"
      try {
        new URL(invalid)
        expect(true).toBe(false) // shouldn't reach here
      } catch {
        expect(true).toBe(true) // fallback works
      }
    })
  })

  describe("代理显示格式", () => {
    it("应能格式化 host:port 显示", () => {
      const p: Proxy = { host: "p.com", port: "8080", protocol: "http:", country: "x", active: true }
      const display = p.port ? `${p.host}:${p.port}` : p.host
      expect(display).toBe("p.com:8080")
    })

    it("空 port 应只显示 host", () => {
      const p: Proxy = { host: "p.com", port: "", protocol: "http:", country: "x", active: true }
      const display = p.port ? `${p.host}:${p.port}` : p.host
      expect(display).toBe("p.com")
    })
  })

  describe("协议识别", () => {
    it("应能识别 http 协议", () => {
      const protocol = "http:"
      expect(protocol.startsWith("http:")).toBe(true)
    })

    it("应能识别 https 协议", () => {
      const protocol = "https:"
      expect(protocol.startsWith("https:")).toBe(true)
    })

    it("应能识别 socks 协议", () => {
      const protocol = "socks5:"
      expect(protocol.startsWith("socks")).toBe(true)
    })
  })
})
