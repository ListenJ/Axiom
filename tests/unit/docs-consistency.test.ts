import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

function collectDocsHits(pattern: RegExp): string[] {
  const hits: string[] = [];
  // plans：**计划**文档（docs/plans/、docs/superpowers/plans/）不是"技术主张面"——
  // 它必须能指名道姓地讨论"要撤回哪条旧宣称"，否则就无法写出撤回计划。
  // 本门禁防的是**主张面**（README/ARCHITECTURE/LIMITATIONS 等）出现过时宣称，
  // 故 plans 与既有的 superpowers、reviews 同属排除面（2026-09-19 显式化）。
  const excludeDirs = new Set(["archive", "reviews", "superpowers", "operations-log", "plans"]);
  // ops log 主文件（docs/operations-log.md）与月度拆分目录（docs/operations-log/YYYY-MM.md）均为历史留痕
  const isExcludedFile = (name: string) => name.startsWith("operations-log");
  function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith(".md")) {
        if (isExcludedFile(e.name)) continue;
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
  // 本 describe 里的三处 doc-caliber:quote：本门把禁语原话当判据逐字写出，由 tests/doc-contract.test.ts
  // 的 D1 行级哨兵放行（该门不再整文件豁免自己或别的门）。
  test("无过时零向量描述 — grep 零向量 命中为 0 (active docs, 排除 archive/reviews/superpowers/operations-log)", () => { // doc-caliber:quote
    const hits = collectDocsHits(/零向量/); // doc-caliber:quote
    if (hits.length > 0) console.log("[docs-consistency] 零向量 hits:\n" + hits.join("\n")); // doc-caliber:quote
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

  test("ARCHITECTURE.md §1 基线统计 == 生成器实测（棘轮：改 src 必须重跑 arch:stats）", () => {
    // 单一事实源：src/testing/arch-stats.ts（生成器 scripts/count-arch-stats.mjs 共用）。
    // 历史漂移：§1 曾手抄 260+ 文件 / ~70,000 行，2026-09-29 校准当天又漂 137 行。
    const { archStats } = require("../../src/testing/arch-stats.js") as typeof import("../../src/testing/arch-stats.js");
    const s = archStats();
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    const re = /\*\*(\d+) 模块 \/ (\d+) 文件 \/ ([\d,]+) 行\*\*/;
    const m = arch.match(re);
    // 自检：格式被改写（正则不再命中）时必须红，不能靠"匹配不到就跳过"变绿
    expect(m, "ARCHITECTURE.md §1 应含 `N 模块 / N 文件 / N 行` 声明").not.toBeNull();
    expect(Number(m![1]), "声明模块数应等于实测").toBe(s.srcModules);
    expect(Number(m![2]), "声明文件数应等于实测").toBe(s.srcFiles);
    expect(Number(m![3].replace(/,/g, "")), "声明行数应等于实测").toBe(s.srcLines);
  });

  test("Limitations 章节应披露确定性检索口径（FTS5+关键词，余弦仅可选语义层与可选 LLM）", () => {
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    const limitations = existsSync("docs/LIMITATIONS.md") ? readFileSync("docs/LIMITATIONS.md", "utf8") : "";
    const readme = readFileSync("README.md", "utf8");
    // 「手写余弦」叙事已废弃：实现为共享 cosineSimilarity（src/utils/math.ts），默认检索为 FTS5+关键词
    const combined = arch + "\n" + limitations + "\n" + readme;
    expect(combined.includes("手写余弦")).toBe(false);
    expect(combined.includes("FTS5")).toBe(true);
    expect(combined.includes("PG vector") || combined.includes("pgvector") || combined.includes("PG")).toBe(true);
    // LLM 可选
    expect(combined.includes("KNOWLEDGE_USE_LLM") || combined.includes("可选") ).toBe(true);
  });

  test("批次5 — README 模块表/审批协议/导航数与实现一致", () => {
    const readme = readFileSync("README.md", "utf8");

    // vram-budget.ts 从未存在。system-resource.ts 与 vram_status 工具曾于 2026-09-18 随 VRAM
    // 管理子系统归档移除（ku 线口径 188 工具），2026-09-26 主干归一裁决保留资源子系统
    // （H-06 预算同源 + clampMaxTokens 依赖其数据），system-resource.ts 与 vram_status 恢复在位
    // （189 工具）。README 应将其作为在位模块/工具描述；「已归档移除」旧口径不得回潮。
    expect(readme.includes("vram-budget.ts")).toBe(false);
    expect(readme.includes("system-resource.ts")).toBe(true);
    expect(readme).not.toMatch(/已归档移除|已按用户决策归档移除/);
    expect(readme).toContain("vram_status");
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

describe("docs mineru Task8 — MinerU 零LLM 口径澄清", () => {
  test("KNOWLEDGE-BASE clarifies zero-LLM boundary", () => {
    const md = readFileSync("docs/KNOWLEDGE-BASE.md", "utf8");
    expect(md).toContain("判别式");
    expect(md).toContain("PP-DocLayoutV2");
    expect(md).toContain("Unimernet");
    expect(md).toContain("零LLM");
    expect(md).toContain("mineru 3.4.5");
    expect(md).toContain("70");
  });
  test("LIMITATIONS lists mineru deps", () => {
    const md = readFileSync("docs/LIMITATIONS.md", "utf8");
    expect(md).toContain("mineru 3.4.5");
    expect(md).toContain("判别式");
    expect(md).toContain("PP-DocLayoutV2");
  });
  test("dual-probe harness exists and documents aggregation", () => {
    expect(existsSync("scripts/audit/dual-probe.ts")).toBe(true);
    const harness = readFileSync("scripts/audit/dual-probe.ts", "utf8");
    expect(harness).toContain("dual-probe");
    expect(harness).toContain("health");
  });
  test("provider-caller has timeout/retry/fallback", () => {
    const src = readFileSync("src/router/provider-caller.ts", "utf8");
    expect(src).toContain("createDreCloudAdapter");
    expect(src).toContain("AbortController");
    expect(src.toLowerCase()).toContain("retry");
    expect(src.toLowerCase()).toContain("fallback");
  });
});
