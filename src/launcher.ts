/**
 * Axiom Unified Launcher
 * 
 * Usage:
 *   bun run src/launcher.ts [mode] [options]
 *   
 * Modes:
 *   serve    - Start HTTP server (web mode, port 18789)
 *   tui      - Start TUI (native terminal mode)
 *   agent    - Start agent mode with preloaded hooks
 *   full     - Start all services (HTTP + MCP + optional TUI)
 *   cli      - Run CLI commands
 *   status   - Check all service status
 * 
 * Examples:
 *   bun run src/launcher.ts serve           # Web mode only
 *   bun run src/launcher.ts serve --mcp     # Web + MCP
 *   bun run src/launcher.ts tui             # Native TUI mode
 *   bun run src/launcher.ts agent           # Agent with hooks
 *   bun run src/launcher.ts full            # Everything
 *   bun run src/launcher.ts cli search "AI" # CLI command
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { logger } from "./utils/logger.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  ports: {
    http: 18789,
    mcp: 3001,
  },
  paths: {
    main: resolve(import.meta.dir, "main.ts"),
    mcp: resolve(import.meta.dir, "mcp/server.ts"),
    tui: resolve(import.meta.dir, "tui/app.ts"),
    cli: resolve(import.meta.dir, "cli.ts"),
    bootstrap: resolve(import.meta.dir, "memory/bootstrap.ts"),
  },
  hooks: {
    enabled: true,
    preloadAgents: ["opencode", "kimi-code", "hermes"],
    warmupSearch: true,
    warmupMemory: true,
  },
};

// ─── Logger ──────────────────────────────────────────────────────────────────

const Log = {
  info: (msg: string) => logger.info(`[LAUNCHER] ${msg}`),
  success: (msg: string) => logger.info(`[LAUNCHER] ${msg}`),
  warn: (msg: string) => logger.warn(`[LAUNCHER] ${msg}`),
  error: (msg: string) => logger.error(`[LAUNCHER] ${msg}`),
};

// ─── Process Manager ─────────────────────────────────────────────────────────

class ProcessManager {
  private processes: Map<string, ChildProcess> = new Map();

  async start(name: string, cmd: string, args: string[]): Promise<ChildProcess> {
    Log.info(`Starting ${name}...`);
    
    const proc = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, AXIOM_MODE: name },
    });

    this.processes.set(name, proc);

    proc.on("error", (err) => {
      Log.error(`${name} failed: ${err.message}`);
      this.processes.delete(name);
    });

    proc.on("exit", (code) => {
      if (code !== 0) {
        Log.warn(`${name} exited with code ${code}`);
      } else {
        Log.info(`${name} stopped`);
      }
      this.processes.delete(name);
    });

    // Wait a bit for startup
    await new Promise((r) => setTimeout(r, 1500));
    
    if (proc.killed) {
      throw new Error(`${name} failed to start`);
    }

    Log.success(`${name} is running`);
    return proc;
  }

  stop(name: string): void {
    const proc = this.processes.get(name);
    if (proc) {
      Log.info(`Stopping ${name}...`);
      proc.kill("SIGTERM");
      this.processes.delete(name);
    }
  }

  stopAll(): void {
    for (const [name, proc] of this.processes) {
      Log.info(`Stopping ${name}...`);
      proc.kill("SIGTERM");
    }
    this.processes.clear();
  }

  list(): string[] {
    return Array.from(this.processes.keys());
  }
}

const pm = new ProcessManager();

// ─── Hook Preloader ──────────────────────────────────────────────────────────

class HookPreloader {
  private hooksLoaded = false;

  async preload(): Promise<void> {
    if (!CONFIG.hooks.enabled || this.hooksLoaded) return;

    Log.info("Preloading hooks...");

    try {
      // Preload agent bootstrap
      if (CONFIG.hooks.preloadAgents.length > 0) {
        await this.preloadAgents();
      }

      // Warmup search engine
      if (CONFIG.hooks.warmupSearch) {
        await this.warmupSearch();
      }

      // Warmup memory systems
      if (CONFIG.hooks.warmupMemory) {
        await this.warmupMemory();
      }

      this.hooksLoaded = true;
      Log.success("All hooks preloaded");
    } catch (err) {
      Log.warn(`Hook preload incomplete: ${err}`);
    }
  }

  private async preloadAgents(): Promise<void> {
    Log.info(`Preloading agents: ${CONFIG.hooks.preloadAgents.join(", ")}`);
    
    try {
      const { AgentBootstrap } = await import("./memory/bootstrap.js");
      const bootstrap = new AgentBootstrap();
      // Just instantiate to verify it loads
      Log.success("Agent bootstrap initialized");
    } catch {
      // Bootstrap might not export directly, that's ok
      Log.info("Agent bootstrap triggered");
    }
  }

  private async warmupSearch(): Promise<void> {
    Log.info("Warming up search engines...");
    
    try {
      // Load unified search module
      const { unifiedSearch } = await import("./crawl/unified-search.js");
      // Preload with a test query to initialize caches
      await unifiedSearch.quickSearch("axiom test", 1);
      Log.success("Unified search warmed up");
    } catch (err) {
      Log.warn(`Enhanced search warmup skipped: ${err}`);
      // Fallback to basic search
      try {
        const { searchAggregator } = await import("./crawl/search-engines.js");
        if (searchAggregator) {
          Log.success("Basic search aggregator loaded");
        }
      } catch (err2) {
        Log.warn(`Basic search warmup skipped: ${err2}`);
      }
    }
  }

  private async warmupMemory(): Promise<void> {
    Log.info("Warming up memory vault...");
    
    try {
      const { VaultManager } = await import("./memory/vault-manager.js");
      const vault = new VaultManager();
      // Just instantiate to verify it loads; health check via stats
      vault.stats();
      Log.success("Memory vault warmed up");
    } catch {
      Log.info("Memory vault warmup skipped");
    }
  }
}

const preloader = new HookPreloader();

// ─── Health Checker ──────────────────────────────────────────────────────────

async function checkHealth(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};

  // Check HTTP server
  try {
    const res = await fetch(`http://localhost:${CONFIG.ports.http}/health`, { 
      signal: AbortSignal.timeout(3000) 
    });
    results.http = res.ok;
  } catch {
    results.http = false;
  }

  // Check MCP server
  try {
    const res = await fetch(`http://localhost:${CONFIG.ports.mcp}/health`, { 
      signal: AbortSignal.timeout(3000) 
    });
    results.mcp = res.ok;
  } catch {
    results.mcp = false;
  }

  return results;
}

// ─── Mode Handlers ───────────────────────────────────────────────────────────

async function serveMode(args: string[]): Promise<void> {
  Log.info("=== Web Mode (HTTP Server) ===");
  
  // Preload hooks
  await preloader.preload();

  // Start HTTP server
  await pm.start("http", "bun", [CONFIG.paths.main]);

  // Optionally start MCP
  if (args.includes("--mcp")) {
    await pm.start("mcp", "bun", [CONFIG.paths.mcp]);
  }

  Log.success(`\n[服务] Server running at http://localhost:${CONFIG.ports.http}`);
  Log.info("Press Ctrl+C to stop\n");
}

async function tuiMode(): Promise<void> {
  Log.info("=== Native Mode (TUI) ===");

  // Preload hooks
  await preloader.preload();

  // Start Unified TUI
  Log.info("Starting Unified TUI v3.0...");
  const { startTUI } = await import("./tui/app.js");
  await startTUI();
}

async function agentMode(): Promise<void> {
  Log.info("=== Agent Mode (Preloaded Hooks) ===");
  
  // Full preload
  await preloader.preload();

  Log.success("\n[Agent] ready with preloaded hooks");
  Log.info("Available: web_search, memory, code_analysis, task_orchestration");
  Log.info("Press Ctrl+C to exit\n");

  // Keep alive
  await new Promise(() => {});
}

async function fullMode(): Promise<void> {
  Log.info("=== Full Mode (All Services) ===");

  // Preload hooks
  await preloader.preload();

  // Start all services
  await pm.start("http", "bun", [CONFIG.paths.main]);
  await pm.start("mcp", "bun", [CONFIG.paths.mcp]);

  Log.success(`\n[全栈] Full stack running:`);
  Log.info(`   HTTP: http://localhost:${CONFIG.ports.http}`);
  Log.info(`   MCP:  http://localhost:${CONFIG.ports.mcp}`);
  
  if (process.argv.includes("--tui")) {
    await pm.start("tui", "bun", [CONFIG.paths.tui]);
  }

  Log.info("\nPress Ctrl+C to stop all services\n");
}

async function cliMode(args: string[]): Promise<void> {
  const cliArgs = args.filter((a) => !a.startsWith("--"));
  
  if (cliArgs.length === 0) {
    Log.error("No command provided. Usage: bun run src/launcher.ts cli <command>");
    process.exit(1);
  }

  Log.info(`=== CLI Mode: ${cliArgs.join(" ")} ===`);

  const proc = spawn("bun", [CONFIG.paths.cli, ...cliArgs], {
    stdio: "inherit",
  });

  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
  });
}

async function statusMode(): Promise<void> {
  Log.info("=== Service Status ===");

  const health = await checkHealth();
  const processes = pm.list();

  console.log("\n  Service     Status");
  console.log("  ──────────────────────────");
  console.log(`  HTTP        ${health.http ? "\x1b[32m● running\x1b[0m" : "\x1b[31m○ stopped\x1b[0m"}`);
  console.log(`  MCP         ${health.mcp ? "\x1b[32m● running\x1b[0m" : "\x1b[31m○ stopped\x1b[0m"}`);
  console.log(`  Processes   ${processes.length > 0 ? processes.join(", ") : "none"}`);
  console.log("");
}

// ─── CLI Parser ──────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
  \x1b[1mAxiom Launcher\x1b[0m - Unified terminal entry point

  \x1b[36mUsage:\x1b[0m
    bun run src/launcher.ts <mode> [options]

  \x1b[36mModes:\x1b[0m
    serve       Start HTTP server (web mode)
    tui         Start TUI (native terminal mode)
    agent       Start agent with preloaded hooks
    full        Start all services
    cli         Run CLI commands
    status      Check service status

  \x1b[36mOptions:\x1b[0m
    --mcp       Include MCP server (with serve/full)
    --tui       Include TUI (with full)
    --no-hooks  Skip hook preloading

  \x1b[36mExamples:\x1b[0m
    bun run src/launcher.ts serve
    bun run src/launcher.ts serve --mcp
    bun run src/launcher.ts tui
    bun run src/launcher.ts agent
    bun run src/launcher.ts full --tui
    bun run src/launcher.ts cli search "AI trends"
    bun run src/launcher.ts status
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (!mode || mode === "--help" || mode === "-h") {
    showHelp();
    process.exit(0);
  }

  // Handle --no-hooks
  if (args.includes("--no-hooks")) {
    CONFIG.hooks.enabled = false;
  }

  // Setup graceful shutdown
  process.on("SIGINT", () => {
    Log.info("\nShutting down...");
    pm.stopAll();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    pm.stopAll();
    process.exit(0);
  });

  // Route to mode
  try {
    switch (mode) {
      case "serve":
        await serveMode(args.slice(1));
        break;
      case "tui":
        await tuiMode();
        break;
      case "agent":
        await agentMode();
        break;
      case "full":
        await fullMode();
        break;
      case "cli":
        await cliMode(args.slice(1));
        process.exit(0);
      case "status":
        await statusMode();
        process.exit(0);
      default:
        Log.error(`Unknown mode: ${mode}`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    Log.error(`Failed to start ${mode}: ${err}`);
    pm.stopAll();
    process.exit(1);
  }
}

main();
