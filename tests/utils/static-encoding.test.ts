import { test, expect, describe } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeGzip } from "../../src/utils/static-encoding.ts";

/**
 * 回归测试：静态资源 gzip 编码（T2.1 暴露的生产 bug）
 *
 * 症状（事实）：旧实现 `gzipSync(...).buffer` 返回 Node Buffer 内存池的整个
 * ArrayBuffer —— 压缩流仅 N 字节，但 buffer.byteLength 为池大小（如 16384），
 * 尾部 ~14KB 是池内存垃圾。经 `new Response(arrayBuffer)` 发送时
 * Content-Length 虚报为池大小，libcurl 系客户端（curl --compressed /
 * Playwright webkit-on-Windows）解析失败：CURLE_WRITE_ERROR（exit 23）。
 *
 * 断言锁定"无垃圾尾"：返回的 ArrayBuffer 长度必须恰好等于 gzip 流长度。
 */
describe("encodeGzip", () => {
  const sample = (n: number) => "x".repeat(n); // 高压缩比，压缩后远小于原长

  test("返回长度恰好等于 gzip 流长度（无内存池垃圾尾）", () => {
    const raw = Buffer.from(sample(5000));
    const out = encodeGzip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const expectedLen = gzipSync(Buffer.from(raw)).byteLength;
    // 核心回归断言：旧实现在此会得到 16384（池大小）而非真实流长度
    expect(out.byteLength).toBe(expectedLen);
  });

  test("多输入各自独立精确（无共享池污染）", () => {
    const mk = (n: number) => Buffer.from(sample(n));
    const a = encodeGzip(mk(3000).buffer.slice(0, 3000));
    const b = encodeGzip(mk(9000).buffer.slice(0, 9000));
    expect(a.byteLength).toBe(gzipSync(mk(3000)).byteLength);
    expect(b.byteLength).toBe(gzipSync(mk(9000)).byteLength);
    // 两次结果互不干扰（旧实现共享池时后者可能覆盖前者内存）
    expect(gunzipSync(Buffer.from(a)).length).toBe(3000);
    expect(gunzipSync(Buffer.from(b)).length).toBe(9000);
  });

  test("gunzip 可还原原文", () => {
    const text = "hello axiom 静态资源 gzip 回归测试";
    const raw = Buffer.from(text, "utf-8");
    const out = encodeGzip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const back = gunzipSync(Buffer.from(out)).toString("utf-8");
    expect(back).toBe(text);
  });

  test("小输入（低于常规 gzip 阈值）也返回精确长度", () => {
    const raw = Buffer.from("tiny");
    const out = encodeGzip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    expect(out.byteLength).toBe(gzipSync(raw).byteLength);
  });
});
