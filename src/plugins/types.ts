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

/**
 * 旧版插件 SDK 上下文（2026-07-26 W3 修复：loader 兼容 activate(context) 契约）。
 * 示例插件（doc-generator 等）使用 `export default { activate(context) }`，
 * 与 PluginModule 的 tools/hooks 契约并存——加载器两种都支持。
 */
export interface PluginContext {
  toolRegistry: import("../mcp/tool-registry.js").ToolRegistry;
  config: Record<string, unknown>;
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
    debug: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

/** 带 activate 的旧版模块形状 */
export interface ActivatablePluginModule {
  activate: (context: PluginContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

export interface InstallOptions {
  overwrite?: boolean;
  enable?: boolean;
}
