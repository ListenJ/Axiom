/**
 * Plugin Management API Routes
 * 
 * Provides REST endpoints for the plugin market:
 * - GET /plugins - List all plugins
 * - GET /plugins/available - List available (built-in) plugins
 * - GET /plugins/:id - Get plugin details
 * - POST /plugins/install - Install a plugin from path
 * - POST /plugins/:id/uninstall - Uninstall a plugin
 * - POST /plugins/:id/enable - Enable a plugin
 * - POST /plugins/:id/disable - Disable a plugin
 * - POST /plugins/:id/config - Update plugin configuration
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { PluginRegistry } from "../plugins/plugin-registry.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import { logger } from "../utils/logger.js";

/** Create plugin management routes */
export function createPluginRoutes(db: Database, toolRegistry: ToolRegistry) {
  const registry = new PluginRegistry(db, toolRegistry);

  return {
    // GET /plugins - List all installed plugins
    list: async (req: Request): Promise<Response> => {
      try {
        const plugins = registry.list();
        return Response.json({
          success: true,
          plugins: plugins.map((p) => ({
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            author: p.manifest.author,
            description: p.manifest.description,
            category: p.manifest.category,
            tags: p.manifest.tags,
            status: p.status,
            installedAt: p.installedAt,
            enabledAt: p.enabledAt,
          })),
        });
      } catch (e: unknown) {
        logger.error(`Failed to list plugins: ${String(e)}`);
        return Response.json(
          { success: false, error: "Failed to list plugins" },
          { status: 500 }
        );
      }
    },

    // GET /plugins/available - List available built-in plugins
    listAvailable: async (req: Request): Promise<Response> => {
      try {
        const manifests = await registry.listAvailable();
        return Response.json({
          success: true,
          plugins: manifests,
        });
      } catch (e: unknown) {
        logger.error(`Failed to list available plugins: ${String(e)}`);
        return Response.json(
          { success: false, error: "Failed to list available plugins" },
          { status: 500 }
        );
      }
    },

    // GET /plugins/:id - Get plugin details
    get: async (req: Request, { id }: Record<string, string>): Promise<Response> => {
      try {
        const plugin = registry.get(id);
        if (!plugin) {
          return Response.json(
            { success: false, error: `Plugin not found: ${id}` },
            { status: 404 }
          );
        }

        return Response.json({
          success: true,
          plugin: {
            manifest: plugin.manifest,
            status: plugin.status,
            configValues: plugin.configValues,
            error: plugin.error,
            installedAt: plugin.installedAt,
            enabledAt: plugin.enabledAt,
          },
        });
      } catch (e: unknown) {
        logger.error(`Failed to get plugin ${id}: ${String(e)}`);
        return Response.json(
          { success: false, error: "Failed to get plugin" },
          { status: 500 }
        );
      }
    },

    // POST /plugins/install - Install a plugin
    install: async (req: Request): Promise<Response> => {
      try {
        const body = (await req.json()) as {
          path: string;
          enable?: boolean;
        };

        if (!body.path) {
          return Response.json(
            { success: false, error: "Plugin path is required" },
            { status: 400 }
          );
        }

        const plugin = await registry.installFromPath(body.path, {
          enable: body.enable ?? true,
        });

        return Response.json({
          success: true,
          plugin: {
            id: plugin.manifest.id,
            name: plugin.manifest.name,
            version: plugin.manifest.version,
            status: plugin.status,
          },
        });
      } catch (e: unknown) {
        logger.error(`Failed to install plugin: ${String(e)}`);
        return Response.json(
          { success: false, error: String(e) },
          { status: 500 }
        );
      }
    },

    // POST /plugins/:id/uninstall - Uninstall a plugin
    uninstall: async (req: Request, { id }: Record<string, string>): Promise<Response> => {
      try {
        await registry.uninstall(id);
        return Response.json({ success: true, message: `Plugin ${id} uninstalled` });
      } catch (e: unknown) {
        logger.error(`Failed to uninstall plugin ${id}: ${String(e)}`);
        return Response.json(
          { success: false, error: String(e) },
          { status: 500 }
        );
      }
    },

    // POST /plugins/:id/enable - Enable a plugin
    enable: async (req: Request, { id }: Record<string, string>): Promise<Response> => {
      try {
        await registry.enable(id);
        return Response.json({ success: true, message: `Plugin ${id} enabled` });
      } catch (e: unknown) {
        logger.error(`Failed to enable plugin ${id}: ${String(e)}`);
        return Response.json(
          { success: false, error: String(e) },
          { status: 500 }
        );
      }
    },

    // POST /plugins/:id/disable - Disable a plugin
    disable: async (req: Request, { id }: Record<string, string>): Promise<Response> => {
      try {
        await registry.disable(id);
        return Response.json({ success: true, message: `Plugin ${id} disabled` });
      } catch (e: unknown) {
        logger.error(`Failed to disable plugin ${id}: ${String(e)}`);
        return Response.json(
          { success: false, error: String(e) },
          { status: 500 }
        );
      }
    },

    // POST /plugins/:id/config - Update plugin configuration
    configure: async (req: Request, { id }: Record<string, string>): Promise<Response> => {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        await registry.configure(id, body);
        return Response.json({
          success: true,
          message: `Plugin ${id} configuration updated`,
        });
      } catch (e: unknown) {
        logger.error(`Failed to configure plugin ${id}: ${String(e)}`);
        return Response.json(
          { success: false, error: String(e) },
          { status: 500 }
        );
      }
    },

    // GET /plugins/active-tools - Get active tools from all enabled plugins
    activeTools: async (req: Request): Promise<Response> => {
      try {
        const tools = registry.getActiveTools();
        return Response.json({ success: true, tools });
      } catch (e: unknown) {
        logger.error(`Failed to get active tools: ${String(e)}`);
        return Response.json(
          { success: false, error: "Failed to get active tools" },
          { status: 500 }
        );
      }
    },
  };
}
