#!/usr/bin/env bun
/**
 * External MCP cache baseline.
 *
 * Starts the real --external stdio server, measures the tool surface size,
 * and probes deterministic read-only tools for latency / output tokens.
 *
 * Usage:
 *   bun run scripts/cache-baseline.ts
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import {
  estimateToolResultTokens,
  measureToolSurface,
  summarizeLatencies,
} from "../src/components/cache-baseline.js";
import {
  closeExternalMcpClients,
  connectExternalMcpServers,
  getMcpClientStats,
} from "../src/mcp/client-connector.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";

const ROUNDS = Number(process.argv.find((arg) => arg.startsWith("--rounds="))?.split("=")[1] ?? 3);
const CONFIG_PATH = `.tmp/cache-baseline-${process.pid}.yaml`;

interface ProbeResult {
  tool: string;
  summary: ReturnType<typeof summarizeLatencies>;
  outputBytes: number;
  outputTokens: number;
  sample: string;
  error?: string;
}

const PROBES: Array<{ tool: string; args?: Record<string, unknown> }> = [
  { tool: "search_engines_list", args: {} },
  { tool: "skill_list", args: {} },
  { tool: "token_stats", args: {} },
  { tool: "memory_search", args: { query: "axiom", limit: 3 } },
  { tool: "kal_query", args: { query: "axiom", limit: 3 } },
];

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function runProbe(
  handler: (args: Record<string, unknown>) => Promise<unknown>,
  tool: string,
  args: Record<string, unknown> | undefined,
): Promise<ProbeResult> {
  const latencies: number[] = [];
  let lastText = "";
  let lastBytes = 0;
  let lastTokens = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const start = performance.now();
    const result = await handler(args ?? {});
    latencies.push(performance.now() - start);
    lastText = JSON.stringify(result);
    lastBytes = Buffer.byteLength(lastText, "utf8");
    lastTokens = estimateToolResultTokens(lastText);
  }
  return {
    tool,
    summary: summarizeLatencies(latencies),
    outputBytes: lastBytes,
    outputTokens: lastTokens,
    sample: lastText.slice(0, 200),
  };
}

async function main(): Promise<void> {
  await Bun.write(CONFIG_PATH, [
    "servers:",
    "  axiom-external:",
    '    command: "bun"',
    '    args: ["run", "src/mcp/server.ts", "--external", "--stdio"]',
    "",
  ].join("\n"));

  const registry = new ToolRegistry({ guard: async () => {} });
  const summary = await connectExternalMcpServers(registry, {
    configPath: CONFIG_PATH,
    timeoutMs: 20000,
  });

  if (summary.connected.length !== 1) {
    throw new Error(`external MCP connection failed: ${JSON.stringify(summary.failed)}`);
  }

  const handlers = registry.buildHttpHandlers();
  const probes: ProbeResult[] = [];
  for (const probe of PROBES) {
    const name = `mcp_axiom-external_${probe.tool}`;
    const handler = handlers[name];
    if (!handler) {
      probes.push({
        tool: probe.tool,
        summary: summarizeLatencies([]),
        outputBytes: 0,
        outputTokens: 0,
        sample: "",
        error: `tool ${name} not exposed`,
      });
      continue;
    }
    try {
      probes.push(await runProbe(handler, probe.tool, probe.args));
    } catch (error) {
      probes.push({
        tool: probe.tool,
        summary: summarizeLatencies([]),
        outputBytes: 0,
        outputTokens: 0,
        sample: "",
        error: (error as Error).message,
      });
    }
  }

  const surface = measureToolSurface(registry.getToolsMeta());
  const report = {
    timestamp: new Date().toISOString(),
    gitCommit: gitCommit(),
    bunVersion: Bun.version,
    platform: `${process.platform}/${process.arch}`,
    mode: "external-mcp-stdio-cache-baseline",
    connected: summary.connected,
    rounds: ROUNDS,
    toolSurface: surface,
    probes,
    clientStats: getMcpClientStats(),
    notes: [
      "No provider calls in this baseline.",
      "Tool surface bytes/tokens estimate the stable prefix sent to every session.",
      "Probe output tokens estimate inline result cost before RecoverableToolOutput.",
    ],
  };

  await mkdir("reports/cache", { recursive: true });
  const timestamp = report.timestamp.replace(/[:.]/g, "-");
  const reportPath = `reports/cache/${timestamp}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile("reports/cache/latest.json", JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`report saved: ${reportPath}`);

  const failedProbes = probes.filter((probe) => probe.error);
  await closeExternalMcpClients();
  await Bun.file(CONFIG_PATH).delete().catch(() => {});
  if (failedProbes.length > 0) {
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error("cache-baseline fatal error:", error);
  await closeExternalMcpClients().catch(() => {});
  await Bun.file(CONFIG_PATH).delete().catch(() => {});
  process.exit(2);
});