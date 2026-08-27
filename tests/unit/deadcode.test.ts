import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

function countReasoningRuntimeInDocs(): number {
  let count = 0;
  const hits: string[] = [];
  const excludeDirs = new Set(["archive", "reviews", "superpowers"]);
  const excludeFiles = new Set(["operations-log.md"]);
  function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || excludeDirs.has(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith(".md")) {
        if (excludeFiles.has(e.name)) continue;
        const c = readFileSync(p, "utf8");
        if (c.includes("reasoning-runtime")) {
          const lines = c.split("\n");
          lines.forEach((line, idx) => {
            if (line.includes("reasoning-runtime")) {
              hits.push(`${p}:${idx + 1}:${line.trim()}`);
              count++;
            }
          });
        }
      }
    }
  }
  walk("docs");
  if (hits.length > 0) {
    // eslint-disable-next-line no-console
    console.log("[deadcode] hits:\n" + hits.join("\n"));
  }
  return count;
}

describe("deadcode Task15 — reasoning-runtime 死引用", () => {
  test("grep reasoning-runtime docs/ 命中应为 0 (文件已不存在 src/dre/runtime/reasoner/reasoning-runtime.ts)", () => {
    const n = countReasoningRuntimeInDocs();
    expect(n).toBe(0);
  });

  test("src/dre/runtime/reasoner/reasoning-runtime.ts 应不存在", async () => {
    const { existsSync } = await import("fs");
    expect(existsSync("src/dre/runtime/reasoner/reasoning-runtime.ts")).toBe(false);
  });
});
