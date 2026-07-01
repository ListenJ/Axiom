/**
 * Plugin Market System
 * 
 * Extends ToolRegistry with plugin lifecycle management.
 * Plugins are reusable bundles of tools, skills, and configurations
 * that can be installed, enabled, and shared.
 * 
 * Architecture:
 * - Plugin: metadata + entry point + config schema
 * - PluginRegistry: lifecycle management (install/uninstall/enable/disable)
 * - PluginStorage: SQLite-backed persistence
 * - PluginLoader: dynamic import with sandbox
 */

import type { ToolDef, ToolRegistry } from "../mcp/tool-registry.js";
import type { SkillDefinition, PromptTemplate } from "../skills/types.js";
import type { Logger } from "../utils/logger.js";

/** Plugin activation context - passed to plugin's activate function */
export interface PluginContext {
  /** Tool registry for registering tools */
  toolRegistry: ToolRegistry;
  /** Plugin configuration values */
  config: Record<string, unknown>;
  /** Logger instance */
  logger: Logger;
  /** Vault path for data storage */
  vaultPath: string;
  /** Plugin's data directory */
  dataDir: string;
}

/** Plugin status enum */
export type PluginStatus = "available" | "installed" | "enabled" | "disabled" | "error";

/** Plugin configuration schema */
export interface PluginConfig {
  /** Config key */
  key: string;
  /** Display label */
  label: string;
  /** Input type */
  type: "string" | "number" | "boolean" | "select" | "multiselect";
  /** Description */
  description?: string;
  /** Default value */
  default?: unknown;
  /** Required */
  required?: boolean;
  /** Options for select/multiselect */
  options?: Array<{ label: string; value: unknown }>;
}

/** Plugin manifest - defines a plugin */
export interface PluginManifest {
  /** Unique ID (reverse domain, e.g. "axiom.plugins.code-analysis") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Author name or org */
  author: string;
  /** Short description */
  description: string;
  /** Category */
  category: "developer-tools" | "productivity" | "analysis" | "integration" | "custom";
  /** Tags for search/filter */
  tags: string[];
  /** Entry file relative to plugin root (default: "index.js") */
  entry?: string;
  /** Configuration schema */
  config?: PluginConfig[];
  /** Plugin IDs this depends on */
  dependencies?: string[];
  /** Minimum Axiom version required */
  requiresAxiom?: string;
  /** Icon emoji or URL */
  icon?: string;
  /** README or docs URL */
  docsUrl?: string;
}

/** Plugin runtime instance */
export interface Plugin {
  manifest: PluginManifest;
  /** Current status */
  status: PluginStatus;
  /** Absolute path to plugin directory */
  path: string;
  /** Parsed config values */
  configValues: Record<string, unknown>;
  /** Error message if status === "error" */
  error?: string;
  /** Install timestamp */
  installedAt?: number;
  /** Enable timestamp */
  enabledAt?: number;
}

/** Plugin module - what a plugin exports */
export interface PluginModule {
  /** Tools this plugin provides */
  tools?: ToolDef[];
  /** Skills this plugin provides */
  skills?: SkillDefinition[];
  /** Prompt templates this plugin provides */
  templates?: PromptTemplate[];
  /** Intent patterns for direct tool calling */
  intentPatterns?: Array<{
    id: string;
    tool: string;
    keywords: string[];
    confidence: number;
  }>;
  /** Lifecycle hooks */
  hooks?: {
    /** Called when plugin is enabled */
    onEnable?: () => Promise<void>;
    /** Called when plugin is disabled */
    onDisable?: () => Promise<void>;
    /** Called on system startup after all plugins loaded */
    onReady?: () => Promise<void>;
  };
}

/** Plugin installation options */
export interface InstallOptions {
  /** Allow overwriting existing */
  overwrite?: boolean;
  /** Enable immediately after install */
  enable?: boolean;
}

/** Plugin search/filter options */
export interface PluginFilter {
  category?: string;
  status?: PluginStatus;
  tags?: string[];
  search?: string;
}

/** Plugin market API response */
export interface PluginMarketResponse {
  plugins: Plugin[];
  total: number;
  categories: string[];
  tags: string[];
}
