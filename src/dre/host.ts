/**
 * DRE 宿主集成 —— **客户端引用持有者（接口在本层，具体实现由组合根注入）**。
 *
 * 内核收敛（2026-10-08）：唯一 Kernel 拥有者 = DRE daemon。主服务 / MCP 作为客户端接入；
 * 本模块只声明"内核客户端"接口与持有槽，**不 import 具体实现**（避免 src/dre ↔ src/daemon
 * 顶层目录互相 import 触发架构完整性门的循环判定）。具体连接由 `src/daemon/host.ts` 注入。
 */
import { readBool } from "../utils/env.js";

/** 主服务所需的内核客户端最小面（DreDaemonClient 结构上满足） */
export interface DreHostClient {
  readonly url: string;
  health(): Promise<{ ok: boolean; state?: string; uptime?: number }>;
  status<T = unknown>(): Promise<{ ok: boolean; status: T }>;
  cognitiveState<T = unknown>(): Promise<{ ok: boolean; state: T }>;
  run(input: string): Promise<{ ok: boolean; [k: string]: unknown }>;
  /** DRE 检索段（确定性检索 + 知识图谱）：结果在唯一内核拥有者（daemon）内计算 */
  retrieve<T = unknown>(query: string, limit?: number): Promise<T | null>;
  openEvents(): Promise<Response>;
}

let client: DreHostClient | null = null;

/** 主服务是否启用 DRE 宿主集成（AXIOM_DRE_ENABLED，默认 1） */
export function isDreHostEnabled(): boolean {
  return readBool("AXIOM_DRE_ENABLED", true);
}

/** 注入（或清除）内核客户端；由组合根（src/daemon/host.ts）调用 */
export function setDreHostClient(c: DreHostClient | null): void {
  client = c;
}

/** 当前已就绪的内核客户端（未就绪返回 null） */
export function getDreKernel(): DreHostClient | null {
  return client;
}
