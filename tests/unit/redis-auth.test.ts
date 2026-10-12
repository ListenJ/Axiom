/**
 * Redis 认证回归（2026-10-07）
 *
 * 动因（实测）：生产 Redis 带 requirepass，接入 `REDIS_URL=redis://:口令@127.0.0.1:6379/0` 后
 * 客户端**能连上 TCP 却从不发送 AUTH** —— 于是每条命令都收到 `-NOAUTH`，而 `RedisClient.connect()`
 * 只在建连阶段判成败，返回了一个"看似成功"的客户端。缓存层因此从"用 Redis"静默退化成"每条命令报错"，
 * 而不是干净的降级。
 *
 * 本门用**本地假 Redis 服务器**（Bun.listen，强制口令）验证三条语义：
 *   1. 口令正确 ⇒ 连接可用且命令成功；
 *   2. 口令错误 ⇒ `connect()` 返回 null（安全降级，不返回半死客户端）；
 *   3. 无口令实例 ⇒ 不受影响（不因修复而破坏明文场景）。
 */
import { describe, it, expect } from "bun:test";
import { RedisClient } from "../../src/utils/redis-client.js";

/** 从 RESP 字节流里解析出一条命令（返回剩余缓冲） */
function parseRespCommand(buf: string): { args: string[]; rest: string } | null {
  if (!buf.startsWith("*")) return null;
  const header = buf.indexOf("\r\n");
  if (header === -1) return null;
  const n = Number(buf.slice(1, header));
  let pos = header + 2;
  const args: string[] = [];
  for (let i = 0; i < n; i++) {
    if (buf[pos] !== "$") return null;
    const end = buf.indexOf("\r\n", pos);
    if (end === -1) return null;
    const len = Number(buf.slice(pos + 1, end));
    const start = end + 2;
    if (buf.length < start + len + 2) return null;
    args.push(buf.slice(start, start + len));
    pos = start + len + 2;
  }
  return { args, rest: buf.slice(pos) };
}

/** 极简假 Redis：支持 AUTH / SET / SETEX / GET / DEL / PING */
function startFakeRedis(requiredPassword?: string) {
  const store = new Map<string, string>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const s = socket as unknown as { __buf?: string; __authed?: boolean };
        s.__buf = (s.__buf ?? "") + new TextDecoder().decode(data);
        if (requiredPassword === undefined) s.__authed = true;

        for (;;) {
          const parsed = parseRespCommand(s.__buf);
          if (!parsed) break;
          s.__buf = parsed.rest;
          const [cmdRaw, ...args] = parsed.args;
          const cmd = cmdRaw.toUpperCase();

          if (cmd === "AUTH") {
            if (args[0] === requiredPassword) {
              s.__authed = true;
              socket.write("+OK\r\n");
            } else {
              socket.write("-WRONGPASS invalid username-password pair\r\n");
            }
            continue;
          }
          if (!s.__authed) {
            socket.write("-NOAUTH Authentication required.\r\n");
            continue;
          }
          switch (cmd) {
            case "SET":
              store.set(args[0], args[1]);
              socket.write("+OK\r\n");
              break;
            case "SETEX":
              store.set(args[0], args[2]);
              socket.write("+OK\r\n");
              break;
            case "GET": {
              const v = store.get(args[0]);
              socket.write(v === undefined ? "$-1\r\n" : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
              break;
            }
            case "DEL":
              socket.write(`:${store.delete(args[0]) ? 1 : 0}\r\n`);
              break;
            case "PING":
              socket.write("+PONG\r\n");
              break;
            default:
              socket.write(`-ERR unknown command '${cmd}'\r\n`);
          }
        }
      },
    },
  });
  return { server, store, stop: () => server.stop(true) };
}

describe("Redis 认证", () => {
  it("口令正确 ⇒ 连接可用且命令成功", async () => {
    const fake = startFakeRedis("s3cret-pass");
    let client: Awaited<ReturnType<typeof RedisClient.connect>> = null;
    try {
      client = await RedisClient.connect(`redis://:s3cret-pass@127.0.0.1:${fake.server.port}/0`);
      expect(client, "带正确口令应连接成功").not.toBeNull();
      await client!.set("k1", "v1");
      expect(await client!.get("k1")).toBe("v1");
    } finally {
      client?.disconnect();
      fake.stop(); // 轮 7 审计：断言失败也必须回收 socket（原实现泄漏到进程结束）
    }
  });

  it("口令错误 ⇒ connect() 返回 null（干净降级，不返回半死客户端）", async () => {
    const fake = startFakeRedis("right-pass");
    try {
      const client = await RedisClient.connect(`redis://:wrong-pass@127.0.0.1:${fake.server.port}/0`);
      expect(client, "口令错误应判定为连接失败").toBeNull();
    } finally {
      fake.stop(); // 轮 7 审计：失败路径同样回收 fake server
    }
  });

  it("无口令实例 ⇒ 不受影响", async () => {
    const fake = startFakeRedis(undefined);
    let client: Awaited<ReturnType<typeof RedisClient.connect>> = null;
    try {
      client = await RedisClient.connect(`redis://127.0.0.1:${fake.server.port}/0`);
      expect(client).not.toBeNull();
      await client!.set("k2", "v2");
      expect(await client!.get("k2")).toBe("v2");
    } finally {
      client?.disconnect();
      fake.stop();
    }
  });
});
