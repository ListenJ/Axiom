/**
 * DRE daemon 契约面版本与能力清单（ADR-012 的统一 API 管理）。
 *
 * 外围组件（主服务 / MCP / 插件）通过 `GET /version` 读取契约版本与能力清单，
 * 据此做能力协商与降级——核心升级时外围可判断"我支持的面是否仍在"。
 *
 * 规则（见 docs/decisions/ADR-012-kernel-boundary-and-api-contract.md）：
 * - 契约版本 `MAJOR.MINOR.PATCH`；MINOR 只增，MAJOR 才允许破坏性变更且须保留旧面一个周期；
 * - **capabilities 实况化（ADR-012 §7-2）**：不再是一份手维护的静态清单，而是由 daemon
 *   的**运行时事实**推导（如上线的工具数、检索依赖是否可用），避免"声明了却没实现"的漂移。
 */
import { APP_VERSION } from "../version.js";

/** 契约面版本（新增端点/字段时 +MINOR；破坏性变更才 +MAJOR） */
export const DRE_DAEMON_CONTRACT_VERSION = "1.2.0";

/** 恒由代码提供的端点能力（daemon 启动即挂载，不随运行态变化） */
export const DRE_DAEMON_BASE_CAPABILITIES = [
  "port.knowledge",
  "dre.run",
  "dre.status",
  "dre.cognitive_state",
  "events",
] as const;

/** daemon 运行时事实（用于推导实况能力） */
export interface DreDaemonRuntime {
  /** 已注册的工具处理器数（>0 才声明 dre.tool） */
  toolsRegistered: number;
  /** 检索依赖是否加载成功（true 才声明 dre.retrieve） */
  retrievalReady: boolean;
}

export interface DreDaemonVersionInfo {
  service: "dre-daemon";
  appVersion: string;
  contractVersion: string;
  capabilities: string[];
  runtime: DreDaemonRuntime;
}

/** 由运行时事实推导实况能力清单（base + 条件能力） */
export function dreDaemonVersionInfo(rt: DreDaemonRuntime): DreDaemonVersionInfo {
  const capabilities: string[] = [...DRE_DAEMON_BASE_CAPABILITIES];
  if (rt.toolsRegistered > 0) capabilities.push("dre.tool");
  if (rt.retrievalReady) capabilities.push("dre.retrieve");
  return {
    service: "dre-daemon",
    appVersion: APP_VERSION,
    contractVersion: DRE_DAEMON_CONTRACT_VERSION,
    capabilities,
    runtime: rt,
  };
}
