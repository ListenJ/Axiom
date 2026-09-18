/**
 * 代理状态路由 — 返回系统代理配置
 */
import type { RouteContext } from "./types.js";
import { readString } from "../utils/env.js";

export async function handleProxies(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/proxies") return null;
  if (ctx.req.method !== "GET") return null;

  // 从环境变量读取代理配置
  const httpProxy = readString("HTTP_PROXY") || readString("http_proxy");
  const httpsProxy = readString("HTTPS_PROXY") || readString("https_proxy");

  const proxies = [];

  if (httpProxy) {
    try {
      const url = new URL(httpProxy);
      proxies.push({
        host: url.hostname,
        port: url.port || "80",
        protocol: url.protocol,
        country: "system",
        active: true,
      });
    } catch {
      proxies.push({
        host: httpProxy,
        port: "",
        protocol: "http:",
        country: "system",
        active: true,
      });
    }
  }

  if (httpsProxy && httpsProxy !== httpProxy) {
    try {
      const url = new URL(httpsProxy);
      proxies.push({
        host: url.hostname,
        port: url.port || "443",
        protocol: url.protocol,
        country: "system",
        active: true,
      });
    } catch {
      proxies.push({
        host: httpsProxy,
        port: "",
        protocol: "https:",
        country: "system",
        active: true,
      });
    }
  }

  return ctx.jsonResponse(proxies, 200, ctx.baseHeaders);
}
