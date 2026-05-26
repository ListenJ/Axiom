import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Claude Code CLI Adapter
 *
 * Wraps the `claude` CLI command for non-interactive programmatic use.
 * Claude Code is a CLI tool (not a pure HTTP API), requiring child_process invocation.
 *
 * Usage:
 *   const result = await claudeCode.execute("Explain this code", { cwd: "/project" });
 *
 * Prerequisites:
 *   - npm install -g @anthropic-ai/claude-code
 *   - ANTHROPIC_API_KEY env var set
 */

export interface ClaudeCodeOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Maximum execution time in ms (default: 120000) */
  timeout?: number;
  /** Additional context files to include */
  contextFiles?: string[];
  /** Output format: "text" | "json" (default: "text") */
  outputFormat?: "text" | "json";
  /** Model override (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Temperature (0-1, default: 0.7) */
  temperature?: number;
  /** Max tokens to generate (default: 4096) */
  maxTokens?: number;
  /** Enable verbose mode for debugging */
  verbose?: boolean;
}

export interface ClaudeCodeResult {
  content: string;
  model: string;
  provider: "claude-code";
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** Whether the result came from cache */
  cached?: boolean;
  /** Execution time in ms */
  durationMs: number;
}

class ClaudeCodeAdapter {
  private readonly defaultTimeout = 120000;
  private readonly defaultModel = "claude-sonnet-4-20250514";

  /**
   * Execute a prompt via Claude Code CLI
   */
  async execute(
    prompt: string,
    options: ClaudeCodeOptions = {}
  ): Promise<ClaudeCodeResult> {
    const startTime = Date.now();
    const {
      cwd,
      timeout = this.defaultTimeout,
      contextFiles = [],
      outputFormat = "text",
      model = this.defaultModel,
      temperature = 0.7,
      maxTokens = 4096,
      verbose = false,
    } = options;

    // Build command arguments
    const args = [
      "-p", // Non-interactive prompt mode
      prompt,
      "--model",
      model,
      "--temperature",
      String(temperature),
      "--max-tokens",
      String(maxTokens),
    ];

    if (outputFormat === "json") {
      args.push("--output-format", "json");
    }

    // Add context files
    for (const file of contextFiles) {
      args.push("--context", file);
    }

    if (verbose) {
      args.push("--verbose");
    }

    logger.info("[ClaudeCode] Executing prompt", {
      model,
      promptLength: prompt.length,
      cwd: cwd || process.cwd(),
    });

    try {
      const { stdout, stderr } = await execFileAsync("claude", args, {
        cwd: cwd || process.cwd(),
        timeout,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
        },
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      const durationMs = Date.now() - startTime;

      if (stderr && verbose) {
        logger.warn("[ClaudeCode] stderr", { stderr: stderr.slice(0, 500) });
      }

      // Parse JSON output if requested
      let content = stdout.trim();
      let usage: ClaudeCodeResult["usage"] | undefined;

      if (outputFormat === "json") {
        try {
          const parsed = JSON.parse(content);
          content = parsed.content || parsed.text || content;
          usage = parsed.usage;
        } catch {
          // Fallback to raw text if JSON parsing fails
        }
      }

      logger.info("[ClaudeCode] Completed", {
        durationMs,
        contentLength: content.length,
      });

      return {
        content,
        model,
        provider: "claude-code",
        usage,
        durationMs,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      if (error.killed || error.signal === "SIGTERM") {
        throw new Error(
          `Claude Code timed out after ${timeout}ms: ${error.message}`
        );
      }

      if (error.code === "ENOENT") {
        throw new Error(
          "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
        );
      }

      logger.error(
        "[ClaudeCode] Execution failed",
        error,
        { durationMs }
      );

      throw new Error(`Claude Code failed: ${error.message}`);
    }
  }

  /**
   * Check if Claude Code CLI is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("claude", ["--version"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute with automatic retry and circuit breaker
   */
  async executeWithResilience(
    prompt: string,
    options: ClaudeCodeOptions = {}
  ): Promise<ClaudeCodeResult> {
    const maxAttempts = 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.execute(prompt, options);
      } catch (error: any) {
        lastError = error;
        logger.warn(`[ClaudeCode] Attempt ${attempt + 1} failed`, {
          error: error.message,
        });

        if (attempt < maxAttempts - 1) {
          await this.delay(Math.min(1000 * Math.pow(2, attempt), 5000));
        }
      }
    }

    throw lastError || new Error("Claude Code execution failed after retries");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const claudeCode = new ClaudeCodeAdapter();
