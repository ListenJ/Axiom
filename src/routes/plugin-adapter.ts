/**
 * Plugin routes adapter — integrates with main route dispatcher
 * 
 * Wraps createPluginRoutes to match RouteHandler signature.
 */
import { Database } from "bun:sqlite";
import type { RouteContext } from "./types.js";
import { createPluginRoutes } from "./plugin-routes.js";
import { ToolRegistry } from "../mcp/tool-registry.js";

let pluginRoutes: ReturnType<typeof createPluginRoutes> | null = null;
let routeRegistry: ToolRegistry | null = null;

/** Initialize plugin routes (call once at startup) */
export function initPluginRoutes(db: Database, toolRegistry: ToolRegistry): void {
  pluginRoutes = createPluginRoutes(db, toolRegistry);
  routeRegistry = toolRegistry;
}

/** Get the tool registry used by plugins */
export function getPluginToolRegistry(): ToolRegistry | null {
  return routeRegistry;
}

/** Route handler for /plugins/* */
export async function handlePluginRoutes(ctx: RouteContext): Promise<Response | null> {
  if (!pluginRoutes) return null;

  const { url, req } = ctx;
  const path = url.pathname;

  // GET /plugins - List installed plugins
  if (path === "/plugins" && req.method === "GET") {
    return pluginRoutes.list(req);
  }

  // GET /plugins/available - List available plugins
  if (path === "/plugins/available" && req.method === "GET") {
    return pluginRoutes.listAvailable(req);
  }

  // GET /plugins/active-tools - Get active tools
  if (path === "/plugins/active-tools" && req.method === "GET") {
    return pluginRoutes.activeTools(req);
  }

  // POST /plugins/install - Install a plugin
  if (path === "/plugins/install" && req.method === "POST") {
    return pluginRoutes.install(req);
  }

  // Match /plugins/:id/* patterns
  const pluginDetailMatch = path.match(/^\/plugins\/([^/]+)$/);
  if (pluginDetailMatch) {
    const id = pluginDetailMatch[1];
    // GET /plugins/:id - Get plugin details
    if (req.method === "GET") {
      return pluginRoutes.get(req, { id });
    }
  }

  // Match /plugins/:id/action patterns
  const pluginActionMatch = path.match(/^\/plugins\/([^/]+)\/(uninstall|enable|disable|config)$/);
  if (pluginActionMatch) {
    const id = pluginActionMatch[1];
    const action = pluginActionMatch[2];

    switch (action) {
      case "uninstall":
        if (req.method === "POST") {
          return pluginRoutes.uninstall(req, { id });
        }
        break;
      case "enable":
        if (req.method === "POST") {
          return pluginRoutes.enable(req, { id });
        }
        break;
      case "disable":
        if (req.method === "POST") {
          return pluginRoutes.disable(req, { id });
        }
        break;
      case "config":
        if (req.method === "POST") {
          return pluginRoutes.configure(req, { id });
        }
        break;
    }
  }

  return null;
}
