# Axiom Comprehensive Guide — Architecture with Code

> **Last updated:** 2026-07-11 | **Version:** 4.0.0
> This document traces Axiom's architecture through actual code paths, from request lifecycle to test infrastructure.

---

## Section 1: Request Lifecycle

### 1.1 Server Startup — `Bun.serve()`

Everything begins in `src/main.ts:442` where the HTTP server is created:

```typescript
// src/main.ts:442-449
const server = Bun.serve({
  port,
  hostname: readString("HOST", "127.0.0.1"),
  async fetch(req, server) {
    const startTime = performance.now();
    const url = new URL(req.url);
    const requestOrigin = req.headers.get("origin") || "";
    const baseHeaders = { ...securityHeaders, ...corsHeaders(requestOrigin) };
```

Each request enters this single `fetch` handler. Before the Trie-based router is invoked, the request passes through:

1. **CORS** — OPTIONS requests return immediately (`main.ts:451`)
2. **Auth gate** — `checkApiKey()` verifies `x-api-key` or `Authorization` header (`main.ts:454`)
3. **WebSocket** — `/ws` path upgraded to WS protocol (`main.ts:459`)
4. **Rate limiting** — sliding window check (`main.ts:472`)
5. **Body size** — POST/PUT bodies checked against `MAX_BODY_SIZE` (`main.ts:478`)

### 1.2 Route Registration — `registerTrieRoutes()`

At startup, routes register into the `HttpRouter` via `src/routes/index.ts:181`:

```typescript
// src/main.ts:340-343
const httpRouter = getHttpRouter();
registerTrieRoutes(httpRouter);
logger.info("[HttpRouter] Trie routes registered", { count: httpRouter.getRoutes().length });
```

The registration function defines an array of `RouteRecord` objects:

```typescript
// src/routes/index.ts:179-229
import { HttpRouter, type RouteRecord } from "../core/http-router.js";

export function registerTrieRoutes(engine: HttpRouter): void {
  const routes: RouteRecord[] = [
    // Health & system
    { method: "GET", path: "/health", handler: handleHealth },
    { method: "GET", path: "/metrics", handler: handleMetrics },
    // ... more routes
    { method: "GET", path: "/vault/para/:category", handler: handleVaultPara },
    { method: "GET", path: "/vault/tags/:tag", handler: handleVaultTags },
    { method: "POST", path: "/vault/write", handler: handleVaultWrite },
  ];
  engine.registerBatch(routes);
}
```

### 1.3 Trie Matching — `HttpRouter`

The `HttpRouter` (`src/core/http-router.ts:64`) builds a prefix tree keyed by HTTP method. `register()` splits the path on `/` and walks/creates nodes:

```typescript
// src/core/http-router.ts:87-119
register(record: RouteRecord): void {
  const { method, path } = record;
  const methodLower = method.toUpperCase();
  if (!this.root.has(methodLower)) {
    this.root.set(methodLower, { children: new Map() });
  }
  const trie = this.root.get(methodLower)!;
  const segments = path.split("/").filter(Boolean);
  let node = trie;
  for (const seg of segments) {
    if (seg.startsWith(":")) {
      if (!node.children.has(":")) {
        node.children.set(":", { children: new Map(), param: seg.slice(1) });
      }
      node = node.children.get(":")!;
    } else if (seg === "**") {
      node.wildcard = record;
      return;
    } else {
      if (!node.children.has(seg)) {
        node.children.set(seg, { children: new Map() });
      }
      node = node.children.get(seg)!;
    }
  }
  node.handler = record;
}
```

The `execute()` method (line 173) ties caching, matching, and handler invocation:

```typescript
// src/core/http-router.ts:173-234
async execute(ctx: RouteContext): Promise<Response | null> {
  const { req, url } = ctx;
  const cacheKey = `${method}:${pathname}:${url.search}`;

  // Step 1: Cache hit (GET only)
  if (method === "GET") {
    const cached = await this.cache.get(cacheKey);
    if (cached) { this.cacheHits++; return cached; }
  }

  // Step 2: Trie match
  const matched = this.match(method, pathname);

  // Step 3: Execute with performance timing
  const startTime = performance.now();
  const response = await record.handler(ctx);
  const latency = performance.now() - startTime;
  this.recordPerf(endpointKey, latency);
  // Cache the response
  if (method === "GET" && response && record.meta?.cacheable !== false && response.status < 400) {
    this.cache.set(cacheKey, response, record.meta?.cacheTtlMs ?? 30 * 1000);
  }
  return response;
}
```

The `match()` method (line 130) walks segment-by-segment: literal match first, then `:param` fallback, then `/**` wildcard:

```typescript
// src/core/http-router.ts:130-167
match(method: string, path: string): { record: RouteRecord; params: Record<string, string> } | null {
  const trie = this.root.get(method.toUpperCase());
  if (!trie) return null;

  const segments = path.split("/").filter(Boolean);
  let node = trie;
  const params: Record<string, string> = {};

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (node.children.has(seg)) {
      node = node.children.get(seg)!;
    } else if (node.children.has(":")) {
      const paramNode = node.children.get(":")!;
      if (paramNode.param) params[paramNode.param] = decodeURIComponent(seg);
      node = paramNode;
    } else if (node.wildcard) {
      return { record: node.wildcard, params };
    } else {
      return null;
    }
  }
  if (node.handler) return { record: node.handler, params };
  if (node.wildcard) return { record: node.wildcard, params };
  return null;
}
```

### 1.4 Handler Example — `/health`

The health handler at `src/routes/health.ts:6` receives `RouteContext` and returns a JSON response:

```typescript
// src/routes/health.ts:6-27
export async function handleHealth(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/health" && ctx.req.method === "GET") {
    const checks = await ctx.healthMonitor.checkAll();
    const { vaultStatsCache } = await import("../utils/vault-stats-cache.js");
    const vStats = vaultStatsCache.read();
    const { searchAggregator } = await import("../crawl/search-engines.js");
    const { searchCache, crawlCache } = await import("../utils/cache.js");
    const { wsManager } = await import("../utils/websocket.js");

    return ctx.jsonResponse({
      status: "ok", timestamp: new Date().toISOString(), version: "2.2.0",
      uptime: Math.floor((Date.now() - ctx.startupTime) / 1000),
      checks, searchEngines: searchAggregator.listEngines(),
      vault: vStats ? { notes: vStats.totalNotes, words: vStats.totalWords } : null,
      cache: { search: searchCache.stats(), crawl: crawlCache.stats() },
      websocket: wsManager.getStats(),
    }, 200, ctx.baseHeaders);
  }
  return null;
}
```

### 1.5 `RouteContext` Construction

The context is built inline in the fetch handler (`main.ts:488-491`):

```typescript
// src/main.ts:488-491
const ctx: RouteContext = {
  url, req, vault, db, pipeline, healthMonitor, fileWatcher,
  startupTime, baseHeaders, jsonResponse,
};
```

The type is defined at `src/routes/types.ts:11`:

```typescript
// src/routes/types.ts:11-22
export interface RouteContext {
  url: URL;
  req: Request;
  vault: VaultManager | null;
  db: Database;
  pipeline: DataPipeline;
  healthMonitor: HealthMonitor;
  fileWatcher: VaultFileWatcher | null;
  startupTime: number;
  baseHeaders: Record<string, string>;
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response;
}
```

After the Trie router, there is a fallback chain (`main.ts:496-508`):
1. `serveStaticFile(url.pathname)` — SPA assets from `./public/`
2. `httpRouter.execute(ctx)` — Trie-based routing
3. `dispatch(ctx)` — legacy linear fallback
4. `defaultResponse(ctx)` — 404

---

## Section 2: Vault Write → Read Flow

### 2.1 Writing a Note — `writeNote()`

The `VaultManager.writeNote()` method at `src/memory/vault-manager.ts:171` is the central write path:

```typescript
// src/memory/vault-manager.ts:171-231
async writeNote(notePath: string, content: string, opts: WriteNoteOptions = {}): Promise<string> {
  // Smart gate: skip low-value writes if context provided
  if (opts.gateContext) {
    const gate = getMemoryGate();
    const decision = gate.shouldWrite(content, content, opts.gateContext);
    if (!decision.shouldWrite) {
      logger.info("[MemoryGate] Write skipped", { path: notePath, reason: decision.reason, category: decision.category });
      return notePath;
    }
  }

  const fullPath = this.resolveSafePath(notePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const frontmatter = this.buildFrontmatter({ ...opts, created: now });

  let finalContent: string;
  const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : null;

  if (opts.append && existing) {
    const { body } = this.parseFrontmatter(existing);
    finalContent = frontmatter + "\n\n" + body + "\n\n" + content;
  } else if (opts.overwrite || !existing) {
    finalContent = frontmatter + "\n\n" + content;
  } else {
    throw new Error(`Note already exists: ${notePath} (use overwrite=true or append=true)`);
  }

  fs.writeFileSync(fullPath, finalContent, "utf-8");

  // Sync to SQLite index + FTS
  const stat = fs.statSync(fullPath);
  this.sqliteMemory.upsertNote({
    path: notePath,
    title: opts.title || path.basename(notePath, ".md"),
    content: finalContent,
    excerpt: finalContent.slice(0, 500).replace(/\n/g, " "),
    tags: opts.tags || [],
    paraCategory: opts.paraCategory || "resources",
    type: opts.type || "note",
    source: opts.source,
    confidence: opts.confidence ?? 0.7,
    createdAt: stat.birthtimeMs || stat.ctimeMs,
    updatedAt: stat.mtimeMs,
  });

  if (opts.gateContext) {
    const gate = getMemoryGate();
    const hash = `${notePath}:${content.slice(0, 200)}`;
    gate.recordWrite(hash, notePath);
  }

  logger.info("Vault note written", { path: notePath, type: opts.type });
  return notePath;
}
```

### 2.2 Path Safety — `resolveSafePath()`

Path traversal is blocked at `src/memory/vault-manager.ts:661`:

```typescript
// src/memory/vault-manager.ts:661-669
private resolveSafePath(notePath: string): string {
  const resolved = path.resolve(this.config.vaultPath, notePath);
  const base = path.resolve(this.config.vaultPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || relative === "..") {
    throw new Error(`Path traversal blocked: ${notePath}`);
  }
  return resolved;
}
```

### 2.3 Frontmatter Construction — `buildFrontmatter()`

YAML frontmatter is built at `src/memory/vault-manager.ts:671` with ordered keys:

```typescript
// src/memory/vault-manager.ts:671-696
private buildFrontmatter(opts: Record<string, unknown>): string {
  const fmKeys = ["title", "type", "created", "updated", "source", "tags", "confidence"];
  const fmEntries: Array<[string, unknown]> = [];
  const extraEntries: Array<[string, unknown]> = [];

  // Single-pass partition: ordered keys first, rest after
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) continue;
    if (fmKeys.includes(k)) fmEntries.push([k, v]);
    else extraEntries.push([k, v]);
  }

  fmEntries.sort((a, b) => fmKeys.indexOf(a[0]) - fmKeys.indexOf(b[0]));

  const formatVal = (val: unknown): string => {
    if (Array.isArray(val)) return `[${val.map((v) => `"${v}"`).join(", ")}]`;
    return String(val);
  };

  const lines: string[] = ["---"];
  for (const [k, v] of fmEntries) lines.push(`${k}: ${formatVal(v)}`);
  for (const [k, v] of extraEntries) lines.push(`${k}: ${formatVal(v)}`);
  lines.push("---");
  return lines.join("\n");
}
```

### 2.4 Reading a Note — `readNote()`

The read path at `vault-manager.ts:138` reads from disk (the source of truth):

```typescript
// src/memory/vault-manager.ts:138-148
readNote(notePath: string): { content: string; frontmatter: Record<string, unknown> } | null {
  try {
    const fullPath = this.resolveSafePath(notePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const { frontmatter, body } = this.parseFrontmatter(content);
    return { content: body, frontmatter };
  } catch (e) {
    logger.warn("readNote failed", { path: notePath, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
```

### 2.5 Searching — SQLite FTS5 + Deterministic Fallback

The `search()` method at `vault-manager.ts:84` uses a two-tier strategy:

```typescript
// src/memory/vault-manager.ts:84-121
search(query: string, opts?: { limit?: number; types?: string[]; tags?: string[]; paraCategory?: string }): SearchResult[] {
  const limit = opts?.limit ?? 10;

  // 1. SQLite FTS5 search (primary)
  const ftsResults = this.sqliteMemory.search(query, {
    limit, tags: opts?.tags, paraCategory: opts?.paraCategory, type: opts?.types?.[0],
  });

  let results: SearchResult[] = ftsResults.map((r) => ({
    note: this.memoryRecordToVaultNote(r.record),
    score: r.score, reasons: ["fts5-match"], excerpt: r.excerpt,
  }));

  // 2. Fallback: DeterministicSearchEngine when FTS results are insufficient
  const minResults = 3;
  const minQuality = -2.0;
  const needsFallback = results.length < minResults ||
    (results.length > 0 && results[0].score > minQuality);
  if (needsFallback) {
    const fallback = this.engine.search(query, opts);
    const seen = new Set(results.map((r) => r.note.path));
    for (const r of fallback) {
      if (!seen.has(r.note.path)) {
        results.push(r);
        seen.add(r.note.path);
      }
    }
    results = results.slice(0, limit);
  }
  return results;
}
```

### 2.6 Archiver's `parseFrontmatter()` — Cross-Platform Line Endings

The archiver at `src/memory/archiver.ts:227` normalizes `\r\n` before parsing:

```typescript
// src/memory/archiver.ts:227-250
private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: {}, body: normalized };

  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        fm[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      } else if (val === "true") {
        fm[key] = true;
      } else if (val === "false") {
        fm[key] = false;
      } else {
        fm[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }
  return { frontmatter: fm, body: normalized.slice(match[0].length).trim() };
}
```

Compare with the vault-manager's local `parseFrontmatter()` at line 698 — it uses `\n` in the regex without normalization. The archiver is the cross-platform-correct version.

### 2.7 `getGlobalVault()` Singleton

The singleton at `src/memory/vault-manager.ts:753` is the single entry point:

```typescript
// src/memory/vault-manager.ts:753-759
let _globalVault: VaultManager | null = null;
export function getGlobalVault(): VaultManager {
  if (!_globalVault) {
    _globalVault = new VaultManager();
  }
  return _globalVault;
}
```

This is used instead of `new VaultManager()` throughout the codebase to ensure one instance per process.

---

## Section 3: MCP Tool Registration & Execution

### 3.1 Server Structure — `mcp/server.ts`

The MCP server is created at `src/mcp/server.ts:57`:

```typescript
// src/mcp/server.ts:57-64
const mcp = new McpServer({
  name: "Axiom Agent MCP Server",
  version: "2.9.2",
});

const registry = new ToolRegistry();
```

It supports both stdio and HTTP transport (line 387):

```typescript
// src/mcp/server.ts:387-461
const transport = process.argv.includes("--stdio") ? "stdio" : "http";

if (transport === "stdio") {
  registry.registerWithMcp(mcp);
  const stdio = new StdioServerTransport();
  mcp.connect(stdio);
} else {
  const toolHandlers = registry.buildHttpHandlers();
  const toolsMeta = registry.getToolsMeta();
  const port = Number(readString("MCP_PORT", "3001"));

  Bun.serve({
    port,
    async fetch(req) {
      // JSON-RPC 2.0 over HTTP for tools/list and tools/call
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { tools: toolsMeta },
        });
      }
      if (body.method === "tools/call") {
        const { name, arguments: args } = body.params;
        const handler = toolHandlers[name];
        const result = await withTimeout(
          withRetry(() => handler(args || {}), { maxAttempts: 2, baseDelay: 500 }),
          TIMEOUTS.MCP_TOOL_DEFAULT
        );
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] },
        });
      }
    },
  });
}
```

### 3.2 ToolRegistry

The registry (`src/mcp/tool-registry.ts:28`) stores `ToolDef` entries and provides dual registration:

```typescript
// src/mcp/tool-registry.ts:28-35
export class ToolRegistry {
  private tools: ToolDef[] = [];

  add(tool: ToolDef): this {
    this.tools.push(tool);
    return this;
  }

  registerWithMcp(mcp: McpServer): void {
    for (const tool of this.tools) {
      mcp.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
      }, async (args) => {
        const result = await tool.handler(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      });
    }
  }

  buildHttpHandlers(): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {};
    for (const tool of this.tools) {
      handlers[tool.name] = tool.handler;
    }
    return handlers;
  }
}
```

### 3.3 The `registerVaultTools(registry, vault)` Pattern

All domain files follow the same convention. From `src/mcp/server.ts:74`:

```typescript
// src/mcp/server.ts:18
import { registerVaultTools, registerWebTools } from "./server/vault-tools.js";
// ...
registerVaultTools(registry, vault);
registerWebTools(registry, pipeline);
registerGitHubTools(registry);
```

A typical domain registration (from the `vault-tools.ts` pattern at `src/mcp/server`):

```typescript
// Example pattern — actual content from server/vault-tools.ts
export function registerVaultTools(registry: ToolRegistry, vault: VaultManager): void {
  registry.add({
    name: "memory_search",
    description: "Deterministic search Vault memory notes",
    inputSchema: { query: z.string() },
    handler: async (args) => vault.search(args.query as string),
  });
}
```

### 3.4 `adaptTool` Bridge

The adapt tool at `src/mcp/adapt-tool.ts:17` bridges `Tool<I,O>` (pipeline) to `ToolDef` (MCP):

```typescript
// src/mcp/adapt-tool.ts:17-45
export function adaptTool<I, O>(
  tool: Tool<I, O>,
  overrides?: Partial<Pick<ToolDef, "tags" | "format">>,
): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.object({}).passthrough(),
    handler: async (args: Record<string, unknown>): Promise<O> => {
      // Runtime validation
      if (tool.validate) {
        const err = tool.validate(args as I);
        if (err) throw new Error(`Validation failed for ${tool.name}: ${err}`);
      }

      const pipelineCtx = createToolContext(`mcp-${tool.name}-${Date.now()}`);
      const output = await tool.execute({ payload: args as I, context: pipelineCtx });

      logger.debug(`[adaptTool] ${tool.name} completed`, {
        durationMs: output.metrics.durationMs,
        computeUnits: output.metrics.computeUnits,
      });

      return output.data;
    },
    format: overrides?.format ?? "json",
    tags: overrides?.tags ?? ["pipeline"],
  };
}
```

Used in `server.ts:72` to inject pipeline-aware tools:

```typescript
// src/mcp/server.ts:72
for (const td of adaptTools([readTool, writeTool, queryTool])) registry.add(td);
```

### 3.5 Complete Tool Handler Example — `serpapi_search`

The full serpapi_search tool at `src/mcp/server.ts:80` shows the complete registration pattern:

```typescript
// src/mcp/server.ts:80-149
registry.add({
  name: "serpapi_search",
  description: "Use SerpAPI to execute Google deep search, results saved to Vault as structured Markdown with full raw JSON",
  inputSchema: {
    query: z.string().describe("Search query"),
    location: z.string().optional().describe("Geographic location"),
    lang: z.string().optional().default("en").describe("Interface language"),
    num: z.number().optional().default(10).describe("Number of results 1-100"),
    saveToVault: z.boolean().optional().default(true).describe("Whether to save to Vault"),
  },
  handler: async (args) => {
    const client = new SerpApiClient();
    const start = performance.now();
    const response = await client.search({
      q: args.query as string,
      hl: args.lang as string,
      num: Math.min((args.num as number) || 10, 100),
    });
    const latency = Math.round(performance.now() - start);

    let vaultPath = "";
    if (args.saveToVault !== false) {
      vaultPath = await vault.writeSerpApiResult(args.query as string, response as Record<string, unknown>, {
        latencyMs: latency,
      });
    }

    return {
      query: args.query, search_id: response.search_metadata?.id ?? null,
      organic_count: response.organic_results?.length ?? 0,
      knowledge_graph: !!response.knowledge_graph,
      latency_ms: latency, vault_path: vaultPath || null,
    };
  },
});
```

---

## Section 4: Memory System Deep Dive

### 4.1 Frontmatter Parsing — The `\r\n` Problem

Two `parseFrontmatter()` implementations exist. The vault-manager version (`vault-manager.ts:698`) uses `\n` directly:

```typescript
// src/memory/vault-manager.ts:698-700
private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
```

The archiver version (`archiver.ts:227`) normalizes first, making it correct for Windows line endings:

```typescript
// src/memory/archiver.ts:227-229
private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
```

Both parse YAML-like key-value pairs manually without a YAML library for performance. Array values like `[a, b, c]` and booleans (`true`/`false`) are handled, but nested objects are not.

### 4.2 `safeHostname()` — Safe URL Parsing

The distiller's `safeHostname()` at `src/memory/distiller.ts:18` returns a fallback when URL parsing fails:

```typescript
// src/memory/distiller.ts:18-26
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Strip protocol-less strings like "localhost" or "example.com/foo"
    const cleaned = url.replace(/^https?:\/\//, "").split("/")[0].split("?")[0];
    return cleaned || url;
  }
}
```

Used in `extractFromWebContent()` (line 179) to label code snippets with their source domain:

```typescript
// src/memory/distiller.ts:178-183
ideas.push({
  title: `Code Fragment #${codeIndex} (${sourceUrl ? safeHostname(sourceUrl) : "web"})`,
  content: `\`\`\`\n${code}\n\`\`\``,
  reason: "Valuable code reference",
});
```

### 4.3 Memory Gate — Null Context Guard

The `SignificanceContext` behind `shouldWrite()` at `src/memory/memory-gate.ts:107` contains a defensive null check:

```typescript
// src/memory/memory-gate.ts:107-120
shouldWrite(response: string, userMessage: string, ctx: SignificanceContext): WriteDecision {
  // Defense: null/undefined params degrade gracefully
  if (!response || !userMessage || !ctx) {
    return {
      shouldWrite: false,
      reason: "Invalid arguments: response, userMessage, and ctx are required",
      confidence: 0, category: "skip",
    };
  }
```

The significance scoring (line 174-253) uses a multi-factor weighted system:

```typescript
// src/memory/memory-gate.ts:175-253
let confidence = 0;
const reasons: string[] = [];

// Task type weighting
if (ctx.taskType && this.config.highValueTasks.includes(ctx.taskType)) {
  confidence += 0.3; reasons.push(`High-value task: ${ctx.taskType}`);
} else if (ctx.taskType && this.config.lowValueTasks.includes(ctx.taskType)) {
  confidence -= 0.2; reasons.push(`Low-value task: ${ctx.taskType}`);
}

if (ctx.hasCode) { confidence += 0.2; reasons.push("Contains code"); }
if (ctx.hasCitations) { confidence += 0.15; reasons.push("Contains citations"); }
if (ctx.hasStructuredData) { confidence += 0.1; reasons.push("Contains structured data"); }
if (ctx.hasTechnicalTerms) { confidence += 0.1; reasons.push("Contains technical terms"); }
if (response.length > 500) { confidence += 0.1; reasons.push("Substantial response"); }
if (response.length > 2000) { confidence += 0.05; reasons.push("Very detailed response"); }
if (ctx.isFirstTurn) { confidence += 0.05; reasons.push("First turn of conversation"); }
if (ctx.userMessageLength > 200) { confidence += 0.05; reasons.push("Detailed user query"); }

confidence = Math.max(0, Math.min(1, confidence));

if (confidence >= this.config.minConfidence) {
  const category = confidence >= 0.8 ? "high-value" : "medium-value";
  return { shouldWrite: true, reason: reasons.join("; "), confidence, category };
}
return { shouldWrite: false, reason: `Confidence too low`, confidence, category: "low-value" };
```

### 4.4 Conformal Retriever — NaN Defense

The `ConformalRetriever.retrieve()` at `src/memory/conformal-retriever.ts:256` clamps similarity scores to prevent NaN from propagating:

```typescript
// src/memory/conformal-retriever.ts:276-289
for (const doc of candidates) {
  let similarity: number;
  try {
    similarity = similarityFn(query, doc);
  } catch (e) {
    logger.error(`[ConformalRetriever] similarityFn threw for doc`, ...);
    similarity = 0;
  }

  // Boundary check: NaN/Infinity → 0 (most conservative), clamp [0, 1]
  const clampedSimilarity = Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0;

  const nonconformityScore = 1 - clampedSimilarity;
  const pValue = this.computePValue(nonconformityScore);
  pValues.set(doc, pValue);
}
```

The p-value calculation at line 342 uses binary search for O(log n) evaluation:

```typescript
// src/memory/conformal-retriever.ts:342-353
private computePValue(nonconformityScore: number): number {
  if (this.n === 0) return 1.0; // No calibration data → conservative: max p-value
  const countGeq = this.countGreaterOrEqual(nonconformityScore);
  return (countGeq + 1) / (this.n + 1);
}
```

### 4.5 Loop Detection — Rate-Limited Throttling

The `detectLoop` function at `src/tools/types.ts:74` tracks recent call hashes per minute:

```typescript
// src/tools/types.ts:74-91
const recentCalls = new Map<string, number[]>();

export function detectLoop(toolName: string, input: string): boolean {
  const key = `${toolName}:${input.slice(0, 200)}`;
  const now = Date.now();
  const calls = recentCalls.get(key) ?? [];
  const recent = calls.filter(t => now - t < 60000);
  recent.push(now);
  recentCalls.set(key, recent);
  if (recent.length > 5) {
    const alreadyWarned = calls.find(t => t === -1);
    if (!alreadyWarned) {
      recentCalls.set(key, [-1]);
      logger.warn(`[ToolGuard] Loop detected: ${key} (${recent.length} calls in 60s)`);
    }
    return true;
  }
  return false;
}
```

Key behaviors:
- Uses `input.slice(0, 200)` as the hashing key (not the full content)
- Emits a warning only once per window (marks with `-1`)
- Prunes stale entries older than 60 seconds
- Cleared via `clearLoopCache()` for test isolation

---

## Section 5: Architecture Decisions

### 5.1 Why `export *` Was Replaced with Named Exports

The old `router/models.ts` used `export *` which created a maintainability problem — every symbol from internal modules was re-exported without control. The new version at `src/router/models.ts` uses explicit named re-exports:

```typescript
// src/router/models.ts — before: export * from "./models/...";
// After — explicit named exports:
export type { ModelProvider, TaskRole, UnifiedModel, ProviderConfig } from "./models/types.js";
export { PROVIDER_CONFIG, isProviderConfigured, listConfiguredProviders } from "./models/providers.js";
export { UNIFIED_REGISTRY, getModel, getFallbackChain, listFreeModels, listAllModels, listAllRoles } from "./models/registry.js";
```

The architecture test at `tests/architecture-integrity.test.ts:239` enforces this:

```typescript
// tests/architecture-integrity.test.ts:239-244
it("router/models.ts must not use export *", () => {
  const filePath = path.join(srcDir, "router", "models.ts");
  const content = fs.readFileSync(filePath, "utf-8");
  expect(content).not.toMatch(/export\s+\*\s+from/);
});
```

### 5.2 Why `services/` Exists as Cycle-Breaker

The services layer at `src/services/` breaks circular dependencies. For example, the `agents` module imports from `router`, and `router` imports from `agents` — this circular pair is broken by routing both through `services/`:

```typescript
// src/services/router.ts:1-18
/**
 * Router service — re-exports from router/ for the services layer.
 *
 * This breaks the circular import cycle agents↔router by routing both
 * sides through the neutral services/ layer (see also services/execution.ts
 * and services/consciousness.ts which route the router→agents direction).
 */
export { router, type ChatMessage, type ChatStreamEvent, type SmartAssignmentResponse } from "../router/model-router.js";
export { toolPool } from "../router/tool-pool.js";
export { getTokenTracker } from "../router/token-tracker.js";
export { findModelsForRole } from "../router/model-capability-registry.js";
export { PROVIDER_CONFIG } from "../router/models.js";
export type { TaskRole } from "../router/model-capability-registry.js";
```

The services index re-exports all cycle breakers:

```typescript
// src/services/index.ts
export { prepareChatContext, executeChat, type PreparedContext } from "./chat.js";
export { executionMode, getConstitutionForMode, injectConstitution } from "./execution.js";
export { getConsciousness } from "./consciousness.js";
export { router, type ChatMessage, type ChatStreamEvent, type SmartAssignmentResponse, toolPool, getTokenTracker, findModelsForRole, PROVIDER_CONFIG, type TaskRole, } from "./router.js";
```

The circular pairs are explicitly listed in the architecture test exemptions:

```typescript
// tests/architecture-integrity.test.ts:363-371
const KNOWN_CIRCULAR_PAIRS = new Set<string>([
  "agents <-> services",
  "core <-> routes",
  "db <-> memory",
  "eval <-> router",
  "memory <-> services",
  "pi-agent <-> router",
  "router <-> services",
]);
```

### 5.3 Why `getConfig()` Was Merged into `config-center.ts`

The legacy `utils/config.ts` was merged into `src/core/config-center.ts` to create a single configuration entry point. The `getConfig()` function at line 574 reads from the `ConfigCenter` singleton:

```typescript
// src/core/config-center.ts:574-596
export function getConfig(): AppConfig {
  const cc = getConfigCenter();
  return {
    gateway: {
      port: cc.getNumber("gateway.port"),
      bind: cc.getString("gateway.bind"),
      auth: { token: cc.getString("gateway.auth_token") || undefined },
    },
    models: (cc.getYamlData()?.models ?? []) as ModelConfig[],
    memory: {
      vaultPath: cc.getString("memory.vault_path"),
      obsidianApiPort: Number(process.env.OBSIDIAN_API_PORT) || 27124,
      obsidianApiToken: process.env.OBSIDIAN_API_TOKEN || "",
      databasePath: cc.getString("memory.database_path"),
    },
    crawler: {
      searchApi: process.env.CRAWLER_SEARCH_API || "multi-engine",
      serpapiKey: cc.getString("crawler.serpapi_key"),
      maxConcurrent: cc.getNumber("crawler.max_concurrent") || 3,
      requestDelay: Number(process.env.CRAWLER_REQUEST_DELAY) || 1000,
    },
  };
}
```

The merge eliminated duplicate env-var reading logic and ensured all configuration flows through the priority chain: Runtime Override > ENV > YAML > Default.

### 5.4 Why `createDefaultMentalModelPool` Was Inlined

Previously, multiple factory functions created `MentalModelPool` instances with different configurations. After refactoring, there is a single `new MentalModelPool()` call at `src/dre/engine.ts:123`:

```typescript
// src/dre/engine.ts:123
this.mentalModels = new MentalModelPool();
```

All variants were consolidated because the pool is always initialized with the same defaults. The exported type at `src/dre/index.ts:31` remains:

```typescript
export { MentalModelPool, type MentalModel, type ModelPattern, type ModelRule, type Simulation, type SimulationStep } from "./mental-model/pool.js";
```

### 5.5 Why EventBus Uses O(1) Ring Buffer

The `EventBusImpl` at `src/dre/runtime/event-bus.ts:42` uses a ring buffer for the event log instead of an unbounded array:

```typescript
// src/dre/runtime/event-bus.ts:62-69
this.stats.published++;
if (this.eventLog.length < this.maxLogSize) {
  this.eventLog.push(fullEvent);
} else {
  this.eventLog[this.eventLogIndex] = fullEvent;
}
this.eventLogIndex = (this.eventLogIndex + 1) % this.maxLogSize;
```

The `getRecentEvents()` method reads from the ring buffer with modular arithmetic:

```typescript
// src/dre/runtime/event-bus.ts:123-135
getRecentEvents(count = 20): RuntimeEvent[] {
  const len = this.eventLog.length;
  if (len === 0) return [];
  if (len < this.maxLogSize) {
    return this.eventLog.slice(-count);
  }
  const take = Math.min(count, len);
  const start = (this.eventLogIndex - take + this.maxLogSize) % this.maxLogSize;
  return start === 0
    ? this.eventLog.slice(0, take)
    : this.eventLog.slice(start, len).concat(this.eventLog.slice(0, start));
}
```

This improved 100k publish from 77ms to 29ms (a 2.65x speedup) by eliminating the O(n) `shift()` on the event log array.

---

## Section 6: Test Architecture

### 6.1 Architecture Integrity Tests (22 Checks)

Defined at `tests/architecture-integrity.test.ts:134`, these run via `bun run test:arch`. They enforce:

**Layer constraints** (test 1, line 136): utils/ must not import from higher layers:

```typescript
// tests/architecture-integrity.test.ts:136-158
it("src/utils/ must not import from higher layers", () => {
  const re = /(?:from\s+['"]|import\s*\(\s*['"])\.\.\/(memory|router|agents|mcp|dre|routes|services)\//;
  const violations: string[] = [];
  const files = getTsFiles(path.join(srcDir, "utils"));
  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const relative = path.relative(srcDir, file).replace(/\\/g, "/");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) violations.push(`${relative}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  expect(violations).toHaveLength(0);
});
```

**process.env whitelist** (test 2, line 161): only 9 whitelisted files may read env vars directly:

```typescript
// tests/architecture-integrity.test.ts:123-132
const ENV_WHITELIST = new Set([
  "utils/env.ts", "core/config-center.ts", "utils/logger.ts",
  "utils/proxy-fetch.ts", "utils/api-key-store.ts",
  "memory/vault-manager.ts", "main.ts", "router/models/providers.ts",
]);
```

**Code quality** checks include: `as any` ≤ 25 total (test 3, line 190), `@ts-expect-error` ≤ 1 (test 4, line 205), no `console.log/error` outside whitelist (test 16, line 407), `: any` annotations ≤ 90 (test 17, line 428), descriptive `throw` messages ≥ 10 chars (test 18, line 447), exported functions in `utils/` must have return types (test 19, line 475):

```typescript
// tests/architecture-integrity.test.ts:474-487
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
  expect(violations).toHaveLength(0);
});
```

### 6.2 Performance Benchmarks (32 Benchmarks)

Defined at `tests/perf-benchmark.test.ts`, these include extreme benchmarks that must sustain 200% of normal load:

```typescript
// tests/perf-benchmark.test.ts:305-315 — Cache 100k set+get < 200ms
it("[perf-extreme] Cache 100k set+get < 200ms", () => {
  const { Cache } = require("../src/utils/cache.js");
  const cache = new Cache({ maxSize: 200000, defaultTtlMs: 60000, redis: false, persistent: false });
  const avg = bench("cache100k-set+get", () => {
    cache.set("ek", "ev");
    cache.getSync("ek");
  }, 100000);
  cache.destroy();
  expect(avg).toBeLessThan(0.002);
});

// tests/perf-benchmark.test.ts:329-344 — Concurrent getOrSet factory once
it("[perf-extreme] Cache concurrent getOrSet 1000 → factory exactly once", async () => {
  const { Cache } = require("../src/utils/cache.js");
  const cache = new Cache({ maxSize: 1000, defaultTtlMs: 60000, redis: false, persistent: false });
  let factoryCalls = 0;
  const results = await Promise.all(
    Array.from({ length: 1000 }, () =>
      cache.getOrSet("shared-key", async () => { factoryCalls++; return "computed"; }, 60000),
    ),
  );
  expect(factoryCalls).toBe(1);
  expect(results.every((r) => r === "computed")).toBe(true);
});
```

```typescript
// tests/perf-benchmark.test.ts:346-361 — Memory ceiling: 1M writes → maxSize=10000
it("[perf-extreme] Cache memory ceiling: 1M entries, maxSize=10000", () => {
  const { Cache } = require("../src/utils/cache.js");
  const cache = new Cache({ maxSize: 10000, defaultTtlMs: 60000, redis: false, persistent: false });
  for (let i = 0; i < 1_000_000; i++) {
    cache.set(`k-${i}`, i);
  }
  expect(cache.stats().size).toBeLessThanOrEqual(10000);
});
```

### 6.3 Property-Based Tests (46 Invariants)

The PBT suite at `tests/property-based.test.ts` covers 6 modules with invariants:

**Cache (11 invariants, lines 13-108):**
```typescript
// tests/property-based.test.ts:14-21 — INV1: set→get returns same value
it("INV1: set->get returns same value", async () => {
  const { Cache } = await import("../src/utils/cache.js");
  const c = new Cache({ maxSize: 1000, defaultTtlMs: 60000, redis: false });
  for (let i = 0; i < 1000; i++) {
    c.set(`k${i}`, { index: i, data: randStr(20) });
    expect((c.getSync(`k${i}`) as any).index).toBe(i);
  }
});
```

**HttpRouter (3 invariants, lines 269-299):**
```typescript
// tests/property-based.test.ts:270-277 — INV1: 1000 random routes
it("INV1: match registered route for 1000 random routes", () => {
  // ...statistical sampling of route matching correctness
});
```

**Vault (13 invariants, lines 296-367):**
```typescript
// tests/property-based.test.ts:296-307 — Atomic note round-trip
it("INV7: atomic note round trip", async () => {
  const { MockVaultManager } = await import("./helpers/vault-mock.js");
  const vault = new MockVaultManager();
  const path = await vault.writeAtomicNote("My Atomic Idea", "core insight here", { tags: ["atomic"] });
  const note = vault.readNote(path);
  expect(note).not.toBeNull();
  expect(note!.content).toContain("My Atomic Idea");
  expect(note!.content).toContain("core insight here");
});
```

### 6.4 SOAK Test (5000 Iterations)

The SOAK test at `tests/property-based.test.ts:427` exercises Cache + HttpRouter + ThompsonRouter in a single 5000-iteration loop:

```typescript
// tests/property-based.test.ts:427-450
describe("SOAK", () => {
  it("Cache+Router+TS 5000 iterations", async () => {
    const [mC, mR, mT] = await Promise.all([
      import("../src/utils/cache.js"),
      import("../src/core/http-router.js"),
      import("../src/router/thompson-router.js"),
    ]);
    const cache = new mC.Cache({ maxSize: 100, defaultTtlMs: 60000, redis: false });
    const router = new mR.HttpRouter({ redis: false } as any);
    const ts = mT.createThompsonRouter({
      arms: Array.from({length:5},(_,i)=>({id:`a${i}`,model:`m${i}`,provider:"p",alpha:10-i,beta:1+i,metadata:{}})),
      minSamples: 3, inMemory: true,
    });
    for (let i = 0; i < 10; i++) router.register({ method: "GET", path: `/e/${i}`, handler: async () => new Response("ok") });

    const t0 = performance.now();
    for (let it = 0; it < 5000; it++) {
      cache.set(`s${rand(50)}`, { it });
      if (it % 2 === 0) cache.getSync(`s${rand(50)}`);
      if (it % 5 === 0) {
        const ctx: any = { url: new URL(`http://h/e/${rand(10)}`), req: new Request(`http://h/e/${rand(10)}`), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d: any) => d };
        await router.execute(ctx).catch(() => null);
      }
      if (it % 3 === 0) {
        const d = await ts.route({ taskType: ["chat","code","math"][rand(3)], inputLength: rand(1000) });
        ts.reportFeedback(d.arm.id, rand(5) !== 0);
      }
    }
    console.log(`  5000 iter: ${(performance.now()-t0).toFixed(0)}ms`);
  }, 60000);
});
```

### 6.5 MockVaultManager — Isolated Testing

`tests/helpers/vault-mock.ts` provides a lightweight in-memory mock that replaces the file-system-backed `VaultManager`:

```typescript
// tests/helpers/vault-mock.ts:9-117
export class MockVaultManager {
  public calls: MockCallRecord[] = [];
  public notes = new Map<string, VaultNote>();

  search(query: string, opts?: { limit?: number; types?: string[]; tags?: string[]; paraCategory?: string }): SearchResult[] {
    this.calls.push({ method: "search", args: [query, opts], timestamp: Date.now() });
    const results: SearchResult[] = [];
    for (const [path, note] of this.notes) {
      if (results.length >= (opts?.limit ?? 10)) break;
      if (note.content.includes(query) || note.title.includes(query)) {
        results.push({ note, score: 1, reasons: ["mock-match"], excerpt: note.content.slice(0, 100) });
      }
    }
    return results;
  }

  async writeNote(path: string, content: string, opts?: Record<string, unknown>): Promise<string> {
    this.calls.push({ method: "writeNote", args: [path, content, opts], timestamp: Date.now() });
    this.notes.set(path, this.makeNote(path, content));
    return path;
  }

  readNote(path: string): { content: string; frontmatter: Record<string, unknown> } | null {
    this.calls.push({ method: "readNote", args: [path], timestamp: Date.now() });
    const note = this.notes.get(path);
    return note ? { content: note.content, frontmatter: note.frontmatter } : null;
  }

  reset(): void { this.calls = []; this.notes.clear(); }
  callCount(method: string): number { return this.calls.filter(c => c.method === method).length; }
}
```

The mock tracks all calls (enabling `callCount` assertions) while avoiding filesystem I/O. Performance benchmarks use it for vault operations — 10k mock writes complete in ~17ms vs 200ms+ for real filesystem operations.

---

## Summary

| Path | Lines | Key Pattern |
|------|-------|-------------|
| `src/main.ts` | 576 | `Bun.serve()` entry, Trie router, auth gate |
| `src/core/http-router.ts` | 369 | O(1) Trie matching, cache, perf reporting |
| `src/routes/index.ts` | 416 | `registerTrieRoutes()`, handler imports |
| `src/memory/vault-manager.ts` | 761 | Deterministic vault, FTS5+fallback search |
| `src/mcp/server.ts` | 462 | Dual transport, 15 domain registrations |
| `src/mcp/tool-registry.ts` | 103 | `ToolDef` + `ToolRegistry` abstraction |
| `src/dre/runtime/event-bus.ts` | 144 | O(1) ring buffer, priority dispatch |
| `src/memory/memory-gate.ts` | 331 | Significance scoring, null guard |
| `src/memory/conformal-retriever.ts` | 456 | NaN clamp, binary-search p-value |
| `tests/architecture-integrity.test.ts` | 543 | 22 checks, layer/code-quality/perf |
| `tests/perf-benchmark.test.ts` | 557 | 32 benchmarks, extreme (200%) |
| `tests/property-based.test.ts` | 451 | 46 invariants, 5000 SOAK |
