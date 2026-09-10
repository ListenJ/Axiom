/**
 * proxy-fetch 审计强化测试（B3-Medium，docs/reviews/2026-08-29-joint-verification-audit.md §4）
 *
 * 覆盖（全部经伪造 net/tls 流驱动真实代码路径，零真实网络）：
 *   1. CONNECT 隧道 Buffer body 的 Content-Length 用 Buffer.byteLength
 *      （修复前错用 JSON.stringify(Buffer).length，与实际写出的原始 Buffer 不符）
 *   2. 手工拼包头值剥离 CR/LF（防头注入）
 *   3. 重定向跨域剥离 Authorization/Cookie（同域保留）
 *   4. 响应体上限默认 10MB（PROXY_FETCH_MAX_BODY_BYTES 可覆盖），超限中止并报错含 "too large"
 *
 * 注：Bun 的 mock.module 对 node 内建模块的替换会泄漏到同进程后续测试文件
 * （bun test 单进程共享模块注册表），故此处直接替换 node:net / node:tls 默认导出
 * 对象的属性，并在 afterEach 恢复原实现 —— 对其他测试文件零影响。
 */
import { describe, it, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import netReal from "node:net";
import tlsReal from "node:tls";
import { proxyFetch } from "../src/utils/proxy-fetch.js";

// ---- 伪造 socket 基建 ----

class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;
  write(d: unknown): boolean {
    this.written.push(Buffer.isBuffer(d) ? d : Buffer.from(d as string));
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  get text(): string {
    return Buffer.concat(this.written).toString("utf-8");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 构造完整 HTTP 响应字节（状态行 + 头 + body） */
function httpResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: Buffer | string = "",
): Buffer {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return Buffer.concat([
    Buffer.from(`HTTP/1.1 ${status} ${statusText}\r\n${head.join("\r\n")}\r\n\r\n`),
    Buffer.isBuffer(body) ? body : Buffer.from(body),
  ]);
}

const origNetCreateConnection = netReal.createConnection;
const origTlsConnect = tlsReal.connect;
const tlsFakes: FakeSocket[] = [];

/** 安装伪造隧道：net.createConnection 自动应答 CONNECT 200；tls.connect 返回可注入响应的假 TLS socket */
function installTunnelFakes(): void {
  netReal.createConnection = (() => {
    const s = new FakeSocket();
    queueMicrotask(() => s.emit("connect"));
    s.write = (d: unknown) => {
      s.written.push(Buffer.isBuffer(d) ? d : Buffer.from(d as string));
      const text = Buffer.isBuffer(d) ? d.toString() : String(d);
      if (text.startsWith("CONNECT")) {
        queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n")));
      }
      return true;
    };
    return s;
  }) as unknown as typeof netReal.createConnection;
  tlsReal.connect = (() => {
    const s = new FakeSocket();
    tlsFakes.push(s);
    queueMicrotask(() => s.emit("secureConnect"));
    return s;
  }) as unknown as typeof tlsReal.connect;
}

afterEach(() => {
  netReal.createConnection = origNetCreateConnection;
  tlsReal.connect = origTlsConnect;
  tlsFakes.length = 0;
  delete process.env.PROXY_FETCH_MAX_BODY_BYTES;
});

describe("proxy-fetch 审计强化（B3-Medium）", () => {
  it("1a CONNECT 隧道 Buffer body：Content-Length = Buffer.byteLength（修复前为 JSON.stringify 长度）", async () => {
    installTunnelFakes();
    const body = Buffer.from("中文数据", "utf-8"); // 12 字节；JSON.stringify(Buffer) 长度远大于此
    const p = proxyFetch("https://target.example/upload", {
      proxy: "http://proxy.internal:3128",
      method: "POST",
      body,
      timeout: 3000,
      followRedirects: false,
    });
    await sleep(30);
    expect(tlsFakes.length).toBe(1);
    const requestHeader = tlsFakes[0].text.split("\r\n\r\n")[0];
    expect(requestHeader).toContain(`Content-Length: ${body.byteLength}`); // 12
    expect(requestHeader).not.toContain('"type":"Buffer"');
    tlsFakes[0].emit("data", httpResponse(200, "OK", { "content-length": "2" }, "ok"));
    const res = await p;
    expect(res.status).toBe(200);
  });

  it("1a' 字符串 body 的 Content-Length 语义保持（byteLength）", async () => {
    installTunnelFakes();
    const body = "hello";
    const p = proxyFetch("https://target.example/post", {
      proxy: "http://proxy.internal:3128",
      method: "POST",
      body,
      timeout: 3000,
      followRedirects: false,
    });
    await sleep(30);
    const requestHeader = tlsFakes[0].text.split("\r\n\r\n")[0];
    expect(requestHeader).toContain("Content-Length: 5");
    tlsFakes[0].emit("data", httpResponse(200, "OK", { "content-length": "0" }));
    expect((await p).status).toBe(200);
  });

  it("1b 手工拼包头值剥离 CRLF（防头注入）", async () => {
    installTunnelFakes();
    const p = proxyFetch("https://target.example/x", {
      proxy: "http://proxy.internal:3128",
      headers: { "X-Evil": "value\r\nX-Injected: pwned" },
      timeout: 3000,
      followRedirects: false,
    });
    await sleep(30);
    const wire = tlsFakes[0].text;
    // 修复前：CRLF 原样写上线路 → "X-Evil: value\r\nX-Injected: pwned"（真实注入了一个伪造头）
    // 修复后：CRLF 折叠为空格，X-Injected 不再是独立头行
    expect(wire).not.toContain("value\r\nX-Injected");
    expect(wire).not.toMatch(/^X-Injected:/m);
    expect(wire).toContain("X-Evil: value X-Injected: pwned");
    tlsFakes[0].emit("data", httpResponse(200, "OK", { "content-length": "0" }));
    expect((await p).status).toBe(200);
  });

  it("1c 重定向跨域剥离 Authorization/Cookie", async () => {
    installTunnelFakes();
    const p = proxyFetch("https://a.example/one", {
      proxy: "http://proxy.internal:3128",
      headers: { Authorization: "Bearer secret-token", Cookie: "sid=abc" },
      timeout: 3000,
    });
    await sleep(30);
    // 第一跳：301 → https://b.example/two（跨域）
    tlsFakes[0].emit("data", httpResponse(301, "Moved", { location: "https://b.example/two", "content-length": "0" }));
    await sleep(30);
    expect(tlsFakes.length).toBe(2);
    const secondWire = tlsFakes[1].text;
    expect(secondWire).not.toContain("Bearer secret-token");
    expect(secondWire).not.toContain("sid=abc");
    expect(secondWire).toContain("Host: b.example");
    tlsFakes[1].emit("data", httpResponse(200, "OK", { "content-length": "2" }, "ok"));
    expect((await p).status).toBe(200);
  });

  it("1c' 同域重定向保留 Authorization（行为保持）", async () => {
    installTunnelFakes();
    const p = proxyFetch("https://a.example/one", {
      proxy: "http://proxy.internal:3128",
      headers: { Authorization: "Bearer keep-me" },
      timeout: 3000,
    });
    await sleep(30);
    tlsFakes[0].emit("data", httpResponse(301, "Moved", { location: "/two", "content-length": "0" }));
    await sleep(30);
    expect(tlsFakes.length).toBe(2);
    expect(tlsFakes[1].text).toContain("Bearer keep-me");
    tlsFakes[1].emit("data", httpResponse(200, "OK", { "content-length": "0" }));
    expect((await p).status).toBe(200);
  });

  it("2a 定长响应超默认 10MB 上限：中止并报错含 too large", async () => {
    installTunnelFakes();
    const p = proxyFetch("https://target.example/big", {
      proxy: "http://proxy.internal:3128",
      timeout: 3000,
      followRedirects: false,
    });
    await sleep(30);
    // 声明 20MB，先送达 11MB（超过默认 10MB 上限）
    tlsFakes[0].emit(
      "data",
      httpResponse(200, "OK", { "content-length": String(20 * 1024 * 1024) }, Buffer.alloc(11 * 1024 * 1024)),
    );
    await expect(p).rejects.toThrow(/too large/i);
    expect(tlsFakes[0].destroyed).toBe(true); // 超限即中止，不再继续接收
  });

  it("2b chunked 响应累计超上限：报错含 too large", async () => {
    installTunnelFakes();
    const p = proxyFetch("https://target.example/chunked", {
      proxy: "http://proxy.internal:3128",
      timeout: 3000,
      followRedirects: false,
    });
    await sleep(30);
    const sixMB = Buffer.alloc(6 * 1024 * 1024, 0x61);
    tlsFakes[0].emit(
      "data",
      Buffer.concat([
        Buffer.from("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n"),
        Buffer.from(`${(6 * 1024 * 1024).toString(16)}\r\n`),
        sixMB,
        Buffer.from("\r\n"),
      ]),
    );
    await sleep(10);
    tlsFakes[0].emit(
      "data",
      Buffer.concat([Buffer.from(`${(6 * 1024 * 1024).toString(16)}\r\n`), sixMB, Buffer.from("\r\n0\r\n\r\n")]),
    );
    await expect(p).rejects.toThrow(/too large/i);
  });

  it("2c PROXY_FETCH_MAX_BODY_BYTES 可覆盖上限", async () => {
    process.env.PROXY_FETCH_MAX_BODY_BYTES = String(1024 * 1024); // 1MB
    installTunnelFakes();
    const p = proxyFetch("https://target.example/medium", {
      proxy: "http://proxy.internal:3128",
      timeout: 3000,
      followRedirects: false,
    });
    await sleep(30);
    tlsFakes[0].emit(
      "data",
      httpResponse(200, "OK", { "content-length": String(2 * 1024 * 1024) }, Buffer.alloc(2 * 1024 * 1024)),
    );
    await expect(p).rejects.toThrow(/too large/i);
  });

  it("2d 上限内响应正常完成（行为保持）", async () => {
    installTunnelFakes();
    const p = proxyFetch("https://target.example/ok", {
      proxy: "http://proxy.internal:3128",
      timeout: 3000,
      followRedirects: false,
    });
    await sleep(30);
    tlsFakes[0].emit("data", httpResponse(200, "OK", { "content-length": "4" }, "body"));
    const res = await p;
    expect(await res.text()).toBe("body");
  });
});
