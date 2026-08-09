#!/usr/bin/env bun
/**
 * Print Axiom External MCP connection snippets for common agent hosts.
 * Read-only: does not modify global agent configs.
 */

const stdioArgs = ["run", "src/mcp/server.ts", "--external", "--stdio"];

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

console.log(`
Axiom External MCP - setup snippets
Repo: ${process.cwd()}
===================================

1. Stdio (local repository)
   bun run mcp:external -- --stdio

2. Claude Code / Codex mcp.json
${json({
  mcpServers: {
    axiom: {
      command: "bun",
      args: stdioArgs,
    },
  },
})}

3. OpenCode opencode.json
${json({
  mcp: {
    axiom: {
      type: "local",
      command: ["bun", ...stdioArgs],
      enabled: true,
    },
  },
})}

4. Codex config.toml
[mcp_servers.axiom]
command = "bun"
args = ["run", "src/mcp/server.ts", "--external", "--stdio"]

5. Kimi Code (remote HTTP)
   kimi mcp add --transport http axiom http://127.0.0.1:3001
   AXIOM_AUTH_TOKEN is required for remote connections.

6. MCP Registry manifest
   mcp/external/server.json
`);