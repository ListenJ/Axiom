---
name: axiom-external-mcp
description: Use the Axiom external MCP component for knowledge search, web search, skill discovery, token statistics and knowledge graph queries from any MCP-capable agent.
---

# Axiom External MCP

Axiom exposes a restricted MCP server so other agents can reuse its knowledge base, network search, skills, and context tooling without taking over Axiom's internal toolchain.

## Install

### Stdio

Run in the Axiom repository:

```bash
bun run mcp:external -- --stdio
```

Add to Claude Code / Codex:

```json
{
  "mcpServers": {
    "axiom": {
      "command": "bun",
      "args": ["run", "src/mcp/server.ts", "--external", "--stdio"]
    }
  }
}
```

### Remote HTTP

```bash
AXIOM_AUTH_TOKEN=your-token bun run mcp:external
```

Clients connect to `http://127.0.0.1:3001` with `x-api-key: your-token`.

## Tools

- `memory_search` - deterministic Vault memory search
- `memory_read` - read a Vault note
- `web_search` - multi-engine web search
- `search_engines_list` - list available search engines
- `skill_list` - list loaded skills
- `token_stats` - token usage statistics
- `kal_query` - unified knowledge graph / vault query
- `read_tool_result` - read an externalized large tool result by `toolId`
- `recoverable_output_stats` - externalized output storage statistics

## Configuration

- `AXIOM_EXTERNAL_RECOVERABLE_THRESHOLD` - outputs above this byte size are stored and returned as a placeholder (default `8192`).
- `AXIOM_EXTERNAL_RECOVERABLE_MAX_ENTRIES` - maximum stored outputs (default `1000`).
- `AXIOM_EXTERNAL_RECOVERABLE_TTL_MS` - stored output lifetime in milliseconds (default `3600000`).

## Security

Read-only tools are exposed by default. Write and execution tools stay internal unless explicitly enabled.