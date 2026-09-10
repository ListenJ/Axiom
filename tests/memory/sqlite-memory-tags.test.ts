/**
 * SQLiteMemory 标签查询回归测试 — P0-5
 *
 * 行为规格（经公共接口验证）：
 * 1. listByTag 对含 LIKE 通配符（%/_)的标签精确匹配："100%" 不得误召 "100x done"
 *    （实证：现行 `LIKE '%"100%"%'` 中 % 是通配符，产生假阳性）。
 * 2. 损坏的 tags JSON 单行不抛错、降级为空数组（getByPath）。
 * 3. 损坏行不得拖垮整批列表（listRecent 返回其余有效行）。
 * 4. search() 的 catch-all 不得因单条损坏行吞掉全部命中。
 *
 * 注：调研所称 `"golang"` 被 `"go"` 误召**不成立**（尾引号保护，已实证 0 命中），
 * 本文件不为其立测试。
 */

import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-mem-p05-"));
const dbPath = path.join(tmpDir, "test.db");
const mem = new SQLiteMemory(dbPath);

function seed(pathName: string, tags: string[], content: string): void {
  mem.upsertNote({
    path: pathName, title: pathName, content, excerpt: "", tags,
    paraCategory: "resources", type: "note", confidence: 0.7,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
}

afterAll(() => {
  mem.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SQLiteMemory 标签精确匹配与损坏 tags 兜底（P0-5）", () => {
  test("listByTag 通配符精确匹配：'100%' 不误召 '100x done'", () => {
    seed("pct.md", ["100%"], "percent real");
    seed("hundred-x.md", ["100x done"], "x fake");
    const result = mem.listByTag("100%");
    expect(result.map((r) => r.path)).toEqual(["pct.md"]);
  });

  test("getByPath 对损坏 tags 行不抛错且降级为空数组", () => {
    seed("corrupt.md", ["ok"], "normal content");
    const raw = new Database(dbPath);
    raw.run("UPDATE memory_notes SET tags = '{broken' WHERE path = 'corrupt.md'");
    raw.close();
    let record: ReturnType<SQLiteMemory["getByPath"]>;
    expect(() => { record = mem.getByPath("corrupt.md"); }).not.toThrow();
    expect(record!.tags).toEqual([]);
  });

  test("listRecent 跳过损坏行的解析失败，返回其余有效行", () => {
    // corrupt.md 已在上一用例中损坏；另有 pct.md 有效
    const result = mem.listRecent();
    expect(result.map((r) => r.path)).toContain("pct.md");
  });

  test("search 不因单条损坏行吞掉全部命中", () => {
    // FTS 命中词选两条笔记共有、且与损坏行无关的词
    seed("s1.md", ["alpha"], "zebra unique sharedword");
    seed("s2.md", ["beta"], "sharedword other");
    const hits = mem.search("sharedword");
    expect(hits.map((h) => h.record.path).sort()).toEqual(["s1.md", "s2.md"]);
  });
});
