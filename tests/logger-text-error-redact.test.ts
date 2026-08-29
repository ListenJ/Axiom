/**
 * Logger 文本路径 error 堆栈/消息脱敏测试（B3-Medium，docs/reviews/2026-08-29-joint-verification-audit.md §4）
 *
 * 审计症状：logger.ts:201 文本路径 errStr = entry.error.stack 直接拼进 console 行，
 * 未过 SECRET_VALUE_RE —— 而 JSON 路径（serialize）已对 message/stack 脱敏。
 * 修复要求：文本路径与 JSON 路径一致，套用 SECRET_VALUE_RE。
 */
import { describe, it, expect } from "bun:test";
import { Logger } from "../src/utils/logger.js";

function captureConsole(method: "error" | "log" | "warn"): { captured: () => string; done: () => void } {
  const orig = console[method];
  let text = "";
  console[method] = (msg?: unknown) => {
    text += String(msg);
  };
  return { captured: () => text, done: () => { console[method] = orig; } };
}

function makeTextLogger(): Logger {
  return new Logger({
    minLevel: "debug",
    outputs: [{ type: "console" }],
    format: "text",
    enableColors: false,
  });
}

describe("Logger text 路径 error 脱敏（B3-Medium）", () => {
  it("error.stack 中的 sk- 密钥在文本输出中被脱敏（JSON 路径行为对齐）", () => {
    const cap = captureConsole("error");
    try {
      const l = makeTextLogger();
      const err = new Error("Auth failed");
      err.stack = "Error: Auth failed\n    at Client.request (sk-abcd1234efgh5678)";
      l.error("auth-failed", err);
    } finally {
      cap.done();
    }
    expect(cap.captured()).toContain("[REDACTED]");
    expect(cap.captured()).not.toContain("sk-abcd1234efgh5678");
  });

  it("stack 缺失时回退 message 同样脱敏", () => {
    const cap = captureConsole("error");
    try {
      const l = makeTextLogger();
      const err = new Error("Auth failed for sk-abcd1234efgh5678");
      err.stack = undefined;
      l.error("no-stack", err);
    } finally {
      cap.done();
    }
    expect(cap.captured()).not.toContain("sk-abcd1234efgh5678");
    expect(cap.captured()).toContain("[REDACTED]");
  });

  it("无密钥的正常堆栈原样保留（行为保持）", () => {
    const cap = captureConsole("error");
    try {
      const l = makeTextLogger();
      const err = new Error("plain failure");
      l.error("plain", err);
    } finally {
      cap.done();
    }
    const text = cap.captured();
    expect(text).toContain("plain failure");
    expect(text).not.toContain("[REDACTED]");
  });
});
