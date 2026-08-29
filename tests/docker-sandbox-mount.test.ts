/**
 * Task 4 / 审计 B3（2026-08-29）：docker-sandbox 挂载与资源防线
 *
 * 证据：src/sandbox/docker-sandbox.ts
 *   - :57-58 mountDir = opts.cwd || "/tmp" 无校验即 -v ${mountDir}:/workspace:ro
 *   - :44-46 networkAccess === false 才禁网（未传参即放网，fail-open）
 *   - :81 stdout/stderr 无上限读取（对比 process-sandbox 1MB 截断）
 *
 * 修复契约：
 *   - 挂载白名单：绝对根（/、C:\）+ 宿主系统目录 + isPathSafe（cwd 逃逸与
 *     .git/.env/运行时数据库敏感段）；默认 "/tmp" 为内置只读工作区（非用户输入），
 *     仅过根/系统目录规则；显式 opts.cwd（客户端可控）全量校验
 *   - networkAccess 默认禁网（fail-closed，opt-in 开启）；唯一生产调用方
 *     routes/sandbox.ts:63 默认传 false，无调用方依赖 undefined→放网
 *   - stdout/stderr 1MB 截断（复用 process-sandbox readStreamWithLimit）
 *
 * 行为测试经 spyOn(Bun, "spawn") 拦截（docker 可用性无关），静态断言锁源码。
 */
import { describe, it, expect, spyOn, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { dockerSandbox } from "../src/sandbox/docker-sandbox.js";

const LEGAL_DIR = ".tmp-t4-mount/ok";

function fakeProc(stdout = "", stderr = "") {
  return {
    stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
    stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(0),
    kill: () => {},
  };
}

function spySpawn() {
  return spyOn(Bun, "spawn").mockImplementation((() => fakeProc()) as unknown as typeof Bun.spawn);
}

beforeAll(() => {
  mkdirSync(LEGAL_DIR, { recursive: true });
});
afterAll(() => {
  rmSync(".tmp-t4-mount", { recursive: true, force: true });
});

describe("[T4-③] docker-sandbox 挂载白名单", () => {
  it("挂载文件系统根 / 被拒且不触发 docker spawn", async () => {
    const spy = spySpawn();
    try {
      const res = await dockerSandbox.execute({ command: "echo hi", cwd: "/" });
      expect(res.error).toMatch(/mount dir rejected/i);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("挂载 ../ 逃逸 cwd 被拒", async () => {
    const res = await dockerSandbox.execute({ command: "echo hi", cwd: "../outside-probe" });
    expect(res.error).toMatch(/mount dir rejected/i);
  });

  it("挂载仓库 .git 被拒（isPathSafe 敏感段）", async () => {
    const res = await dockerSandbox.execute({
      command: "echo hi",
      cwd: path.join(process.cwd(), ".git"),
    });
    expect(res.error).toMatch(/mount dir rejected/i);
  });

  it("挂载仓库 .env 被拒（isPathSafe 敏感段）", async () => {
    const res = await dockerSandbox.execute({
      command: "echo hi",
      cwd: path.join(process.cwd(), ".env"),
    });
    expect(res.error).toMatch(/mount dir rejected/i);
  });

  it.skipIf(process.platform !== "win32")("挂载 Windows 盘符根 C:\\ 被拒", async () => {
    const res = await dockerSandbox.execute({ command: "echo hi", cwd: "C:\\" });
    expect(res.error).toMatch(/mount dir rejected/i);
  });

  it.skipIf(process.platform !== "win32")("挂载宿主系统目录 C:\\Windows 被拒", async () => {
    const res = await dockerSandbox.execute({ command: "echo hi", cwd: "C:\\Windows" });
    expect(res.error).toMatch(/mount dir rejected/i);
  });

  it("红线：cwd 内合法目录挂载不受影响（spawn 收到 -v）", async () => {
    const spy = spySpawn();
    try {
      const res = await dockerSandbox.execute({ command: "echo hi", cwd: LEGAL_DIR });
      expect(res.error).toBeUndefined();
      expect(spy.mock.calls.length).toBe(1);
      const args = spy.mock.calls[0][0] as unknown as string[];
      const vIdx = args.indexOf("-v");
      expect(vIdx).toBeGreaterThan(-1);
      expect(args[vIdx + 1]).toContain(path.resolve(LEGAL_DIR));
    } finally {
      spy.mockRestore();
    }
  });

  it("红线：缺省 cwd（内置 /tmp 工作区）不误伤", async () => {
    const spy = spySpawn();
    try {
      const res = await dockerSandbox.execute({ command: "echo hi" });
      expect(res.error).toBeUndefined();
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("[T4-③] docker-sandbox 网络默认禁用（opt-in）", () => {
  it("未传 networkAccess → docker args 含 --network none（fail-closed）", async () => {
    const spy = spySpawn();
    try {
      await dockerSandbox.execute({ command: "echo hi", cwd: LEGAL_DIR });
      const args = spy.mock.calls[0][0] as unknown as string[];
      const nIdx = args.indexOf("--network");
      expect(nIdx).toBeGreaterThan(-1);
      expect(args[nIdx + 1]).toBe("none");
    } finally {
      spy.mockRestore();
    }
  });

  it("networkAccess: true → 显式 opt-in 放网（无 --network none）", async () => {
    const spy = spySpawn();
    try {
      await dockerSandbox.execute({ command: "echo hi", cwd: LEGAL_DIR, networkAccess: true });
      const args = spy.mock.calls[0][0] as unknown as string[];
      expect(args).not.toContain("none");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("[T4-③] docker-sandbox 输出截断（对齐 process-sandbox 1MB）", () => {
  it("stdout 超 1MB 被截断并带标记", async () => {
    const spy = spyOn(Bun, "spawn").mockImplementation(
      (() => fakeProc("a".repeat(1_200_000))) as unknown as typeof Bun.spawn,
    );
    try {
      const res = await dockerSandbox.execute({ command: "echo hi", cwd: LEGAL_DIR });
      expect(res.error).toBeUndefined();
      expect(res.stdout.endsWith("[stdout truncated at 1MB]")).toBe(true);
      expect(res.stdout.length).toBeLessThan(1_010_000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("[T4-③] docker-sandbox 静态断言", () => {
  const src = readFileSync(path.join(import.meta.dir, "../src/sandbox/docker-sandbox.ts"), "utf-8");

  it("挂载白名单校验存在（isPathSafe + 绝对根拒绝）", () => {
    expect(src).toMatch(/isPathSafe/);
    expect(src).toMatch(/mount dir rejected/i);
  });

  it("1MB 截断常量与流式读取接线存在", () => {
    expect(src).toMatch(/MAX_OUTPUT_BYTES/);
    expect(src).toMatch(/readStreamWithLimit/);
  });

  it("networkAccess 默认禁网语义（!== true）", () => {
    expect(src).toMatch(/networkAccess !== true/);
  });
});
