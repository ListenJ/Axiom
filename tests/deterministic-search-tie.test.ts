import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { DeterministicSearchEngine } from "../src/memory/deterministic-search.js";

function mkVaultWithTwoSameScore(tmp: string) {
  fs.mkdirSync(path.join(tmp, "03-Resources"), { recursive: true });
  // 两笔记对 query "alpha" 同分：标题均为 alpha，内容仅含一次 alpha
  fs.writeFileSync(path.join(tmp, "03-Resources", "b-note.md"), "---\ntitle: alpha\n---\n# alpha\ncontent alpha");
  fs.writeFileSync(path.join(tmp, "03-Resources", "a-note.md"), "---\ntitle: alpha\n---\n# alpha\ncontent alpha");
}

describe("deterministic tie-break S1", () => {
  it("同分时按 path 字典序稳定（5次重复）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-tie-"));
    try {
      mkVaultWithTwoSameScore(tmp);
      const orders: string[] = [];
      for (let i = 0; i < 5; i++) {
        const eng = new DeterministicSearchEngine(tmp);
        const res = eng.search("alpha", { limit: 10 });
        expect(res.length).toBeGreaterThanOrEqual(2);
        orders.push(res.map((r) => r.note.path).join("|"));
      }
      expect(new Set(orders).size).toBe(1);
      const first = orders[0].split("|");
      expect(first.indexOf("03-Resources/a-note.md")).toBeLessThan(first.indexOf("03-Resources/b-note.md"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readdir 逆序创建仍保证 a 在 b 前", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-tie2-"));
    try {
      fs.mkdirSync(path.join(tmp, "03-Resources"), { recursive: true });
      // 故意先创建 b 再创建 a，文件系统顺序可能 b 在前，但结果应仍 a 在前
      fs.writeFileSync(path.join(tmp, "03-Resources", "b-note.md"), "---\ntitle: alpha\n---\n# alpha\ncontent alpha");
      fs.writeFileSync(path.join(tmp, "03-Resources", "a-note.md"), "---\ntitle: alpha\n---\n# alpha\ncontent alpha");
      const eng = new DeterministicSearchEngine(tmp);
      const res = eng.search("alpha", { limit: 10 });
      const paths = res.map((r) => r.note.path);
      expect(paths.indexOf("03-Resources/a-note.md")).toBeLessThan(paths.indexOf("03-Resources/b-note.md"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readdirSync 排序：scanDirectory 结果字典序", () => {
    // 验证 notes 插入顺序是否字典序（间接测 scanDirectory 排序）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-tie3-"));
    try {
      fs.mkdirSync(path.join(tmp, "03-Resources"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "03-Resources", "z.md"), "---\ntitle: z\n---\n# z\nz");
      fs.writeFileSync(path.join(tmp, "03-Resources", "a.md"), "---\ntitle: a\n---\n# a\na");
      fs.writeFileSync(path.join(tmp, "03-Resources", "m.md"), "---\ntitle: m\n---\n# m\nm");
      const eng = new DeterministicSearchEngine(tmp);
      // listNotePaths 应返回字典序插入（若 readdir 已排序）
      const paths = (eng as any).listNotePaths ? (eng as any).listNotePaths() : [...(eng as any).notes.keys()];
      // a.md 应在 m.md 与 z.md 之前（若按字典序）
      const sorted = [...paths].sort((a: string, b: string) => a.localeCompare(b));
      // 允许当前未排序时失败（红）
      expect(paths).toEqual(sorted);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
