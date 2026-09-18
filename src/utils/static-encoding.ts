import { gzipSync } from "node:zlib";

/**
 * 静态资源 gzip 编码（T2.1 修复的生产 bug 的回归接缝）
 *
 * 背景：旧实现 `gzipSync(...).buffer` 返回 Node Buffer 内存池的整个 ArrayBuffer，
 * 压缩流仅 N 字节但 buffer.byteLength 为池大小（16384），尾部池垃圾随响应发出，
 * Content-Length 虚报 → libcurl 系客户端（curl --compressed、Playwright webkit）
 * 解析失败 CURLE_WRITE_ERROR。
 *
 * 本函数契约：返回的 ArrayBuffer 长度恰好等于 gzip 流长度（独立 buffer，无共享池尾）。
 */
export function encodeGzip(input: ArrayBuffer): ArrayBuffer {
  const gz = gzipSync(Buffer.from(input));
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer;
}
