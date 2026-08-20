import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { writeFile, moveFile } from "../../src/mcp/tools/filesystem";

describe("filesystem H-03 TOCTOU 原子化 mkdir -p + 捕获", () => {
  const base = "tmp-fs-toctou-test";
  const baseAbs = path.resolve(base);

  beforeEach(async () => {
    try { await fs.rm(baseAbs, { recursive: true, force: true }); } catch {}
    try { fsSync.rmSync(path.resolve("tmp-toctou-link"), { recursive: true, force: true }); } catch {}
    try { fsSync.rmSync(path.resolve("tmp-toctou-link2"), { recursive: true, force: true }); } catch {}
  });
  afterEach(async () => {
    try { await fs.rm(baseAbs, { recursive: true, force: true }); } catch {}
    try { fsSync.rmSync(path.resolve("tmp-toctou-link"), { force: true }); } catch {}
    try { fsSync.rmSync(path.resolve("tmp-toctou-link2"), { force: true }); } catch {}
    try { fsSync.rmSync(path.resolve("tmp-toctou-outside"), { recursive: true, force: true }); } catch {}
    try { fsSync.rmSync(path.resolve("tmp-toctou-outside2"), { recursive: true, force: true }); } catch {}
  });

  test("并发 mkdir 竞态不抛且文件均成功（原子 mkdir -p + 捕获）", async () => {
    const dir = path.join(base, "concurrent", "sub");
    const files = ["a.txt", "b.txt", "c.txt"];
    const results = await Promise.all(
      files.map((f, i) => writeFile(path.join(dir, f), `content-${i}`))
    );
    for (const r of results) expect(r.success).toBe(true);
    for (const f of files) {
      const content = await fs.readFile(path.join(baseAbs, "concurrent", "sub", f), "utf-8");
      expect(content).toMatch(/content-/);
    }
  });

  test("并发同文件写入不创建非预期文件", async () => {
    const p = path.join(base, "same", "file.txt");
    const results = await Promise.all([
      writeFile(p, "first"),
      writeFile(p, "second"),
    ]);
    // 至少一个成功，文件存在且内容为两者之一（原子覆盖，不炸）
    expect(results.some(r => r.success)).toBe(true);
    const exists = await fs.access(path.resolve(p)).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    const c = await fs.readFile(path.resolve(p), "utf-8");
    expect(["first", "second"].includes(c)).toBe(true);
  });

  test("TOCTOU：mkdir 前后校验，父目录被并发替换为外链应拦截（原子化后重校验）", async () => {
    const outside = path.join("C:", "Windows", "Temp", "toctou-outside-" + Date.now());
    try { await fs.rm(outside, { recursive: true, force: true }); } catch {}
    await fs.mkdir(outside, { recursive: true });

    const victimParent = path.join(base, "race-parent");
    const victimFile = path.join(victimParent, "sub", "evil.txt");
    try { await fs.rm(path.resolve(victimParent), { recursive: true, force: true }); } catch {}

    const origMkdir = fsp.mkdir.bind(fsp);
    const spy = spyOn(fsp as any, "mkdir").mockImplementation(async (dir: string, opts?: any) => {
      if (dir === path.resolve(victimParent) || dir === path.resolve(victimParent, "sub")) {
        try { await fsp.rm(path.resolve(victimParent), { recursive: true, force: true }); } catch {}
        // 确保 base 存在再建 symlink，避免 ENOENT
        try { await fsp.mkdir(path.resolve(base), { recursive: true }); } catch {}
        try { fsSync.symlinkSync(outside, path.resolve(victimParent), "junction"); } catch {}
      }
      try {
        await origMkdir(dir as any, opts);
      } catch {}
      return undefined as any;
    });

    const r = await writeFile(victimFile, "should-not-escape");
    expect(r.success).toBe(false);
    const outsideFile = path.join(outside, "sub", "evil.txt");
    const leaked = await fs.access(outsideFile).then(() => true).catch(() => false);
    expect(leaked).toBe(false);

    spy.mockRestore();
    try { fsSync.unlinkSync(path.resolve(victimParent)); } catch {}
    try { await fs.rm(outside, { recursive: true, force: true }); } catch {}
    try { await fs.rm(path.resolve(base), { recursive: true, force: true }); } catch {}
  });

  test("moveFile 原子 mkdir 同样拦截外链竞态", async () => {
    const src = path.join(base, "src.txt");
    await fs.mkdir(path.dirname(path.resolve(src)), { recursive: true });
    await fs.writeFile(path.resolve(src), "src-content");

    const outside = path.join("C:", "Windows", "Temp", "toctou-outside2-" + Date.now());
    try { await fs.rm(outside, { recursive: true, force: true }); } catch {}
    await fs.mkdir(outside, { recursive: true });

    const dstParent = path.join(base, "move-race");
    const dst = path.join(dstParent, "sub", "dst.txt");
    try { await fs.rm(path.resolve(dstParent), { recursive: true, force: true }); } catch {}

    const origMkdir2 = fsp.mkdir.bind(fsp);
    const spy = spyOn(fsp as any, "mkdir").mockImplementation(async (dir: string, opts?: any) => {
      if (dir === path.resolve(dstParent) || dir === path.resolve(path.dirname(path.resolve(dst)))) {
        try { await fsp.rm(path.resolve(dstParent), { recursive: true, force: true }); } catch {}
        try { await fsp.mkdir(path.resolve(base), { recursive: true }); } catch {}
        try { fsSync.symlinkSync(outside, path.resolve(dstParent), "junction"); } catch {}
      }
      try { await origMkdir2(dir as any, opts); } catch {}
      return undefined as any;
    });

    const r = await moveFile(src, dst);
    expect(r.success).toBe(false);

    spy.mockRestore();
    try { fsSync.unlinkSync(path.resolve(dstParent)); } catch {}
    try { await fs.rm(outside, { recursive: true, force: true }); } catch {}
    try { await fs.rm(path.resolve(base), { recursive: true, force: true }); } catch {}
  });
});
