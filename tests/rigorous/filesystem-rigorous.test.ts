import { describe, test, expect, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFile, readFile, deleteFile, moveFile, listDirectory, fileExists } from "../../src/mcp/tools/filesystem.ts";

const TMP_ROOT = path.join(process.cwd(), ".tmp", "rigorous-fs");

beforeEach(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

describe("严苛：文件系统 沙箱与边界", () => {
  test("路径穿越：../ 应被拦截", async () => {
    const r = await writeFile("../outside.txt", "x");
    expect(r.success).toBe(false);
    expect(r.error!).toContain("outside");
  });

  test("跨盘穿越（Windows）：C:\\ 应被拦截", async () => {
    if (process.platform !== "win32") return;
    const r = await writeFile("C:\\Windows\\Temp\\rigorous.txt", "x");
    expect(r.success).toBe(false);
  });

  test("敏感区域：.env 应被拦截", async () => {
    const r = await writeFile(".env", "x");
    expect(r.success).toBe(false);
    expect(r.error!).toContain(".env");
  });

  test("敏感区域：.git 应被拦截", async () => {
    const r = await readFile(".git/config");
    expect(r.success).toBe(false);
  });

  test("敏感区域：data/*.db 应被拦截", async () => {
    const r = await writeFile("data/agent.db", "x");
    expect(r.success).toBe(false);
  });

  test("正常写入与读取 5次回放一致", async () => {
    const p = path.join(".tmp/rigorous-fs", `replay-${Date.now()}.txt`);
    const content = "Deterministic content 42";
    for (let i = 0; i < 5; i++) {
      const w = await writeFile(p, content);
      expect(w.success).toBe(true);
      const r = await readFile(p);
      expect(r.success).toBe(true);
      expect(r.content).toBe(content);
    }
    await deleteFile(p);
  });

  test("大文件限制：>10MB 应拒绝", async () => {
    const p = path.join(".tmp/rigorous-fs", "big.txt");
    await writeFile(p, "x".repeat(100));
    // 手动构造大文件
    const full = path.resolve(process.cwd(), p);
    await fs.writeFile(full, "x".repeat(11 * 1024 * 1024));
    const r = await readFile(p);
    expect(r.success).toBe(false);
    expect(r.error!).toContain("too large");
    await deleteFile(p).catch(() => {});
    await fs.unlink(full).catch(() => {});
  });

  test("并发 50 同文件写入不崩且最终一致", async () => {
    const p = path.join(".tmp/rigorous-fs", `concurrent-${Date.now()}.txt`);
    const payloads = Array.from({ length: 50 }, (_, i) => `payload-${i}`);
    const results = await Promise.all(payloads.map(c => writeFile(p, c)));
    expect(results.every(r => r.success)).toBe(true);
    const r = await readFile(p);
    expect(r.success).toBe(true);
    expect(payloads).toContain(r.content!);
    await deleteFile(p);
  });

  test("并发 mkdir 100 同目录不抛", async () => {
    const dir = path.join(".tmp/rigorous-fs", `mkdir-${Date.now()}`);
    const files = Array.from({ length: 100 }, (_, i) => path.join(dir, `f${i}.txt`));
    const results = await Promise.all(files.map(f => writeFile(f, "x")));
    expect(results.every(r => r.success)).toBe(true);
    const list = await listDirectory(dir);
    expect(list.success).toBe(true);
    expect(list.entries!.length).toBe(100);
    await fs.rm(path.resolve(process.cwd(), dir), { recursive: true, force: true });
  });

  test("moveFile 原子性：目标父目录不存在自动创建", async () => {
    const src = path.join(".tmp/rigorous-fs", `src-${Date.now()}.txt`);
    const dst = path.join(".tmp/rigorous-fs", `nested/${Date.now()}/dst.txt`);
    await writeFile(src, "move me");
    const r = await moveFile(src, dst);
    expect(r.success).toBe(true);
    expect(await fileExists(dst)).toBe(true);
    expect(await fileExists(src)).toBe(false);
    await deleteFile(dst);
  });

  test("不存在文件读取不崩", async () => {
    const r = await readFile(".tmp/rigorous-fs/not-exist-zzz.txt");
    expect(r.success).toBe(false);
  });

  test("listDirectory 非法路径不崩", async () => {
    const r = await listDirectory("../");
    expect(r.success).toBe(false);
  });
});
