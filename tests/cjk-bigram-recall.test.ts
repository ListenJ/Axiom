/**
 * P1-S2 层1：内存引擎 CJK bigram 召回
 *
 * 审计判定：deterministic-search tokenize（原 :595-606）把连续中文当单 token，
 * 语序改写（"机器学习" → "学习机器"）即漏召回。
 *
 * 行为规格（经公共接口 search() 验证，不测私有 tokenize）：
 * 1. 语序改写召回：索引"机器学习笔记"后查"学习机器"能命中；
 * 2. 单字中文查询不回归：查"学"仍能命中；
 * 3. 纯英文路径行为不变：命中/不命中行为与改前一致。
 */
import { describe, test, expect, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { DeterministicSearchEngine } from "../src/memory/deterministic-search.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cjk-bigram-"));
const vault = path.join(tmpDir, "vault");

function writeNote(rel: string, title: string, content: string): void {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\ntitle: ${title}\n---\n\n${content}\n`);
}

// 索引侧：标题与正文均为连续中文，无分隔符（unicode61 语义下的"单 token"形态）
writeNote("03-Resources/ml-note.md", "机器学习笔记", "这是一份机器学习领域的基础笔记，记录监督学习与神经网络的要点。");
writeNote("03-Resources/english.md", "Distributed Systems", "Distributed systems rely on consensus protocols and replication for fault tolerance.");

const engine = new DeterministicSearchEngine(vault);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("CJK bigram 召回（P1-S2 层1）", () => {
  test("语序改写：索引『机器学习笔记』后查『学习机器』可命中", () => {
    const results = engine.search("学习机器");
    expect(results.some((r) => r.note.path === "03-Resources/ml-note.md")).toBe(true);
  });

  test("单字查询不回归：查『学』仍命中机器学习笔记", () => {
    const results = engine.search("学");
    expect(results.some((r) => r.note.path === "03-Resources/ml-note.md")).toBe(true);
  });

  test("纯英文路径行为不变：命中与不命中均与改前一致", () => {
    const hit = engine.search("consensus");
    expect(hit.some((r) => r.note.path === "03-Resources/english.md")).toBe(true);
    const miss = engine.search("quantum");
    expect(miss.some((r) => r.note.path === "03-Resources/english.md")).toBe(false);
  });
});
