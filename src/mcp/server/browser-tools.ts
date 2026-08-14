/**
 * 浏览器/视觉场景 MCP 工具 — browser_*
 *
 * 需求 3：无视觉模型时文本引导 + 无头浏览器精确定位 + 启动用户浏览器。
 * 全部走 ToolRegistry（微内核插件化），Windows/Linux 平台适配见
 * src/computer-use/browser-launch.ts。
 */
import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { buildTextGuide, type TextGuideResult } from "../../computer-use/text-guide.js";
import { launchUserBrowser, detectPlatform, type OpenPlatform } from "../../computer-use/browser-launch.js";
import { filterElementsByQuery, locateOnPage, type LocateQuery } from "../../computer-use/locate.js";
import { extractInteractiveElements } from "../../crawl/lightpanda-client.js";
import { logger } from "../../utils/logger.js";

export function registerBrowserTools(registry: ToolRegistry): void {
  registry.add({
    name: "browser_guide",
    description: "无视觉模型时的文本引导：基于 CDP 可交互元素（精确坐标）生成结构化操作引导（任务/元素表/建议操作/验证步骤）",
    exposure: ["external", "safe-external"],
    inputSchema: {
      task: z.string().describe("要完成的任务描述"),
      cdpUrl: z.string().optional().default("http://127.0.0.1:9222").describe("CDP 端点（无头浏览器）"),
      maxElements: z.number().int().min(1).max(200).optional().default(50).describe("元素表最多条数"),
    },
    handler: async (args: Record<string, unknown>) => {
      const task = args.task as string;
      const cdpUrl = (args.cdpUrl as string | undefined) ?? "http://127.0.0.1:9222";
      const maxElements = (args.maxElements as number | undefined) ?? 50;
      let elements: TextGuideResult["elements"] = [];
      let cdpOk = false;
      try {
        elements = await extractInteractiveElements(cdpUrl, 8000);
        cdpOk = true;
      } catch {
        cdpOk = false;
      }
      const guide = buildTextGuide(task, elements, { maxElements });
      return {
        cdpConnected: cdpOk,
        elementCount: elements.length,
        markdown: guide.markdown,
        suggestedActions: guide.suggestedActions,
        hint: cdpOk ? undefined : "CDP 不可达，元素表为空；可先用 browser_launch 打开页面，或检查无头浏览器。",
      };
    },
  });

  registry.add({
    name: "browser_locate",
    description: "无头浏览器精确定位：按文本/role/tag/index 查询页面元素，返回实测边界框（x/y/宽/高/中心）",
    exposure: ["external", "safe-external"],
    inputSchema: {
      cdpUrl: z.string().optional().default("http://127.0.0.1:9222").describe("CDP 端点（无头浏览器）"),
      text: z.string().optional().describe("元素文本子串（大小写不敏感）"),
      role: z.string().optional().describe("role 精确匹配"),
      tag: z.string().optional().describe("tag 精确匹配"),
      index: z.number().int().min(0).optional().describe("元素 index"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("返回条数"),
    },
    handler: async (args: Record<string, unknown>) => {
      const query: LocateQuery = {
        text: args.text as string | undefined,
        role: args.role as string | undefined,
        tag: args.tag as string | undefined,
        index: args.index as number | undefined,
      };
      const result = await locateOnPage({
        cdpUrl: (args.cdpUrl as string | undefined) ?? "http://127.0.0.1:9222",
        query,
        limit: (args.limit as number | undefined) ?? 20,
      });
      return result;
    },
  });

  registry.add({
    name: "browser_launch",
    description: "启动用户的默认浏览器打开指定 URL（Windows: start / Linux: xdg-open / macOS: open），用于真实页面核对与电脑操控",
    exposure: ["external", "safe-external"],
    inputSchema: {
      url: z.string().describe("要打开的 URL"),
      platform: z.enum(["win32", "linux", "darwin"]).optional().describe("平台覆盖（默认自动探测）"),
    },
    handler: async (args: Record<string, unknown>) => {
      const platform = (args.platform as OpenPlatform | undefined) ?? detectPlatform();
      const result = await launchUserBrowser(args.url as string, { platform });
      if (!result.launched) {
        throw new Error(`browser_launch failed: ${result.error ?? "unknown"}`);
      }
      return result;
    },
  });

  registry.add({
    name: "browser_locate_local",
    description: "对已提取的元素列表做本地过滤定位（不访问浏览器；供测试/离线场景）",
    exposure: ["external"],
    inputSchema: {
      elements: z.array(z.any()).describe("InteractiveElement 列表"),
      text: z.string().optional(),
      role: z.string().optional(),
      tag: z.string().optional(),
      index: z.number().int().min(0).optional(),
    },
    handler: async (args: Record<string, unknown>) => {
      const elements = (args.elements as unknown[]) as never[];
      const matches = filterElementsByQuery(elements as never, {
        text: args.text as string | undefined,
        role: args.role as string | undefined,
        tag: args.tag as string | undefined,
        index: args.index as number | undefined,
      });
      return { found: matches.length, matches };
    },
  });

  logger.info("[BrowserTools] registered browser_* tools");
}
