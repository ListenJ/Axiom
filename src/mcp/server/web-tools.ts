/**
 * 联网检索工具面 —— web_fetch / web_search / search_engines_list。
 *
 * 与 vault-tools.ts 拆分的动机：Vault 记忆工具（memory_*）与知识图谱（KG）是
 * 纯本地能力，不应随插件打包带入联网检索代码；联网检索仅保留在宿主 Agent
 * （个人使用），不进入知识库插件队列。
 */
import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import type { DataPipeline } from "../../crawl/data-pipeline.js";
import { searchAggregator } from "../../crawl/search-engines.js";

export function registerWebTools(registry: ToolRegistry, pipeline: DataPipeline): void {
  registry.add({
    name: "web_fetch",
    description: "抓取网页并提取结构化数据（自动写入 Vault 记忆库）",
    inputSchema: { url: z.string().url().describe("目标 URL") },
    handler: async (args) => {
      const result = await pipeline.crawlStructured(args.url as string);
      if (!result) return { error: "Failed to fetch URL" };
      return {
        url: result.url, title: result.title, description: result.description,
        headings: result.headings.length, tables: result.tables.length,
        codeBlocks: result.codeBlocks.length, images: result.images.length, savedToVault: true,
      };
    },
  });

  registry.add({
    name: "web_search",
    description: "多引擎搜索（结果自动写入 Vault）",
    exposure: ["external", "safe-external"],
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      engines: z.array(z.string()).optional().describe("引擎列表"),
      num: z.number().optional().default(10).describe("每个引擎数量"),
    },
    handler: async (args) => pipeline.searchMulti(args.query as string, {
      engines: args.engines as string[], num: args.num as number,
    }),
  });

  registry.add({
    name: "search_engines_list",
    description: "列出可用搜索引擎",
    exposure: ["external", "safe-external"],
    inputSchema: {},
    handler: async () => searchAggregator.listEngines(),
  });
}
