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

  registry.add({
    name: "frontend_visual_review",
    description: "前端视觉审核：对 URL 截图（CDP）或直接图片，用 SenseNova 视觉模型输出结构化审核（布局/对比度/交互/一致性/渲染）",
    exposure: ["external", "safe-external"],
    inputSchema: {
      url: z.string().optional().describe("要审核的前端 URL（与 imageBase64 二选一；需 CDP 端点）"),
      imageBase64: z.string().optional().describe("图片 base64（与 url 二选一）"),
      cdpUrl: z.string().optional().default("http://127.0.0.1:9222").describe("CDP 端点（url 模式）"),
    },
    handler: async (args: Record<string, unknown>) => {
      const { reviewFrontendScreenshot, reviewFrontendUrl } = await import("../../computer-use/frontend-review.js");
      if (args.imageBase64) return reviewFrontendScreenshot(args.imageBase64 as string);
      if (args.url) return reviewFrontendUrl(args.url as string, { cdpUrl: (args.cdpUrl as string | undefined) ?? "http://127.0.0.1:9222" });
      throw new Error("frontend_visual_review requires url or imageBase64");
    },
  });

  registry.add({
    name: "frontend_audit",
    description: "前端页面审核流水线：对一组页面逐页截图（Playwright 无头）→ SenseNova 视觉审核 → 汇总报告（verdict/问题/统计）",
    exposure: ["external", "safe-external"],
    inputSchema: {
      baseUrl: z.string().optional().default("http://127.0.0.1:18790").describe("前端基准地址"),
      pages: z.array(z.string()).optional().describe("页面路径列表（默认全部可见页）"),
      concurrency: z.number().int().min(1).max(8).optional().default(2).describe("并发数"),
    },
    handler: async (args: Record<string, unknown>) => {
      const { auditFrontendPages, DEFAULT_AUDIT_PAGES } = await import("../../computer-use/frontend-audit.js");
      const pages = Array.isArray(args.pages) && (args.pages as string[]).length > 0
        ? (args.pages as string[]).map((p) => ({ path: p, label: p }))
        : DEFAULT_AUDIT_PAGES;
      const report = await auditFrontendPages((args.baseUrl as string | undefined) ?? "http://127.0.0.1:18790", pages, { concurrency: args.concurrency as number | undefined });
      return { baseUrl: report.baseUrl, auditedAt: report.auditedAt, totals: report.totals, pages: report.pages, markdown: report.markdown };
    },
  });

  logger.info("[BrowserTools] registered browser_* tools");
}
