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

  test("工具数与 registry 实测一致 — 单一事实源精确相等断言", () => {
    const readme = readFileSync("README.md", "utf8");
    const axiom = readFileSync("docs/AXIOM-ARCHITECTURE.md", "utf8");
    const agentArch = existsSync("docs/AGENT-ARCHITECTURE.md") ? readFileSync("docs/AGENT-ARCHITECTURE.md", "utf8") : "";
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    const mcpGuide = readFileSync("docs/MCP_TOOLS_GUIDE.md", "utf8");

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
      ...checkOld(mcpGuide, "MCP_TOOLS_GUIDE.md"),
    ];
    if (oldHits.length > 0) console.log("[docs-consistency] 旧工具数 hits:\n" + oldHits.join("\n"));
    expect(oldHits.length).toBe(0);

    // 动态权威数（单一事实源 src/testing/tool-count.ts）
    const { countMcpTools } = require("../../src/testing/tool-count.js") as typeof import("../../src/testing/tool-count.js");
    const { total, duplicates } = countMcpTools();
    expect(duplicates).toEqual([]);
    expect(total).toBeGreaterThan(0);

    // 精确相等：各文档声明的 MCP 工具数必须等于实测 total（不接受漂移/旧数）
    const docsToCheck: Array<[string, string]> = [
      ["README.md", readme],
      ["AXIOM-ARCHITECTURE.md", axiom],
      ["ARCHITECTURE.md", arch],
      ["MCP_TOOLS_GUIDE.md", mcpGuide],
    ];
    const countRe = /(\d+)\s*\*{0,2}\s*(?:个\s*)?(?:去重\s*MCP\s*工具|去重\s*工具|MCP\s*工具|MCP\s*Tools|MCP\s*tools)/;
    for (const [label, content] of docsToCheck) {
      const m = content.match(countRe);
      expect(m, `${label} 应声明 MCP 工具数`).not.toBeNull();
      if (m) expect(Number(m[1]), `${label} 声明的工具数应与实测 ${total} 精确相等`).toBe(total);
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

  test("批次5 — README 模块表/审批协议/导航数与实现一致", () => {
    const readme = readFileSync("README.md", "utf8");

    // vram-budget.ts 不存在（实为 system-resource.ts，纯数字预算、无 nvidia-smi 硬件依赖）
    expect(readme.includes("vram-budget.ts")).toBe(false);
    expect(readme.includes("system-resource.ts")).toBe(true);
    expect(readme.includes("RTX 3050")).toBe(false);

    // 审批决议走 REST，而非 WS action；后端默认 60s 自动拒绝保留
    expect(readme.includes("approval.resolve")).toBe(false);
    expect(readme.includes("/approvals/")).toBe(true);

    // 导航数量：以 frontend NAV_ITEMS 实际条目数为准（含 path:'/' 的条目）
    const nav = readFileSync("frontend/src/lib/nav.ts", "utf8");
    const navCount = (nav.match(/path:\s*'\//g) || []).length;
    expect(navCount).toBe(9);
    expect(readme).not.toMatch(/18 个页面/);
    expect(readme).toContain(`${navCount} 个核心入口`);
  });
});
