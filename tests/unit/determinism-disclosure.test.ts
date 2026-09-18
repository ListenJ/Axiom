import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * G-04 防漂移测试 —— docs/LIMITATIONS.md §5「确定性边界逐模块披露」
 *
 * 硬约束（docs/superpowers/plans/2026-08-21-audit-remediation-playbook.md:16）：
 * 代码涉及 Date.now()/Math.random()/Map 遍历的模块，必须在 LIMITATIONS.md 披露不确定性边界。
 *
 * 本测试不校验「是否确定性」（那是人工裁定），只校验**披露不漂移**：
 *   1. src/dre/** + src/knowledge/** 中命中不确定源的文件集，必须与 §5.2.1 表格逐文件一致（双向）；
 *   2. §5.2 汇总表的文件数/处数必须与实测一致（口径见文档：「处数」= 命中行数）。
 */

const DOC = "docs/LIMITATIONS.md";
const ROOTS = ["src/dre", "src/knowledge"];

// 剥离 // 行注释与 /* */ 块注释（保留字符串/模板串内容），使注释中的 "Date.now()" 不计入。
// 这是文档声明的普查口径；首轮未剥注释曾把 knowledge-port.ts:261 说明性注释误计为调用。
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let state: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { state = "str"; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += c; } i++; continue; }
    if (state === "block") { if (c === "*" && c2 === "/") { state = "code"; i += 2; continue; } if (c === "\n") out += c; i++; continue; }
    // state === "str"
    out += c;
    if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
    if (c === quote) state = "code";
    i++; continue;
  }
  return out;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const SOURCES: Array<{ label: string; re: RegExp }> = [
  { label: "Date.now()", re: /Date\.now\s*\(/ },
  { label: "performance.now()/process.hrtime", re: /performance\.now\s*\(|process\.hrtime\b/ },
  { label: "Math.random()", re: /Math\.random\s*\(/ },
  { label: "randomUUID()", re: /randomUUID\s*\(/ },
  { label: "localeCompare()", re: /localeCompare\s*\(/ },
  { label: "new Date()", re: /new\s+Date\s*\(/ },
];

// 逐文件、逐模式统计「命中行数」（同一行多次计 1，与文档口径一致）
type Hit = { files: number; lines: number };
function census(): { bySource: Map<string, Hit>; hitFiles: Set<string> } {
  const bySource = new Map<string, Hit>();
  for (const s of SOURCES) bySource.set(s.label, { files: 0, lines: 0 });
  const hitFiles = new Set<string>();

  for (const root of ROOTS) {
    for (const file of walkTs(root)) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      let fileHit = false;
      for (const s of SOURCES) {
        let matched = 0;
        for (const line of lines) if (s.re.test(line)) matched++;
        if (matched > 0) {
          const h = bySource.get(s.label)!;
          h.files++;
          h.lines += matched;
          fileHit = true;
        }
      }
      if (fileHit) hitFiles.add(file);
    }
  }
  return { bySource, hitFiles };
}

// 从 §5.2.1 表格抽取被披露的文件路径（表格行形如：| `src/dre/actor/system.ts` | ... | ... |）
function disclosedFiles(doc: string): Set<string> {
  const section = doc.split("#### 5.2.1")[1] ?? "";
  const body = section.split("\n### ")[0] ?? section;
  const set = new Set<string>();
  for (const line of body.split("\n")) {
    const m = line.match(/^\|\s*`(src\/[^`]+\.ts)`/);
    if (m) set.add(m[1]);
  }
  return set;
}

describe("G-04 确定性边界披露 — docs/LIMITATIONS.md §5 防漂移", () => {
  const doc = readFileSync(DOC, "utf8");
  const { bySource, hitFiles } = census();
  const disclosed = disclosedFiles(doc);

  test("§5.2.1 逐文件清单存在且非空", () => {
    expect(doc).toContain("#### 5.2.1");
    expect(disclosed.size).toBeGreaterThan(0);
  });

  test("命中不确定源的每个文件都已在 §5.2.1 披露（未披露 = 漏登记）", () => {
    const missing = [...hitFiles].filter((f) => !disclosed.has(f)).sort();
    if (missing.length > 0) {
      console.log("[determinism-disclosure] 命中但未在 §5.2.1 披露的文件：\n" + missing.join("\n"));
    }
    expect(missing).toEqual([]);
  });

  test("§5.2.1 披露的每个文件都确有命中（错登记/已修复残留 = 清账失败）", () => {
    const stale = [...disclosed].filter((f) => !hitFiles.has(f)).sort();
    if (stale.length > 0) {
      console.log("[determinism-disclosure] §5.2.1 列了但实测无命中的文件（应删除或注明）：\n" + stale.join("\n"));
    }
    expect(stale).toEqual([]);
  });

  test("§5.2 汇总表数字与实测一致（文件数/命中处数；处数=命中行数）", () => {
    // 期望值直接写在断言中：任何一侧漂移都会失败，迫使披露与代码同时更新。
    const expected: Record<string, Hit> = {
      "Date.now()": { files: 34, lines: 179 },
      "performance.now()/process.hrtime": { files: 5, lines: 39 },
      "Math.random()": { files: 10, lines: 20 },
      "randomUUID()": { files: 3, lines: 7 },
      "localeCompare()": { files: 5, lines: 6 },
      "new Date()": { files: 3, lines: 5 },
    };
    for (const [label, exp] of Object.entries(expected)) {
      const got = bySource.get(label)!;
      expect({ label, ...got }).toEqual({ label, ...exp });
    }
    expect(hitFiles.size).toBe(36);
    const totalLines = [...bySource.values()].reduce((a, h) => a + h.lines, 0);
    expect(totalLines).toBe(256);
  });

  test("§5.2 汇总表文本声明的合计与实际一致（36 文件 / 253 处）", () => {
    const summary = doc.split("#### 5.2.1")[0];
    expect(summary).toContain("| `Date.now()` | 34 | 179 |");
    expect(summary).toContain("| `Math.random()` | 10 | 20 |");
    expect(summary).toContain("| `randomUUID()` | 3 | 7 |");
    expect(summary).toContain("**36 个文件（并集）**");
    expect(summary).toContain("**256 处**");
  });
});
