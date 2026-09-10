/**
 * MCP 工具计数（单一事实源生成器）
 *
 * 以 `src/testing/tool-count.ts` 的动态权威统计为准，
 * 直接生成供文档引用的片段，杜绝数字漂移（历史 133/150/172/173 为旧值）。
 *
 * 用法：`bun run scripts/count-tools.mjs`
 */
import { countMcpTools } from "../src/testing/tool-count.ts";

const { total, duplicates, breakdown } = countMcpTools();
const fragment = `本系统共注册 ${total} 个去重 MCP 工具（权威计数以 \`src/testing/tool-count.ts\` 为准，\`bun run scripts/count-tools.mjs\` 直接生成；历史 133/150/172/173 为旧值）。`;

console.log(JSON.stringify({ total, duplicates, breakdown }, null, 2));
console.log(fragment);
