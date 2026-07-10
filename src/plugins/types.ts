export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  category: string;
  tags: string[];
  entry?: string;
  config?: unknown;
  dependencies?: string[];
  requiresAxiom?: string;
  icon?: string;
  docsUrl?: string;
}

export type PluginStatus = "installed" | "enabled" | "disabled" | "error";

export interface Plugin {
  manifest: PluginManifest;
  status: PluginStatus;
  path: string;
  configValues: Record<string, unknown>;
  error?: string;
  installedAt?: number;
  enabledAt?: number;
}

export interface PluginModule {
  tools?: import("../mcp/tool-registry.js").ToolDef[];
  hooks?: {
    onEnable?: () => void | Promise<void>;
    onDisable?: () => void | Promise<void>;
  };
  [key: string]: unknown;
}

export interface InstallOptions {
  overwrite?: boolean;
  enable?: boolean;
}
