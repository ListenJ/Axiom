/**
 * Restore src/router/models.ts from git HEAD and split into the models/ directory.
 * Uses Bun.spawn to invoke git, which preserves UTF-8 bytes correctly.
 */
import { spawnSync } from "bun";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "src/router/models.original.ts");
const REG = resolve(ROOT, "src/router/models/registry.ts");

const proc = spawnSync({
  cmd: ["git", "show", "HEAD:src/router/models.ts"],
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
});
if (proc.exitCode !== 0) {
  console.error("git show failed:", proc.stderr.toString());
  process.exit(1);
}
const raw = proc.stdout;
writeFileSync(OUT, raw);

const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
console.log(`Restored: ${text.split("\n").length} lines`);

const dataMarker = "Unified Model Registry \u2014 All models in one place";
const helperMarker = "Convenience lookups";

const dataIdx = text.indexOf(dataMarker);
if (dataIdx < 0) throw new Error("data marker not found");
const helperIdx = text.indexOf(helperMarker);
if (helperIdx < 0) throw new Error("helper marker not found");

const boxTopData = text.lastIndexOf("// \u2550", dataIdx);
if (boxTopData < 0) throw new Error("data box-top not found");
const dataBlock = text.slice(boxTopData, helperIdx);

const helperBoxTop = text.lastIndexOf("// \u2550", helperIdx);
if (helperBoxTop < 0) throw new Error("helper box-top not found");
const helperBlock = text.slice(helperBoxTop);

const HEADER = `// src/router/models/registry.ts
// Unified Model Registry \u2014 Single source of truth for all model metadata
// Consumers: model-router.ts, tool-pool.ts, model-capability-registry.ts
// Updated: 2026-06-05 with real data from OpenRouter API & OfoxAI
//
// Phase B.3 split: types + provider configs moved to sibling files. This
// file now contains ONLY the UNIFIED_REGISTRY data array and the lookup
// helpers that operate on it. Backward-compatible: re-exported via
// \`../models.js\` and \`./index.js\`.

import type { ModelProvider, ProviderConfig, TaskRole, UnifiedModel } from "./types.js";
import { PROVIDER_CONFIG } from "./providers.js";

`;

const content = HEADER + dataBlock + helperBlock + "\n";
writeFileSync(REG, content, "utf8");
console.log(`registry.ts: ${content.split("\n").length} lines`);

unlinkSync(OUT);
console.log("Removed src/router/models.original.ts");