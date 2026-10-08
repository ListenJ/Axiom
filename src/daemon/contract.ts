/**
 * DRE daemon 契约面版本与能力清单（ADR-012 的统一 API 管理）。
 *
 * 外围组件（主服务 / MCP / 插件）通过 `GET /version` 读取本契约版本与能力清单，
 * 据此做能力协商与降级——这样核心升级时，外围可判断"我支持的面是否仍在"，
 * 而不是直接被打挂。
 *
 * 规则（见 docs/decisions/ADR-012-kernel-boundary-and-api-contract.md）：
 * - 契约版本 `MAJOR.MINOR.PATCH`；
 * - MINOR 只增（新增方法/字段/端点）；MAJOR 才允许破坏性变更且须保留旧面一个发布周期。
 */
import { APP_VERSION } from "../version.js";

/** 契约面版本（新增端点/字段时 +MINOR；破坏性变更才 +MAJOR） */
export const DRE_DAEMON_CONTRACT_VERSION = "1.1.0";

/** 本 daemon 提供的契约能力（机器可读的能力发现） */
export const DRE_DAEMON_CAPABILITIES = [
  "port.knowledge",
  "dre.run",
  "dre.tool",
  "dre.retrieve",
  "dre.status",
  "dre.cognitive_state",
  "events",
] as const;

export interface DreDaemonVersionInfo {
  service: "dre-daemon";
  appVersion: string;
  contractVersion: string;
  capabilities: readonly string[];
}

export function dreDaemonVersionInfo(): DreDaemonVersionInfo {
  return {
    service: "dre-daemon",
    appVersion: APP_VERSION,
    contractVersion: DRE_DAEMON_CONTRACT_VERSION,
    capabilities: DRE_DAEMON_CAPABILITIES,
  };
}
