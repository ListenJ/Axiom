/**
 * Centralized environment-variable access — single canonical module.
 *
 * Phase Audit-#4: merged the old `env-validation.ts` (validateEnv,
 * REQUIRED_ENV_VARS, getEnvVar*) and the previously-new `env.ts`
 * (readString/Int/Bool, snapshotEnv) into one file. Everything else in
 * the codebase now imports from here; the old env-validation.ts is
 * removed.
 *
 * Public surface (in order of typical use):
 *
 *   - readString(key, fallback?) / readInt(key, fallback) / readBool(key, fallback?)
 *       Typed getters. `readInt` falls back on NaN / unparseable input.
 *       `readBool` accepts "1"/"true"/"yes" (truthy) and
 *       "0"/"false"/"no" (falsy); anything else returns the fallback.
 *
 *   - snapshotEnv(keys) / class EnvSnapshot
 *       Capture+restore helpers for tests (and any code that mutates
 *       process.env temporarily).
 *
 *   - validateEnv(options?) / REQUIRED_ENV_VARS / EnvVarConfig
 *       Startup-time validation against a registry of expected vars.
 *       `validateEnv({ strict: true, exitOnError: true })` is the
 *       production default; the call in main.ts uses `strict: false,
 *       exitOnError: false` so the app boots even with missing optional
 *       keys.
 *
 *   - getEnvVar / getEnvVarAsBool / getEnvVarAsInt
 *       Legacy aliases (kept so external scripts that import from
 *       "env-validation.js" don't break during the transition window).
 *       Prefer the read* / validate* variants in new code.
 */

import { logger } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// Typed getters
// ═══════════════════════════════════════════════════════════════

export function readString(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function readInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function readBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const truthy = v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
  const falsy = v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "no";
  if (truthy) return true;
  if (falsy) return false;
  return fallback;
}

// ═══════════════════════════════════════════════════════════════
// Snapshot helpers (for tests + temporary mutations)
// ═══════════════════════════════════════════════════════════════

/**
 * Capture a snapshot of the listed env keys. Returns an object whose
 * `restore()` puts the keys back exactly as they were.
 *
 * Use in beforeEach/afterEach pairs, or wrap test bodies with try/finally.
 */
export function snapshotEnv(keys: readonly string[]): { keys: readonly string[]; restore: () => void } {
  const before: Record<string, string | undefined> = {};
  for (const key of keys) before[key] = process.env[key];
  return {
    keys: [...keys],
    restore: () => {
      for (const key of keys) {
        const original = before[key];
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    },
  };
}

/**
 * Capture-all snapshot. Use sparingly — typically only in setup/teardown
 * of long-running tests where any env mutation must be reverted.
 */
export class EnvSnapshot {
  private readonly before: Record<string, string | undefined>;
  public readonly takenAt: number;

  constructor() {
    this.before = { ...process.env };
    this.takenAt = Date.now();
  }

  restore(): void {
    for (const key of Object.keys(process.env)) {
      if (!(key in this.before)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(this.before)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Validation registry
// ═══════════════════════════════════════════════════════════════

export interface EnvVarConfig {
  name: string;
  required: boolean;
  default?: string;
  validate?: (value: string) => boolean;
  description: string;
}

export const REQUIRED_ENV_VARS: EnvVarConfig[] = [
  {
    name: "DATABASE_URL",
    required: true,
    description: "SQLite database connection string",
  },
  {
    name: "VAULT_PATH",
    required: true,
    description: "Obsidian vault path for memory storage",
  },
  { name: "OPENROUTER_API_KEY", required: false, description: "OpenRouter API key for model routing" },
  { name: "SILICONFLOW_API_KEY", required: false, description: "SiliconFlow API key" },
  { name: "OFOXAI_API_KEY", required: false, description: "OFoxAI API key" },
  { name: "DEEPSEEK_API_KEY", required: false, description: "DeepSeek API key" },
  { name: "KIMICODE_API_KEY", required: false, description: "KimiCode API key" },
  { name: "MINIMAX_API_KEY", required: false, description: "MiniMax (MiniMax AI) API key — also runtime-configurable via frontend Settings" },
  { name: "SERPAPI_KEY", required: false, description: "SerpAPI key for search aggregation" },
  { name: "HTTP_PROXY", required: false, description: "HTTP proxy URL" },
  {
    name: "PORT",
    required: false,
    default: "18789",
    validate: (v) => {
      const port = parseInt(v, 10);
      return port > 0 && port < 65536;
    },
    description: "HTTP server port",
  },
  {
    name: "LOG_LEVEL",
    required: false,
    default: "info",
    validate: (v) => ["debug", "info", "warn", "error", "silent"].includes(v.toLowerCase()),
    description: "Logging level",
  },
  {
    name: "NODE_ENV",
    required: false,
    default: "development",
    validate: (v) => ["development", "production", "test"].includes(v.toLowerCase()),
    description: "Node environment",
  },
  {
    name: "ENABLE_CRON",
    required: false,
    default: "true",
    validate: (v) => ["true", "false"].includes(v.toLowerCase()),
    description: "Enable cron scheduler",
  },
  {
    name: "ENABLE_MCP",
    required: false,
    default: "true",
    validate: (v) => ["true", "false"].includes(v.toLowerCase()),
    description: "Enable MCP server",
  },
  {
    name: "ENABLE_WEBSOCKET",
    required: false,
    default: "true",
    validate: (v) => ["true", "false"].includes(v.toLowerCase()),
    description: "Enable WebSocket server",
  },
  {
    name: "AXIOM_GATEWAY_PORT",
    required: false,
    default: "18789",
    validate: (v) => {
      const port = parseInt(v, 10);
      return Number.isFinite(port) && port > 0 && port < 65536;
    },
    description: "HTTP gateway port for Axiom",
  },
  {
    name: "AXIOM_AUTH_TOKEN",
    required: false,
    validate: (v) => v.length >= 16,
    description: "Gateway auth token (min 16 chars). If unset or default placeholder, server logs a loud warning and /api-keys returns 401.",
  },
];

export interface ValidationResult {
  valid: boolean;
  missing: string[];
  invalid: { name: string; value: string; reason: string }[];
  warnings: string[];
  appliedDefaults: { name: string; value: string }[];
}

export function validateEnv(options?: {
  strict?: boolean;
  exitOnError?: boolean;
}): ValidationResult {
  const { strict = false, exitOnError = true } = options || {};

  const result: ValidationResult = {
    valid: true,
    missing: [],
    invalid: [],
    warnings: [],
    appliedDefaults: [],
  };

  for (const config of REQUIRED_ENV_VARS) {
    const value = process.env[config.name];

    if (!value) {
      if (config.required) {
        result.missing.push(config.name);
        result.valid = false;
      } else if (config.default !== undefined) {
        process.env[config.name] = config.default;
        result.appliedDefaults.push({ name: config.name, value: config.default });
        logger.debug(`Applied default value for ${config.name}: ${config.default}`);
      }
      continue;
    }

    if (config.validate && !config.validate(value)) {
      result.invalid.push({
        name: config.name,
        value,
        reason: `Failed validation for ${config.description}`,
      });
      result.valid = false;
    }
  }

  // Unknown env vars that look like typos
  const knownVars = new Set(REQUIRED_ENV_VARS.map((v) => v.name));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AXIOM_") && !knownVars.has(key)) {
      result.warnings.push(
        `Unknown environment variable: ${key}. Did you mean one of: ${
          Array.from(knownVars)
            .filter((k) => k.toLowerCase().includes(key.toLowerCase().replace("axiom_", "")))
            .join(", ") || "none found"
        }?`,
      );
    }
  }

  // Security warnings for AXIOM_AUTH_TOKEN
  const authToken = process.env.AXIOM_AUTH_TOKEN;
  if (!authToken) {
    result.warnings.push(
      "⚠️  AXIOM_AUTH_TOKEN is unset. All /api-keys requests will be refused (503). Generate one with: openssl rand -hex 32",
    );
  } else if (authToken === "your-secure-random-token") {
    result.warnings.push(
      "⚠️  AXIOM_AUTH_TOKEN is still the default placeholder. Replace it with a real secret (openssl rand -hex 32).",
    );
  } else if (authToken.length < 32) {
    result.warnings.push(
      `⚠️  AXIOM_AUTH_TOKEN is only ${authToken.length} chars. Use at least 32 chars for production (openssl rand -hex 32).`,
    );
  }

  if (result.appliedDefaults.length > 0) {
    logger.info(`Applied defaults for ${result.appliedDefaults.length} environment variables`);
  }
  for (const w of result.warnings) logger.warn(w);
  if (!result.valid) {
    if (result.missing.length > 0) {
      logger.error(`Missing required environment variables: ${result.missing.join(", ")}`);
    }
    if (result.invalid.length > 0) {
      for (const inv of result.invalid) {
        logger.error(`Invalid value for ${inv.name}: ${inv.reason}`);
      }
    }
    if (strict && exitOnError) {
      logger.error("Exiting due to invalid environment (strict mode).");
      process.exit(1);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Legacy aliases — kept for back-compat with old env-validation.ts
// ═══════════════════════════════════════════════════════════════

export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return readString(name, defaultValue ?? "");
}

export function getEnvVarAsBool(name: string, defaultValue = false): boolean {
  return readBool(name, defaultValue);
}

export function getEnvVarAsInt(name: string, defaultValue: number): number {
  return readInt(name, defaultValue);
}