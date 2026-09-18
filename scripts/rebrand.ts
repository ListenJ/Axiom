/**
 * Axiom → Axiom Runtime Rebrand Script
 *
 * 执行:
 *   bun run scripts/rebrand.ts
 *
 * 规则:
 * - Axiom  → Axiom        (大写，品牌名)
 * - axiom  → axiom         (小写，路径/包名)
 * - OPENCLAW_ → AXIOM_        (环境变量前缀)
 * - axiom-runtime.ai → axiom-runtime.ai
 * - AxiomError → AxiomError  (错误类名)
 * - toAxiomError → toAxiomError
 *
 * 跳过:
 * - archive/ 目录
 * - node_modules/
 * - frontend/dist/ (构建产物)
 * - frontend/coverage/
 * - eval-results/
 * - .git/ 目录
 * - bun.lock
 */

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";

const REPLACEMENTS: Array<{ from: RegExp | string; to: string; description: string }> = [
  // Environment vars (must come before case-insensitive axiom replaces)
  { from: "AXIOM_GATEWAY_PORT", to: "AXIOM_GATEWAY_PORT", description: "env: gateway port" },
  { from: "AXIOM_AUTH_TOKEN", to: "AXIOM_AUTH_TOKEN", description: "env: auth token" },
  { from: "AXIOM_EDITION", to: "AXIOM_EDITION", description: "env: edition" },
  { from: "AXIOM_NATIVE", to: "AXIOM_NATIVE", description: "env: native flag" },
  { from: "AXIOM_PLUGIN_DIR", to: "AXIOM_PLUGIN_DIR", description: "env: plugin dir" },
  { from: "AXIOM_BIND", to: "AXIOM_BIND", description: "env: bind address" },
  { from: "AXIOM_MODE", to: "AXIOM_MODE", description: "env: mode" },

  // Error classes
  { from: "AxiomError", to: "AxiomError", description: "class: AxiomError" },
  { from: "toAxiomError", to: "toAxiomError", description: "function: toAxiomError" },
  { from: "axiomError", to: "axiomError", description: "var: axiomError" },
  { from: "axiomErr", to: "axiomErr", description: "var: axiomErr" },

  // Domains
  { from: "axiom-runtime.ai", to: "axiom-runtime.ai", description: "domain: axiom-runtime.ai" },
  { from: "axiom-runtime.dev", to: "axiom-runtime.dev", description: "domain: axiom-runtime.dev" },

  // Brand names (capitalized)
  { from: /Axiom(?!Error)/g, to: "Axiom", description: "brand: Axiom → Axiom" },

  // Lowercase path references
  { from: "axiom-runtime", to: "axiom-runtime", description: "repo: axiom-runtime" },
  { from: "axiom-agent", to: "axiom-agent", description: "pkg: axiom-agent" },
  { from: "axiom-frontend", to: "axiom-frontend", description: "pkg: axiom-frontend" },
  { from: "axiom-lightpanda", to: "axiom-lightpanda", description: "docker: axiom-lightpanda" },
  { from: "axiom-cloud", to: "axiom-cloud", description: "binary: axiom-cloud" },
  { from: "axiom-local", to: "axiom-local", description: "binary: axiom-local" },

  // Storage prefixes
  { from: "axiom:", to: "axiom:", description: "prefix: axiom:" },
  { from: "axiom-eval", to: "axiom-eval", description: "prefix: axiom-eval" },

  // Fallback for remaining lowercase
  { from: "axiom", to: "axiom", description: "text: axiom" },
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", "archive", "frontend/dist",
  "frontend/coverage", "eval-results", "data",
]);

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md",
  ".yaml", ".yml", ".html", ".css", ".env",
  "Dockerfile", "Dockerfile.lightpanda", ".gitignore",
]);

function shouldProcess(filePath: string): boolean {
  // Check skip dirs
  for (const dir of SKIP_DIRS) {
    if (filePath.replace(/\\/g, "/").includes(`/${dir}/`)) return false;
  }
  if (filePath.includes("bun.lock")) return false;

  const base = filePath.split(/[/\\]/).pop() || "";
  // Check extensions or special files
  const ext = base.includes(".") ? "." + base.split(".").pop() : base;
  if (ext === "Dockerfile" || ext === "Dockerfile.lightpanda") return true;
  if (EXTENSIONS.has(ext)) return true;
  if (base === ".gitignore") return true;
  return false;
}

function processFile(filePath: string): number {
  try {
    let content = readFileSync(filePath, "utf-8");
    let original = content;
    let changed = false;

    for (const { from, to } of REPLACEMENTS) {
      if (typeof from === "string") {
        if (content.includes(from)) {
          content = content.split(from).join(to);
          changed = true;
        }
      } else {
        if (from.test(content)) {
          content = content.replace(from, to);
          changed = true;
        }
      }
    }

    if (changed && content !== original) {
      writeFileSync(filePath, content, "utf-8");
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`  ERROR: ${filePath}: ${(err as Error).message}`);
    return 0;
  }
}

function walkDir(dir: string, changed: string[]): void {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkDir(full, changed);
    } else if (shouldProcess(full)) {
      const count = processFile(full);
      if (count > 0) changed.push(full);
    }
  }
}

// ========== MAIN ==========

console.log("🔧 Axiom Runtime Rebrand Script");
console.log("================================\n");

const changed: string[] = [];
const root = process.cwd();

console.log("Scanning files...");
walkDir(root, changed);

console.log(`\n✅ Changed ${changed.length} files:\n`);
for (const f of changed) {
  console.log(`  ${f.replace(root, "")}`);
}

// Rename config file
const oldConfigPath = join(root, "config", "axiom.yaml");
const newConfigPath = join(root, "config", "axiom.yaml");
if (existsSync(oldConfigPath)) {
  renameSync(oldConfigPath, newConfigPath);
  console.log(`\n📁 Renamed: config/axiom.yaml → config/axiom.yaml`);
}

// Rename deploy file
const oldServicePath = join(root, "deploy", "systemd", "axiom.service");
const newServicePath = join(root, "deploy", "systemd", "axiom.service");
if (existsSync(oldServicePath)) {
  renameSync(oldServicePath, newServicePath);
  console.log(`📁 Renamed: deploy/systemd/axiom.service → deploy/systemd/axiom.service`);
}

// Special: Rename agent configs
const oldAgentConf = join(root, "src", "agents", "consciousness", "README.md");
// already processed as part of walk

console.log("\n🎉 Rebrand complete! Run `bun test` to verify.");
