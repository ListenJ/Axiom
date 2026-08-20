import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

function collectDocsHits(pattern: RegExp): string[] {
  const hits: string[] = [];
  const excludeDirs = new Set(["archive", "reviews", "superpowers"]);
  const excludeFiles = new Set(["operations-log.md"]);
  function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith(".md")) {
        if (excludeFiles.has(e.name)) continue;
        const c = readFileSync(p, "utf8");
        const lines = c.split("\n");
        lines.forEach((line, idx) => {
          if (pattern.test(line)) {
            hits.push(`${p}:${idx + 1}:${line.trim().slice(0, 180)}`);
          }
        });
      }
    }
  }
  walk("docs");
  // also check README.md at root
  const readme = readFileSync("README.md", "utf8");
  readme.split("\n").forEach((line, idx) => {
    if (pattern.test(line)) hits.push(`README.md:${idx + 1}:${line.trim().slice(0, 180)}`);
  });
  return hits;
}

describe("docs-consistency Task16 — 文档一致性", () => {
  test("无过时零向量描述 — grep 零向量 命中为 0 (active docs, 排除 archive/reviews/superpowers/operations-log)", () => {
    const hits = collectDocsHits(/零向量/);
    if (hits.length > 0) console.log("[docs-consistency] 零向量 hits:\n" + hits.join("\n"));
    expect(hits.length).toBe(0);
  });

  test("无过时 PG已移除描述 — grep PG已移除 命中为 0", () => {
    const hits = collectDocsHits(/PG已移除|PG 已移除/);
    if (hits.length > 0) console.log("[docs-consistency] PG已移除 hits:\n" + hits.join("\n"));
    expect(hits.length).toBe(0);
  });

  test("工具数与 registry 172 一致 — README/docs 权威声明应为 172 且不含 133/150/173 旧数", () => {
    const readme = readFileSync("README.md", "utf8");
    const axiom = readFileSync("docs/AXIOM-ARCHITECTURE.md", "utf8");
    const agentArch = existsSync("docs/AGENT-ARCHITECTURE.md") ? readFileSync("docs/AGENT-ARCHITECTURE.md", "utf8") : "";
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");

    // 旧数不应出现于工具上下文（允许行号/端口等无关数字，但工具声明处不应含 133/150/173）
    const checkOld = (content: string, label: string) => {
      const oldHits: string[] = [];
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (/133\s*MCP/.test(line) || /150\s*MCP/.test(line) || /173\s*个/.test(line) || /133\s*个/.test(line) || /\b133\b.*工具/.test(line) || /\b150\b.*工具/.test(line) || /\b173\b.*工具/.test(line)) {
          oldHits.push(`${label}:${idx + 1}:${line.trim()}`);
        }
        // also direct check for README header pattern "133 MCP tools"
        if (line.includes("133 MCP tools") || line.includes("150 MCP Tools") || line.includes("173 个 MCP")) oldHits.push(`${label}:${idx + 1}:${line.trim()}`);
      });
      return oldHits;
    };

    const oldHits = [
      ...checkOld(readme, "README.md"),
      ...checkOld(axiom, "AXIOM-ARCHITECTURE.md"),
      ...checkOld(agentArch, "AGENT-ARCHITECTURE.md"),
    ];
    if (oldHits.length > 0) console.log("[docs-consistency] 旧工具数 hits:\n" + oldHits.join("\n"));
    expect(oldHits.length).toBe(0);

    // 新数 172 应至少出现于 README 与 AXIOM
    expect(readme.includes("172")).toBe(true);
    expect(axiom.includes("172")).toBe(true);
    // AGENT-ARCHITECTURE 若存在也应为 172
    if (agentArch) expect(agentArch.includes("172")).toBe(true);
    // ARCHITECTURE.md 若提及工具数也应为 172（若无工具数声明则跳过）
    if (arch.includes("MCP")) {
      // ensure no old numbers in arch
      expect(checkOld(arch, "ARCHITECTURE.md").length).toBe(0);
    }
  });

  test("Limitations 章节应披露手写余弦+PG vector 可选与可选 LLM", () => {
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    const limitations = existsSync("docs/LIMITATIONS.md") ? readFileSync("docs/LIMITATIONS.md", "utf8") : "";
    const readme = readFileSync("README.md", "utf8");
    // At least one of ARCHITECTURE or LIMITATIONS or README should mention 手写余弦 and PG vector 可选
    const combined = arch + "\n" + limitations + "\n" + readme;
    expect(combined.includes("手写余弦")).toBe(true);
    expect(combined.includes("PG vector") || combined.includes("pgvector") || combined.includes("PG")).toBe(true);
    // LLM 可选
    expect(combined.includes("KNOWLEDGE_USE_LLM") || combined.includes("可选") ).toBe(true);
  });
});
