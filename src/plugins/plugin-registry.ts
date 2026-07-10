/**
 * Plugin Registry
 * 
 * Manages plugin lifecycle: install, uninstall, enable, disable.
 * Integrates with ToolRegistry for tool registration.
 * Stores plugin state in SQLite via PluginStorage.
 */

import { existsSync, mkdirSync, readdirSync, statSync, promises as fsPromises } from "fs";
import { join, basename, resolve } from "path";
import { logger } from "../utils/logger.js";
import { Database } from "bun:sqlite";
import type { Plugin, PluginManifest, PluginModule, PluginStatus, InstallOptions } from "./types.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import { readString } from "../utils/env.js";
import { safeJsonParse } from "../utils/json.js";

/** Plugin storage directory */
const PLUGIN_DIR = readString("AXIOM_PLUGIN_DIR", "./plugins");

/** Plugin registry for lifecycle management */
export class PluginRegistry {
  private db: Database;
  private plugins = new Map<string, Plugin>();
  private activeModules = new Map<string, PluginModule>();
  private toolRegistry: ToolRegistry;
  private pluginDir: string;

  constructor(db: Database, toolRegistry: ToolRegistry, pluginDir = PLUGIN_DIR) {
    this.db = db;
    this.toolRegistry = toolRegistry;
    this.pluginDir = resolve(pluginDir);
    this.ensureTables();
    this.ensurePluginDir();
    this.loadInstalledPlugins();
  }

  /** Ensure plugin directory exists */
  private ensurePluginDir(): void {
    if (!existsSync(this.pluginDir)) {
      mkdirSync(this.pluginDir, { recursive: true });
      logger.info(`Created plugin directory: ${this.pluginDir}`);
    }
  }

  /** Ensure SQLite tables exist */
  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        author TEXT,
        description TEXT,
        category TEXT,
        tags TEXT,
        entry TEXT,
        config TEXT,
        dependencies TEXT,
        requiresAxiom TEXT,
        icon TEXT,
        docsUrl TEXT,
        status TEXT DEFAULT 'installed',
        path TEXT,
        configValues TEXT,
        error TEXT,
        installedAt INTEGER,
        enabledAt INTEGER
      )
    `);
  }

  /** Load all installed plugins from database */
  private loadInstalledPlugins(): void {
    const rows = this.db.query(
      "SELECT * FROM plugins"
    ).all() as Array<{
      id: string;
      name: string;
      version: string;
      author: string;
      description: string;
      category: string;
      tags: string;
      entry: string;
      config: string;
      dependencies: string;
      requiresAxiom: string;
      icon: string;
      docsUrl: string;
      status: string;
      path: string;
      configValues: string;
      error: string;
      installedAt: number;
      enabledAt: number;
    }>;

    for (const row of rows) {
      const plugin: Plugin = {
        manifest: {
          id: row.id,
          name: row.name,
          version: row.version,
          author: row.author,
          description: row.description,
          category: row.category as Plugin["manifest"]["category"],
          tags: row.tags ? safeJsonParse(row.tags, []) : [],
          entry: row.entry || "index.js",
          config: row.config ? safeJsonParse(row.config, undefined) : undefined,
          dependencies: row.dependencies ? safeJsonParse(row.dependencies, undefined) : undefined,
          requiresAxiom: row.requiresAxiom,
          icon: row.icon,
          docsUrl: row.docsUrl,
        },
        status: row.status as PluginStatus,
        path: row.path,
        configValues: row.configValues ? safeJsonParse(row.configValues, {}) : {},
        error: row.error || undefined,
        installedAt: row.installedAt,
        enabledAt: row.enabledAt,
      };
      this.plugins.set(row.id, plugin);

      // Auto-enable if was enabled before restart
      if (plugin.status === "enabled") {
        this.enablePlugin(plugin).catch((e: unknown) => {
          logger.error(`Failed to auto-enable plugin ${row.id}: ${String(e)}`);
        });
      }
    }

    logger.info(`Loaded ${this.plugins.size} plugins from storage`);
  }

  /** Install a plugin from a directory path */
  async installFromPath(pluginPath: string, opts: InstallOptions = {}): Promise<Plugin> {
    const resolvedPath = resolve(pluginPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Plugin path not found: ${resolvedPath}`);
    }

    // Read manifest
    const manifestPath = join(resolvedPath, "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Plugin manifest not found: ${manifestPath}`);
    }

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(await Bun.file(manifestPath).text()) as PluginManifest;
      if (!manifest.id || !manifest.name || !manifest.version) {
        throw new Error("Invalid plugin.json: missing required fields (id, name, version)");
      }
    } catch (e) {
      throw new Error(`Failed to parse plugin.json at ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Check if already exists
    if (this.plugins.has(manifest.id) && !opts.overwrite) {
      throw new Error(`Plugin ${manifest.id} already installed. Use overwrite=true to replace.`);
    }

    // Validate dependencies
    if (manifest.dependencies) {
      for (const dep of manifest.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Missing dependency: ${dep}`);
        }
      }
    }

    // Copy to plugin directory
    const targetPath = join(this.pluginDir, manifest.id);
    if (existsSync(targetPath)) {
      await this.removeDirectory(targetPath);
    }
    await this.copyDirectory(resolvedPath, targetPath);

    // Create plugin record
    const plugin: Plugin = {
      manifest,
      status: "installed",
      path: targetPath,
      configValues: {},
      installedAt: Date.now(),
    };

    // Persist to DB
    this.persistPlugin(plugin);
    this.plugins.set(manifest.id, plugin);

    logger.info(`Installed plugin ${manifest.id} v${manifest.version}`);

    // Auto-enable if requested
    if (opts.enable) {
      await this.enablePlugin(plugin);
    }

    return plugin;
  }

  /** Install a plugin from a JSON manifest */
  async install(manifest: PluginManifest, sourcePath: string, opts: InstallOptions = {}): Promise<Plugin> {
    const resolvedPath = resolve(sourcePath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Plugin path not found: ${resolvedPath}`);
    }

    // Check if already exists
    if (this.plugins.has(manifest.id) && !opts.overwrite) {
      throw new Error(`Plugin ${manifest.id} already installed. Use overwrite=true to replace.`);
    }

    // Validate dependencies
    if (manifest.dependencies) {
      for (const dep of manifest.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Missing dependency: ${dep}`);
        }
      }
    }

    // Copy to plugin directory
    const targetPath = join(this.pluginDir, manifest.id);
    if (existsSync(targetPath)) {
      await this.removeDirectory(targetPath);
    }
    await this.copyDirectory(resolvedPath, targetPath);

    // Create plugin record
    const plugin: Plugin = {
      manifest,
      status: "installed",
      path: targetPath,
      configValues: {},
      installedAt: Date.now(),
    };

    // Persist to DB
    this.persistPlugin(plugin);
    this.plugins.set(manifest.id, plugin);

    logger.info(`Installed plugin ${manifest.id} v${manifest.version}`);

    // Enable if explicitly requested (default: disabled for security)
    if (opts.enable === true) {
      await this.enable(manifest.id);
    }

    return plugin;
  }

  /** Uninstall a plugin */
  async uninstall(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    // Disable first if enabled
    if (plugin.status === "enabled") {
      await this.disablePlugin(plugin);
    }

    // Remove from filesystem (secure recursive delete)
    if (existsSync(plugin.path)) {
      await fsPromises.rm(plugin.path, { recursive: true, force: true });
    }

    // Remove from DB
    this.db.run("DELETE FROM plugins WHERE id = ?", [pluginId]);
    this.plugins.delete(pluginId);

    logger.info(`Uninstalled plugin ${pluginId}`);
  }

  /** Enable a plugin (load its tools) */
  async enable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    await this.enablePlugin(plugin);
  }

  /** Disable a plugin (unload its tools) */
  async disable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    await this.disablePlugin(plugin);
  }

  /** Internal: enable plugin */
  private async enablePlugin(plugin: Plugin): Promise<void> {
    try {
      // Load module
      const entryPath = join(plugin.path, plugin.manifest.entry || "index.js");
      if (!existsSync(entryPath)) {
        throw new Error(`Entry file not found: ${entryPath}`);
      }

      // Dynamic import
      const module = await import(entryPath) as { default?: PluginModule; [key: string]: unknown };
      const pluginModule: PluginModule = module.default || module as unknown as PluginModule;

      // Register tools
      if (pluginModule.tools) {
        for (const tool of pluginModule.tools) {
          this.toolRegistry.add(tool);
          logger.debug(`Registered tool ${tool.name} from plugin ${plugin.manifest.id}`);
        }
      }

      // Call onEnable hook
      if (pluginModule.hooks?.onEnable) {
        await pluginModule.hooks.onEnable();
      }

      this.activeModules.set(plugin.manifest.id, pluginModule);
      plugin.status = "enabled";
      plugin.enabledAt = Date.now();
      plugin.error = undefined;

      logger.info(`Enabled plugin ${plugin.manifest.id}`);
    } catch (e: unknown) {
      plugin.status = "error";
      plugin.error = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to enable plugin ${plugin.manifest.id}: ${plugin.error}`);
    }

    this.persistPlugin(plugin);
  }

  /** Internal: disable plugin */
  private async disablePlugin(plugin: Plugin): Promise<void> {
    const module = this.activeModules.get(plugin.manifest.id);
    if (module?.hooks?.onDisable) {
      try {
        await module.hooks.onDisable();
      } catch (e: unknown) {
        logger.error(`Plugin ${plugin.manifest.id} onDisable hook failed: ${String(e)}`);
      }
    }

    this.activeModules.delete(plugin.manifest.id);
    plugin.status = "disabled";
    plugin.enabledAt = undefined;

    this.persistPlugin(plugin);
    logger.info(`Disabled plugin ${plugin.manifest.id}`);
  }

  /** Update plugin configuration */
  async configure(pluginId: string, values: Record<string, unknown>): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    plugin.configValues = { ...plugin.configValues, ...values };
    this.persistPlugin(plugin);
    logger.info(`Updated configuration for plugin ${pluginId}`);
  }

  /** Get a plugin by ID */
  get(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId);
  }

  /** List all plugins */
  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /** List available (built-in) plugins from the plugins directory */
  async listAvailable(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];
    if (!existsSync(this.pluginDir)) return manifests;

    for (const entry of readdirSync(this.pluginDir)) {
      const fullPath = join(this.pluginDir, entry);
      if (!statSync(fullPath).isDirectory()) continue;

      const manifestPath = join(fullPath, "plugin.json");
      if (existsSync(manifestPath)) {
        try {
          const content = await Bun.file(manifestPath).text();
          const manifest = JSON.parse(content) as PluginManifest;
          manifests.push(manifest);
        } catch {
          // Skip invalid manifests
        }
      }
    }
    return manifests;
  }

  /** Get all active tools from enabled plugins */
  getActiveTools(): { pluginId: string; tools: string[] }[] {
    const result: { pluginId: string; tools: string[] }[] = [];
    for (const [pluginId, module] of this.activeModules) {
      if (module.tools) {
        result.push({ pluginId, tools: module.tools.map((t) => t.name) });
      }
    }
    return result;
  }

  /** Copy directory recursively (cross-platform) */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await Bun.write(destPath, await Bun.file(srcPath).arrayBuffer());
      }
    }
  }

  /** Remove directory recursively (cross-platform) */
  private async removeDirectory(dir: string): Promise<void> {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.removeDirectory(fullPath);
        } else {
          await Bun.file(fullPath).delete();
        }
      }
      await Bun.file(dir).delete();
    } catch {
      // Directory may not exist
    }
  }

  /** Persist plugin state to SQLite */
  private persistPlugin(plugin: Plugin): void {
    const m = plugin.manifest;
    this.db.run(
      `
      INSERT OR REPLACE INTO plugins 
      (id, name, version, author, description, category, tags, entry, config, dependencies,
       requiresAxiom, icon, docsUrl, status, path, configValues, error, installedAt, enabledAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        m.id,
        m.name,
        m.version,
        m.author,
        m.description,
        m.category,
        JSON.stringify(m.tags),
        m.entry ?? "index.js",
        m.config ? JSON.stringify(m.config) : null,
        m.dependencies ? JSON.stringify(m.dependencies) : null,
        m.requiresAxiom || null,
        m.icon || null,
        m.docsUrl || null,
        plugin.status,
        plugin.path,
        JSON.stringify(plugin.configValues),
        plugin.error || null,
        plugin.installedAt || null,
        plugin.enabledAt || null,
      ]
    );
  }
}
