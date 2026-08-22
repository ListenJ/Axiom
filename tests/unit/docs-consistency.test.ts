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

  test("工具数与 registry 实测一致 — 动态 countMcpTools，无历史旧数(133/150/172/173)", () => {
    const readme = readFileSync("README.md", "utf8");
    const axiom = readFileSync("docs/AXIOM-ARCHITECTURE.md", "utf8");
    const agentArch = existsSync("docs/AGENT-ARCHITECTURE.md") ? readFileSync("docs/AGENT-ARCHITECTURE.md", "utf8") : "";
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");

    const checkOld = (content: string, label: string) => {
      const oldHits: string[] = [];
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (!/(MCP|工具)/.test(line)) return;
        // 历史错误口径：133 / 150 / 172 / 173
        for (const n of [133, 150, 172, 173]) {
          const re = new RegExp(`\\b${n}\\s*(个|MCP|tools|Tools)`, "");
          if (re.test(line)) oldHits.push(`${label}:${idx + 1}:${line.trim()}`);
        }
      });
      return oldHits;
    };

    const oldHits = [
      ...checkOld(readme, "README.md"),
      ...checkOld(axiom, "AXIOM-ARCHITECTURE.md"),
      ...checkOld(agentArch, "AGENT-ARCHITECTURE.md"),
      ...checkOld(arch, "ARCHITECTURE.md"),
    ];
    if (oldHits.length > 0) console.log("[docs-consistency] 旧工具数 hits:\n" + oldHits.join("\n"));
    expect(oldHits.length).toBe(0);

    // 动态权威数必须出现在 README 与 AXIOM（工具/MCP 语境）
    const { countMcpTools } = require("../../src/testing/tool-count.js") as typeof import("../../src/testing/tool-count.js");
    const { total, duplicates } = countMcpTools();
    expect(duplicates).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(180);
    const totalRe = new RegExp(`\\b${total}\\s*(个|MCP|tools|Tools)|\\b${total}\\b[^\\n]{0,40}(MCP 工具|MCP tools)`);
    if (!totalRe.test(readme)) console.log(`[docs-consistency] README 缺少实测工具数 ${total}`);
    expect(totalRe.test(readme)).toBe(true);
    expect(totalRe.test(axiom)).toBe(true);
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
