import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";

const srcDir = path.resolve(import.meta.dir, "../src");

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
});
