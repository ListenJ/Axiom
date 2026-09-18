/**
 * 神经突触心智模块 — 公共入口
 *
 * 心智模块 = SynapseEngine（确定性） + SynapseStore（SQLite 持久化 + 验证链）。
 * 通过 MCP 工具（mind_synapse_*）暴露给外部 Agent / skill / 插件调用。
 */
export * from "./types.js";
export {
  SynapseStore,
  synapseHash,
  synapseId,
  computeSynapseVerifyHash,
  computeTraceHash,
  GENESIS_HASH,
  makeSynapse,
} from "./store.js";
export {
  SynapseEngine,
  createSynapseEngine,
  createLocalModelAssist,
  tokenize,
} from "./engine.js";
