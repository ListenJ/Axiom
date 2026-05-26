import { logger } from "./logger.js";

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
  {
    name: "OPENROUTER_API_KEY",
    required: false,
    description: "OpenRouter API key for model routing",
  },
  {
    name: "SILICONFLOW_API_KEY",
    required: false,
    description: "SiliconFlow API key",
  },
  {
    name: "OFOXAI_API_KEY",
    required: false,
    description: "OFoxAI API key",
  },
  {
    name: "DEEPSEEK_API_KEY",
    required: false,
    description: "DeepSeek API key",
  },
  {
    name: "KIMICODE_API_KEY",
    required: false,
    description: "KimiCode API key",
  },
  {
    name: "SERPAPI_KEY",
    required: false,
    description: "SerpAPI key for search aggregation",
  },
  {
    name: "HTTP_PROXY",
    required: false,
    description: "HTTP proxy URL",
  },
  {
    name: "PORT",
    required: false,
    default: "3000",
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
    validate: (v) =>
      ["debug", "info", "warn", "error", "silent"].includes(v.toLowerCase()),
    description: "Logging level",
  },
  {
    name: "NODE_ENV",
    required: false,
    default: "development",
    validate: (v) =>
      ["development", "production", "test"].includes(v.toLowerCase()),
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
        result.appliedDefaults.push({
          name: config.name,
          value: config.default,
        });
        logger.debug(
          `Applied default value for ${config.name}: ${config.default}`
        );
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

  // Check for unknown env vars that might be typos
  const knownVars = new Set(REQUIRED_ENV_VARS.map((v) => v.name));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCLAW_") && !knownVars.has(key)) {
      result.warnings.push(
        `Unknown environment variable: ${key}. Did you mean one of: ${Array.from(
          knownVars
        )
          .filter((k) => k.toLowerCase().includes(key.toLowerCase().replace("openclaw_", "")))
          .join(", ") || "none found"}?`
      );
    }
  }

  // Log results
  if (result.appliedDefaults.length > 0) {
    logger.info(
      `Applied defaults for ${result.appliedDefaults.length} environment variables`
    );
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      logger.warn(warning);
    }
  }

  if (!result.valid) {
    if (result.missing.length > 0) {
      logger.error(
        `Missing required environment variables: ${result.missing.join(", ")}`
      );
    }
    if (result.invalid.length > 0) {
      for (const inv of result.invalid) {
        logger.error(`Invalid ${inv.name}="${inv.value}": ${inv.reason}`);
      }
    }

    if (strict && exitOnError) {
      logger.error("Environment validation failed. Exiting.");
      process.exit(1);
    }
  }

  return result;
}

export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return process.env[name] || defaultValue;
}

export function getEnvVarAsBool(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

export function getEnvVarAsInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
