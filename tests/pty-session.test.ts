/**
 * PTY 会话管理测试（真实子进程交互 shell）
 *
 * 验证：创建会话可写可读（echo 往返）、多订阅者、关闭清理、closeAll 幂等。
 * 跨平台：Windows 用 cmd.exe，其余用 /bin/bash。
 */
import { describe, expect, it, afterAll } from "bun:test";
import {
  createPtySession,
  getSession,
  listSessions,
  closeAllSessions,
  type PtySession,
} from "../src/terminal/pty-session.js";

const IS_WIN = process.platform === "win32";

function shellEcho(text: string): string {
  return IS_WIN ? `echo ${text}\r\n` : `echo ${text}\n`;
}

async function waitForOutput(session: PtySession, needle: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${needle}"`)), timeoutMs);
    const unsub = session.subscribe((chunk) => {
      if (chunk.includes(needle)) {
        clearTimeout(timer);
        unsub();
        resolve(chunk);
      }
    });
  });
}

describe("PTY session (交互 shell)", () => {
  afterAll(async () => {
    await closeAllSessions();
  });

  it("创建会话并注册到管理器", () => {
    const s = createPtySession();
    expect(s.id).toBeTruthy();
    expect(getSession(s.id)).toBe(s);
    expect(listSessions()).toContain(s.id);
    s.close();
    expect(getSession(s.id)).toBeUndefined();
  });

  it("写入命令能收到回显输出（真实子进程往返）", async () => {
    const s = createPtySession();
    try {
      const p = waitForOutput(s, "pty-echo-42");
      s.write(shellEcho("pty-echo-42"));
      const out = await p;
      expect(out).toContain("pty-echo-42");
    } finally {
      s.close();
    }
  });

  it("多订阅者都能收到输出", async () => {
    const s = createPtySession();
    try {
      const a = waitForOutput(s, "pty-multi");
      const b = waitForOutput(s, "pty-multi");
      s.write(shellEcho("pty-multi"));
      const [outA, outB] = await Promise.all([a, b]);
      expect(outA).toContain("pty-multi");
      expect(outB).toContain("pty-multi");
    } finally {
      s.close();
    }
  });

  it("会话数量达到上限后拒绝创建", async () => {
    const created: PtySession[] = [];
    try {
      for (let i = 0; i < 16; i++) created.push(createPtySession());
      expect(() => createPtySession()).toThrow(/上限/);
    } finally {
      for (const s of created) s.close();
    }
  });

  it("close 后写入不再报错（幂等清理）", () => {
    const s = createPtySession();
    s.close();
    s.close();
    expect(() => s.write("x")).not.toThrow();
  });

  it("closeAllSessions 幂等且清空全部", async () => {
    const a = createPtySession();
    const b = createPtySession();
    expect(listSessions().length).toBeGreaterThanOrEqual(2);
    const n = await closeAllSessions();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(listSessions().length).toBe(0);
    expect(await closeAllSessions()).toBe(0);
  });
});
