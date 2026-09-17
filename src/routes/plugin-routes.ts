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
import { existsSync } from "fs";
import { PluginRegistry } from "../plugins/plugin-registry.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import { logger } from "../utils/logger.js";
import { readBool } from "../utils/env.js";

/**
 * 插件**写入**能力开关，默认 **关闭**。
 *
 * 决策（2026-09-14）：先不做插件生态，优先把内置工具优化好。
 * 原因是当前「manifest 声明权限、运行时零强制」属纯装饰 —— 不被强制的权限系统
 * 比没有权限系统更危险（虚假安全感）。等权限强制落地后再打开这个开关。
 *
 * 只影响写入（install/uninstall/enable/disable）；读接口始终可用。
 */
function pluginsEnabled(): boolean {
  return readBool("AXIOM_PLUGINS_ENABLED", false);
}

/** 写入被关闭时的统一响应 */
function pluginsDisabledResponse(operation: string): Response {
  return Response.json(
    {
      success: false,
      error: `插件${operation}能力当前已关闭（AXIOM_PLUGINS_ENABLED 未开启）`,
      detail:
        "本版本以内置工具为主，插件权限系统尚未做运行时强制，因此暂不开放安装/启停。" +
        "如确需启用，请设置 AXIOM_PLUGINS_ENABLED=1 —— " +
        "但请注意：manifest 中声明的 permissions 目前**不会**被运行时强制执行。",
    },
    { status: 403 },
  );
}

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
          overwrite?: boolean;
        };

        if (!body.path) {
          return Response.json(
            { success: false, error: "Plugin path is required" },
            { status: 400 }
          );
        }

        if (!pluginsEnabled()) return pluginsDisabledResponse("安装");

        // 安装路径解析（2026-07-26 W3 修复）：
        // 前端安装按钮只传 pluginId —— 目录不存在时回退到内置可用目录 ./plugins/<id>
        let installPath = body.path;
        if (!existsSync(installPath)) {
          const candidate = join("./plugins", body.path);
          if (existsSync(candidate)) {
            logger.info(`[Plugins] path '${body.path}' resolved to available dir '${candidate}'`);
            installPath = candidate;
          }
        }

        const plugin = await registry.installFromPath(installPath, {
          enable: body.enable ?? true,
          overwrite: body.overwrite ?? false,
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
        if (!pluginsEnabled()) return pluginsDisabledResponse("卸载");
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
        if (!pluginsEnabled()) return pluginsDisabledResponse("启用");
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
        if (!pluginsEnabled()) return pluginsDisabledResponse("停用");
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
