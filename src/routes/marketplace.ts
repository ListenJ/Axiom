/**
 * Skill / MCP 广场路由
 *
 * GET  /marketplace                    — 受控白名单目录（skills / mcpServers / registries）
 * POST /marketplace/skills/install     — 按白名单 id 执行 npx skills add
 * POST /marketplace/mcp/install        — 按白名单 id 写入 config/mcp-servers.yaml
 *
 * 安全：安装 id 必须命中白名单，不接受任意命令/配置注入。
 */
import { spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import YAML from "yaml";
import type { RouteContext } from "./types.js";
import { requireAuthToken, auditSuccess } from "./route-auth.js";

const MARKETPLACE_PATH = "config/marketplace.yaml";
const MCP_CONFIG_PATH = "config/mcp-servers.yaml";
const INSTALL_TIMEOUT_MS = 120_000;

interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  source: string;
  package?: string;
  category: string;
  url: string;
  install: string;
}

interface MarketplaceMcp {
  id: string;
  name: string;
  description: string;
  type: string;
  endpoint?: string;
  url?: string;
  command?: string;
  args?: string[];
  category: string;
}

function loadMarketplace(): {
  skills: MarketplaceSkill[];
  mcpServers: MarketplaceMcp[];
  registries: Array<{ id: string; name: string; description: string; url: string }>;
} {
  try {
    const doc = YAML.parse(readFileSync(MARKETPLACE_PATH, "utf-8")) as {
      skills?: MarketplaceSkill[];
      mcpServers?: MarketplaceMcp[];
      registries?: Array<{ id: string; name: string; description: string; url: string }>;
    };
    return {
      skills: doc?.skills ?? [],
      mcpServers: doc?.mcpServers ?? [],
      registries: doc?.registries ?? [],
    };
  } catch {
    return { skills: [], mcpServers: [], registries: [] };
  }
}

function runInstall(command: string): Promise<{ ok: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const parts = command.split(/\s+/).filter(Boolean);
    const [bin, ...args] = parts;
    if (!bin) {
      resolve({ ok: false, output: "", error: "Empty install command" });
      return;
    }
    const proc = spawn(bin, args, {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
    }, INSTALL_TIMEOUT_MS);
    proc.stdout?.on("data", (d) => (stdout += String(d)));
    proc.stderr?.on("data", (d) => (stderr += String(d)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        output: (stdout || stderr).trim(),
        error: code === 0 ? undefined : (stderr || stdout).trim() || `exit ${code}`,
      });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: e.message });
    });
  });
}

export async function handleMarketplace(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;

  if (path === "/marketplace" && ctx.req.method === "GET") {
    return ctx.jsonResponse(loadMarketplace(), 200, ctx.baseHeaders);
  }

  if (path === "/marketplace/skills/install" && ctx.req.method === "POST") {
    const authErr = requireAuthToken(ctx);
    if (authErr) return authErr;
    const body = (await ctx.req.json().catch(() => ({}))) as { id?: string };
    const skill = loadMarketplace().skills.find((s) => s.id === body.id);
    if (!skill) {
      return ctx.jsonResponse({ error: `Unknown skill: ${body.id}` }, 404, ctx.baseHeaders);
    }
    const result = await runInstall(skill.install);
    auditSuccess(ctx, "skill.install", skill.id, { ok: result.ok });
    return ctx.jsonResponse(
      {
        success: result.ok,
        id: skill.id,
        name: skill.name,
        message: result.ok ? `已安装：${skill.name}` : undefined,
        output: result.output,
        error: result.error,
      },
      result.ok ? 200 : 502,
      ctx.baseHeaders,
    );
  }

  if (path === "/marketplace/mcp/install" && ctx.req.method === "POST") {
    const authErr = requireAuthToken(ctx);
    if (authErr) return authErr;
    const body = (await ctx.req.json().catch(() => ({}))) as { id?: string };
    const entry = loadMarketplace().mcpServers.find((s) => s.id === body.id);
    if (!entry) {
      return ctx.jsonResponse({ error: `Unknown MCP server: ${body.id}` }, 404, ctx.baseHeaders);
    }
    try {
      const existing = YAML.parse(readFileSync(MCP_CONFIG_PATH, "utf-8")) as {
        servers?: Record<string, unknown>;
      } | null;
      const servers = existing?.servers ?? {};
      const config: Record<string, unknown> = { type: entry.type };
      if (entry.type === "remote" && entry.endpoint) config.url = entry.endpoint;
      if (entry.command) {
        config.command = entry.command;
        if (entry.args) config.args = entry.args;
      }
      servers[entry.id] = config;
      const header = "# MCP服务器注册配置（由 Axiom 市场管理写入）\n# 免费方案：无需 API Key，开箱即用\n# 运行时：统一使用 bun/bunx（非 node/npx）\n";
      writeFileSync(MCP_CONFIG_PATH, header + YAML.stringify({ servers }), "utf-8");
      auditSuccess(ctx, "mcp.install", entry.id, { ok: true });
      return ctx.jsonResponse(
        { success: true, id: entry.id, name: entry.name, message: "已写入 config/mcp-servers.yaml，重启后连接生效" },
        200,
        ctx.baseHeaders,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ success: false, error: msg }, 500, ctx.baseHeaders);
    }
  }

  return null;
}
