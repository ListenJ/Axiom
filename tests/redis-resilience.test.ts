/**
 * Redis 客户端韧性测试（B3-Medium，docs/reviews/2026-08-29-joint-verification-audit.md §4）
 *
 * 覆盖（经伪造 Bun.connect socket 驱动真实协议/单例路径，零真实网络）：
 *   1. 断线后 getRedisClient 复位单例状态 → 下次调用取到新实例（重连）
 *      （修复前：redisPromise 永不复位 → 永远返回已断线的死实例）
 *   2. 断线时在途命令以明确错误拒绝（修复前：永久挂起）
 *   3. RESP 数组跨包半包：缓冲等待续读，不串包
 *      （修复前：数组头已消费，后续包把元素内部字节当作顶层响应 → 错位解析）
 */
import { describe, it, expect, afterEach } from "bun:test";

interface FakeBunSocket {
  written: string[];
  write(data: string): boolean;
  end(): void;
}

const origBunConnect = Bun.connect;
let sockHandlers: { data?: (s: unknown, d: Uint8Array) => void; open?: (s: unknown) => void; close?: (s: unknown) => void; error?: (s: unknown, e: Error) => void } | null = null;
let fakeSocket: FakeBunSocket | null = null;

function installFakeRedisConnect(): void {
  (Bun as unknown as { connect: unknown }).connect = (opts: {
    socket: typeof sockHandlers;
  }) => {
    sockHandlers = opts.socket;
    fakeSocket = {
      written: [],
      write(d: string) {
        this.written.push(d);
        return true;
      },
      end() {},
    };
    queueMicrotask(() => sockHandlers!.open!(fakeSocket));
    return Promise.resolve(fakeSocket);
  };
}

const TEST_URL = "redis://127.0.0.1:6399";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 限期等待拒绝：promise 在 deadline 内未 settle 即判红。
 * Bun 的 --timeout 不会中断 await 永不 settle 的 promise（实测 1.3.14 挂死整个进程），
 * 因此对"修复前会永久挂起"的行为必须用 deadline 竞速而非依赖测试超时。
 */
function expectRejectWithin(p: Promise<unknown>, messageRe: RegExp, deadlineMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`promise neither resolved nor rejected within ${deadlineMs}ms (hung)`)),
      deadlineMs,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        reject(new Error(`promise resolved instead of rejecting with ${messageRe}: ${JSON.stringify(v)}`));
      },
      (e: unknown) => {
        clearTimeout(timer);
        const msg = e instanceof Error ? e.message : String(e);
        if (messageRe.test(msg)) resolve();
        else reject(new Error(`rejected with unexpected error: ${msg}`));
      },
    );
  });
}

afterEach(async () => {
  Bun.connect = origBunConnect;
  sockHandlers = null;
  fakeSocket = null;
  const mod = await import("../src/utils/redis-client.js");
  mod.disconnectRedis();
  delete process.env.REDIS_URL;
});

describe("Redis 断线复位（B3-Medium）", () => {
  it("1 断线后 getRedisClient 复位并重连（取到新实例）", async () => {
    process.env.REDIS_URL = TEST_URL;
    const mod = await import("../src/utils/redis-client.js");
    mod.disconnectRedis();
    installFakeRedisConnect();
    const c1 = await mod.getRedisClient();
    expect(c1).not.toBeNull();
    // 模拟意外断线（服务端关闭/网络中断）
    sockHandlers!.close!(fakeSocket);
    expect(c1!.isConnected()).toBe(false);
    // 下一次取客户端必须是新连接，而不是已死的旧实例
    installFakeRedisConnect();
    const c2 = await mod.getRedisClient();
    expect(c2).not.toBeNull();
    expect(c2).not.toBe(c1);
  });

  it("2 断线时在途命令以明确错误拒绝（而非永久挂起）", async () => {
    process.env.REDIS_URL = TEST_URL;
    const mod = await import("../src/utils/redis-client.js");
    mod.disconnectRedis();
    installFakeRedisConnect();
    const c = await mod.getRedisClient();
    const p = c!.get("some-key");
    sockHandlers!.close!(fakeSocket);
    await expectRejectWithin(p, /connection lost/i);
  });
});

describe("RESP 数组跨包半包续读（B3-Medium）", () => {
  it("3 数组半包等待续读，不把元素内部字节当顶层响应（MGET 场景）", async () => {
    const mod = await import("../src/utils/redis-client.js");
    mod.disconnectRedis();
    installFakeRedisConnect();
    const client = await mod.RedisClient.connect(TEST_URL);
    expect(client).not.toBeNull();
    const p = client!.mget(["a", "b"]); // RESP: *4 ...（两 key），期望回复数组 ["va","vb"]
    await sleep(10);
    // 包 1：数组头 + 首个 bulk 字符串的一半（不完整）
    sockHandlers!.data!(fakeSocket, new TextEncoder().encode("*2\r\n$2\r\nva"));
    await sleep(10);
    let settled = false;
    p.then(() => {
      settled = true;
    });
    await sleep(10);
    expect(settled).toBe(false); // 半包不得提前结算
    // 包 2：剩余数据补齐
    sockHandlers!.data!(fakeSocket, new TextEncoder().encode("\r\n$2\r\nvb\r\n"));
    expect(await p).toEqual(["va", "vb"]); // 修复前：串包错位 → 解析出 "va"（string）→ mget 返回 [null, null]
  });
});
