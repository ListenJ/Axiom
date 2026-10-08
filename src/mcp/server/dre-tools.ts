/**
 * 兼容 shim：DRE 工具面已迁至中立层 `src/tool-face/dre-tools.ts`（ADR-012「内核工具暴露面」）。
 * 保留本路径仅为兼容既有 import；新代码请直接引 `src/tool-face`。这里保留一个真正的
 * `registerDreTools` 函数声明（除转发外无逻辑），以满足 `mcp/server/*-tools.ts` 的结构门禁。
 */
export * from "../../tool-face/dre-tools.js";
import { registerDreTools as _registerDreTools } from "../../tool-face/dre-tools.js";

export function registerDreTools(...args: Parameters<typeof _registerDreTools>): ReturnType<typeof _registerDreTools> {
  return _registerDreTools(...args);
}
