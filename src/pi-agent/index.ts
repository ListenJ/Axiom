/**
 * Pi Agent 集成模块 - 公共 API 导出
 *
 * 使用 Pi Agent 的本地工具执行代码检索，避免消耗 LLM token。
 * 本地工具：read, grep, find, ls（直接操作文件系统，零 token 消耗）
 */

export {
  PiCodeToolsAdapter,
  piCodeTools,
  type PiToolName,
  type PiToolResult,
  type PiCodeRetrievalOptions,
} from "./pi-code-tools.js";

export {
  PiAgentAdapter,
  piAgentAdapter,
  type PiAgentRetrievalResult,
  type PiAgentRetrievalOptions,
} from "./pi-agent-adapter.js";