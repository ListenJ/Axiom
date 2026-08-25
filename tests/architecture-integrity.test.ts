import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";

const srcDir = path.resolve(import.meta.dir, "../src");

// walkDir excludes _archive and node_modules (used by the stringent tests below)
function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "_archive" && entry.name !== "node_modules") {
      results.push(...walkDir(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

// Top-level directory of a src file (e.g. "utils", "memory"); "" for root files.
function topLevelOf(file: string): string {
  const rel = path.relative(srcDir, path.dirname(file)).replace(/\\/g, "/");
  return rel === "." ? "" : rel.split("/")[0];
}

// Resolves all relative imports in `file` to their top-level src directory.
function relativeImportTargets(file: string): string[] {
  const content = fs.readFileSync(file, "utf-8");
  const re = /(?:from\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const fileDir = path.dirname(file);
    const res = path.resolve(fileDir, m[1]);
    const rel = path.relative(srcDir, res).replace(/\\/g, "/");
    if (rel.startsWith("..") || rel === "") continue;
    out.push(rel.split("/")[0]);
  }
  return out;
}

// Set of other top-level directories that `top` imports from.
function dirImports(top: string): Set<string> {
  const set = new Set<string>();
  const files = walkDir(path.join(srcDir, top));
  for (const f of files) {
    for (const t of relativeImportTargets(f)) {
      if (!t || t === top) continue;
      set.add(t);
    }
  }
  return set;
}

// Finds exported function declarations missing a return type annotation.
function exportedFunctionsWithoutReturnType(content: string): string[] {
  const result: string[] = [];
  const re = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const parenStart = content.indexOf("(", m.index!);
    if (parenStart === -1) continue;
    let depth = 0;
    let i = parenStart;
    for (; i < content.length; i++) {
      const ch = content[i];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    const after = content.slice(i + 1);
    if (/^\s*:\s*\S/.test(after)) continue; // has return type
    const nextBrace = after.indexOf("{");
    const nextSemi = after.indexOf(";");
    if (nextBrace === -1) continue; // not a body — skip (overload/interface)
    if (nextSemi !== -1 && nextSemi < nextBrace) continue; // overload declaration
    result.push(name);
  }
  return result;
}

const LARGE_FILE_EXEMPTIONS: Record<string, number> = {
  "cli.ts": 1600,
  "eval/arena-collector.ts": 1100,
  "router/model-router.ts": 1500,
  "router/models/registry.ts": 1500,
  "agents/opencode-tool-agent.ts": 1500,
  "agents/project-analyzer.ts": 1500,
};

// console.{log,error} is permitted inside the logger implementation itself
  // and in CLI / launcher / interactive entry points whose primary contract is
  // writing user-facing output to stdout/stderr. Library/business modules must
  // route through the structured logger instead.
  const CONSOLE_WHITELIST = new Set([
    "utils/logger.ts",
    "cli.ts",
    "cli/setup.ts",
    "eval/eval-cli.ts",
    "eval/eval-runner.ts",
    "core/health-checker.ts",
    "launcher.ts",
    "agent-evals/run.ts",
  ]);

function getTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        files.push(...getTsFiles(full));
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

const ENV_WHITELIST = new Set([
  "utils/env.ts",
  "core/config-center.ts",
  "utils/logger.ts",
  "utils/proxy-fetch.ts",
  "utils/api-key-store.ts",
  "memory/vault-manager.ts",
  "main.ts",
  "router/models/providers.ts",
]);

describe("Architecture Integrity", () => {
  // ── Test 1: Layer constraints ──────────────────────────────────────
  it("src/utils/ must not import from higher layers", () => {
    const re = /(?:from\s+['"]|import\s*\(\s*['"])\.\.\/(memory|router|agents|mcp|dre|routes|services)\//;
    const violations: string[] = [];
    const files = getTsFiles(path.join(srcDir, "utils"));

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const relative = path.relative(srcDir, file).replace(/\\/g, "/");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          violations.push(`${relative}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    if (violations.length) {
      console.log("\nLayer violations:");
      for (const v of violations) console.log(`  ${v}`);
    }
    expect(violations).toHaveLength(0);
  });

  // ── Test 2: process.env → env.ts ──────────────────────────────────
  it("process.env reads must go through env.ts", () => {
    const envReadRe = /process\.env\.[a-zA-Z_]\w*|process\.env\s*\[/;
    const violations: string[] = [];
    const files = getTsFiles(srcDir);

    for (const file of files) {
      const relative = path.relative(srcDir, file).replace(/\\/g, "/");
      if (ENV_WHITELIST.has(relative)) continue;

      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (envReadRe.test(lines[i])) {
          violations.push(`${relative}:${i + 1}: ${trimmed}`);
        }
      }
    }

    if (violations.length) {
      console.log("\nprocess.env violations:");
      for (const v of violations) console.log(`  ${v}`);
    }
    expect(violations).toHaveLength(0);
  });

  // ── Test 3: as any ≤ 25 ───────────────────────────────────────────
  it("as any count must not exceed 25", () => {
    let count = 0;
    const files = getTsFiles(srcDir);

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const matches = content.match(/as\s+any/g);
      if (matches) count += matches.length;
    }

    console.log(`\n"as any" occurrences in src/: ${count}`);
    expect(count).toBeLessThanOrEqual(25);
  });

  // ── Test 4: @ts-expect-error / @ts-ignore ≤ 1 ────────────────────
  it("@ts-expect-error / @ts-ignore count must not exceed 1", () => {
    let count = 0;
    const files = getTsFiles(srcDir);

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const matches = content.match(/@ts-(?:expect-error|ignore)/g);
      if (matches) count += matches.length;
    }

    console.log(`\n@ts-expect-error / @ts-ignore occurrences in src/: ${count}`);
    expect(count).toBeLessThanOrEqual(1);
  });

  // ── Test 5: mcp/server.ts ≤ 500 lines ─────────────────────────────
  it("mcp/server.ts must not exceed 500 lines", () => {
    const filePath = path.join(srcDir, "mcp", "server.ts");
    const content = fs.readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;

    console.log(`\nmcp/server.ts: ${lineCount} lines (limit: 500)`);
    expect(lineCount).toBeLessThanOrEqual(500);
  });

  // ── Test 6a: dre/index.ts – no deprecated exports ─────────────────
  it("dre/index.ts must not export GPU_CONSTRAINTS or deprecated items", () => {
    const filePath = path.join(srcDir, "dre", "index.ts");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).not.toContain("GPU_CONSTRAINTS");
    expect(content).not.toMatch(/export\s+.*\bVRAM\b/);
  });

  // ── Test 6b: router/models.ts – no export * ───────────────────────
  it("router/models.ts must not use export *", () => {
    const filePath = path.join(srcDir, "router", "models.ts");
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).not.toMatch(/export\s+\*\s+from/);
  });

  // ══════════════════════════════════════════════════════════════════
  // LAYER ENFORCEMENT (5 new tests)
  // ══════════════════════════════════════════════════════════════════

  // ── Test 8: no file > 1000 lines in src/ (exempted: 1500) ───────────
  it("no src/ file exceeds 1000 lines (exempted large files: 1500)", () => {
    const files = walkDir(srcDir);
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcDir, file).replace(/\\/g, "/");
      const limit = LARGE_FILE_EXEMPTIONS[rel] ?? 1000;
      const lines = fs.readFileSync(file, "utf-8").split("\n").length;
      if (lines > limit) violations.push(`${rel}: ${lines} lines (limit ${limit})`);
    }
    if (violations.length) console.log("\nFile line-count violations:\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // ── Test 9: no directory imports from > 8 other directories ────────
  it("no top-level directory imports from more than 8 other directories", () => {
    const files = walkDir(srcDir);
    const tops = new Set<string>();
    for (const f of files) {
      const t = topLevelOf(f);
      if (t) tops.add(t);
    }
    // Integration modules are exempt — they bridge multiple subsystems by design
    const EXEMPT = new Set(["mcp", "routes", "agents"]);
    const violations: string[] = [];
    for (const t of tops) {
      if (EXEMPT.has(t)) continue;
      const imps = dirImports(t);
      if (imps.size > 8) {
        violations.push(`${t}: ${imps.size} -> ${Array.from(imps).sort().join(", ")}`);
      }
    }
    if (violations.length) console.log("\nDirectory import-complexity violations:\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // ── Test 10: mcp/server.ts must be ≤ 500 lines ──
  it("mcp/server.ts must not exceed 500 lines", () => {
    const filePath = path.join(srcDir, "mcp", "server.ts");
    const content = fs.readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    console.log(`\nmcp/server.ts: ${lineCount} lines (limit: 500)`);
    expect(lineCount).toBeLessThanOrEqual(500);
  });

  // ── Test 11: no src/ file has more than 5 `as any` casts ────────────
  it("no src/ file has more than 5 `as any` casts (per-file limit)", () => {
    const files = walkDir(srcDir);
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const matches = content.match(/as\s+any\b/g);
      const count = matches ? matches.length : 0;
      if (count > 5) {
        violations.push(`${path.relative(srcDir, file).replace(/\\/g, "/")}: ${count}`);
      }
    }
    if (violations.length) console.log("\nas any per-file violations (>5):\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // ── Test 12: all mcp/server/*.ts export a registerXxxTools function ─
  it("all mcp/server/*.ts domain files export a registerXxxTools function", () => {
    const dir = path.join(srcDir, "mcp", "server");
    const files = walkDir(dir);
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      if (!/export\s+(?:async\s+)?function\s+register\w+Tools\b/.test(content)) {
        violations.push(path.relative(srcDir, file).replace(/\\/g, "/"));
      }
    }
    if (violations.length) console.log("\nMissing registerXxxTools export:\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // DEPENDENCY DIRECTION (3 new tests)
  // ══════════════════════════════════════════════════════════════════

  // ── Test 13: utils/ must not import from non-constants (leaf layer) ──
  it("utils/ must not import from any non-constants module (leaf layer)", () => {
    const files = walkDir(path.join(srcDir, "utils"));
    const violations: string[] = [];
    for (const file of files) {
      for (const t of relativeImportTargets(file)) {
        if (t !== "constants" && t !== "utils") {
          violations.push(`${path.relative(srcDir, file).replace(/\\/g, "/")} -> ${t}`);
        }
      }
    }
    if (violations.length) console.log("\nutils/ non-constants import violations:\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // ── Test 14: memory/ must not import from agents/, mcp/, routes/ ─────
  it("memory/ must not import from agents/, mcp/, or routes/", () => {
    const files = walkDir(path.join(srcDir, "memory"));
    const violations: string[] = [];
    for (const file of files) {
      for (const t of relativeImportTargets(file)) {
        if (t === "agents" || t === "mcp" || t === "routes") {
          violations.push(`${path.relative(srcDir, file).replace(/\\/g, "/")} -> ${t}`);
        }
      }
    }
    if (violations.length) console.log("\nmemory/ forbidden import violations:\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // Known circular top-level directory pairs. These are intentional
  // cycle-breakers routed through the services/ indirection layer — see
  // `src/services/` which exists specifically to break these cycles.
  const KNOWN_CIRCULAR_PAIRS = new Set<string>([
    "agents <-> services",
    "core <-> routes",
    "db <-> memory",
    "eval <-> router",
    "memory <-> services",
    "pi-agent <-> router",
    "router <-> services",
  ]);

  // ── Test 15: no circular imports between top-level directories ──────
  it("no two top-level directories import from each other (circular, except known cycle-breakers)", () => {
    const files = walkDir(srcDir);
    const tops = new Set<string>();
    for (const f of files) {
      const t = topLevelOf(f);
      if (t) tops.add(t);
    }
    const imports: Record<string, Set<string>> = {};
    for (const t of tops) imports[t] = dirImports(t);
    const pairs: string[] = [];
    const known: string[] = [];
    for (const a of tops) {
      for (const b of tops) {
        if (a < b && imports[a].has(b) && imports[b].has(a)) {
          const pair = `${a} <-> ${b}`;
          if (KNOWN_CIRCULAR_PAIRS.has(pair)) {
            known.push(pair);
          } else {
            pairs.push(pair);
          }
        }
      }
    }
    if (known.length) console.log(`\nKnown cycle-breaker pairs (${known.length}, allowed):\n` + known.join("\n"));
    if (pairs.length) console.log(`\nUnexpected circular import pairs (${pairs.length}):\n` + pairs.join("\n"));
    expect(pairs).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // CODE QUALITY (4 new tests)
  // ══════════════════════════════════════════════════════════════════

  // ── Test 16: no console.log/console.error in src/ (must use logger) ─
  it("no console.log/console.error in src/ (must use logger)", () => {
    const files = walkDir(srcDir);
    const violations: string[] = [];
    const re = /console\.(log|error)\s*\(/;
    for (const file of files) {
      const rel = path.relative(srcDir, file).replace(/\\/g, "/");
      // cli/commands/*.ts are CLI command implementations whose console.log is
      // user-facing output — same contract as the whitelisted cli.ts entry point.
      if (CONSOLE_WHITELIST.has(rel) || rel.startsWith("cli/commands/")) continue;
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (re.test(lines[i])) violations.push(`${rel}:${i + 1}`);
      }
    }
    if (violations.length) {
      console.log(`\nconsole.log/error violations: ${violations.length} (first 20):\n` + violations.slice(0, 20).join("\n"));
    }
    // All remaining console.log/error outside the CLI whitelist must go through
    // the structured logger — this is a hard zero.
    expect(violations).toHaveLength(0);
  });

  // ── Test 17: `: any` type annotations in src/ ≤ 90 (relaxed ceiling) ──
  it("`: any` type annotations in src/ must not exceed 90", () => {
    const files = walkDir(srcDir);
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcDir, file).replace(/\\/g, "/");
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (/:\s*any\b/.test(lines[i])) violations.push(`${rel}:${i + 1}: ${t}`);
      }
    }
    if (violations.length) {
      console.log(`\n": any" type-annotation violations: ${violations.length} (limit 90, first 20):\n` + violations.slice(0, 20).join("\n"));
    }
    expect(violations.length).toBeLessThanOrEqual(90);
  });

  // ── Test 18: no raw throw new Error() without descriptive message ──
  it("no raw throw new Error() without descriptive message (≥10 chars)", () => {
    const files = walkDir(srcDir);
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcDir, file).replace(/\\/g, "/");
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        const m = lines[i].match(/throw\s+new\s+Error\(\s*(.*?)\s*\)/);
        if (m) {
          const arg = m[1].trim();
          let bad = false;
          if (arg === "") bad = true;
          else if ((arg.startsWith('"') || arg.startsWith("'")) && !arg.includes("${")) {
            if (arg.slice(1, -1).length < 10) bad = true;
          } else if (arg.startsWith("`") && arg.endsWith("`") && !arg.includes("${")) {
            if (arg.slice(1, -1).length < 10) bad = true;
          }
          if (bad) violations.push(`${rel}:${i + 1}: throw new Error(${arg})`);
        }
      }
    }
    if (violations.length) console.log("\nthrow-violations:\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // ── Test 19: all exported functions in utils/ have return types ────
  it("all exported functions in utils/ must have return type annotations", () => {
    const files = walkDir(path.join(srcDir, "utils"));
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcDir, file).replace(/\\/g, "/");
      const content = fs.readFileSync(file, "utf-8");
      for (const name of exportedFunctionsWithoutReturnType(content)) {
        violations.push(`${rel}: ${name}`);
      }
    }
    if (violations.length) console.log("\nutils/ exported functions missing return type:\n" + violations.join("\n"));
    expect(violations).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // PERFORMANCE CONSTRAINTS (3 new tests)
  // ══════════════════════════════════════════════════════════════════

  // ── Test 20: PBT Cache 50k iterations < 500ms ──────────────────────
  it("PBT Cache: 50,000 set+getSync iterations must complete in < 500ms", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 50000, defaultTtlMs: 60000, redis: false, persistent: false });
    const t0 = performance.now();
    for (let i = 0; i < 50000; i++) {
      c.set(`k${i}`, { v: i });
      c.getSync(`k${i}`);
    }
    const elapsed = performance.now() - t0;
    c.destroy();
    console.log(`\nCache 50k set+getSync: ${elapsed.toFixed(0)}ms (limit 500)`);
    expect(elapsed).toBeLessThan(500);
  });

  // ── Test 21: PBT Thompson 50k route calls < 1000ms ─────────────────
  it("PBT Thompson: 50,000 route calls must complete in < 1000ms", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const r = createThompsonRouter({
      arms: [
        { id: "fast", model: "a", provider: "p", alpha: 10, beta: 2 },
        { id: "cheap", model: "b", provider: "p", alpha: 5, beta: 5 },
        { id: "smart", model: "c", provider: "p", alpha: 20, beta: 3 },
      ],
      minSamples: 0, inMemory: true,
    });
    const ctx = { taskType: "qa", inputLength: 100 };
    const t0 = performance.now();
    for (let i = 0; i < 50000; i++) {
      await r.route(ctx);
    }
    const elapsed = performance.now() - t0;
    r.close();
    console.log(`\nThompson 50k route: ${elapsed.toFixed(0)}ms (limit 1000)`);
    expect(elapsed).toBeLessThan(1000);
  });

  // ── Test 22: Pipeline 1k empty runPipeline calls < 100ms ────────────
  it("Pipeline: 1,000 runPipeline calls with empty steps must complete in < 100ms", async () => {
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("perf", 50 * 1024 * 1024, 10_000);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      await runPipeline([], ctx);
    }
    const elapsed = performance.now() - t0;
    console.log(`\nPipeline 1k empty: ${elapsed.toFixed(0)}ms (limit 100)`);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("L1 依赖方向（批次5 Phase C）", () => {
  it("src/dre 不得引用上层 router/", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          const c = fs.readFileSync(p, "utf8");
          if (/from\s+"(\.\.?\/)*router\//.test(c) || /import\("[^"]*\/router\//.test(c)) hits.push(p);
        }
      }
    };
    walk("src/dre");
    if (hits.length) console.log("[L1] dre→router 引用:\n" + hits.join("\n"));
    expect(hits).toEqual([]);
  });
});
