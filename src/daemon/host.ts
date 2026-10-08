/**
 * DRE 宿主集成装配 —— 组合根把 DRE daemon 客户端注入 `src/dre/host.ts` 的持有槽。
 *
 * 内核收敛后主服务 / MCP 不再在进程内构造 Kernel；`initDreKernel` 现指"连接 daemon"。
 * 保留函数名以兼容历史调用方。
 */
import { DreDaemonClient } from "./client.js";
import { isDreHostEnabled, setDreHostClient } from "../dre/host.js";
import { logger } from "../utils/logger.js";

let startPromise: Promise<DreDaemonClient | null> | null = null;

/**
 * 初始化（或复用）DRE daemon 客户端。幂等：并发调用共享同一次连接。
 * @returns 客户端；禁用或 daemon 不可达时返回 null（不抛，主服务继续）
 */
export async function initDreKernel(): Promise<DreDaemonClient | null> {
  if (!isDreHostEnabled()) {
    logger.info("[DRE] Host integration disabled (AXIOM_DRE_ENABLED=0)");
    return null;
  }
  if (!startPromise) {
    startPromise = (async () => {
      const c = new DreDaemonClient();
      await c.health();
      setDreHostClient(c);
      logger.info("[DRE] daemon client ready (host integration)", { url: c.url });
      return c;
    })().catch((err) => {
      startPromise = null;
      setDreHostClient(null);
      logger.error("[DRE] daemon unreachable; DRE capabilities disabled", err as Error);
      return null;
    });
  }
  return startPromise;
}

/** 清除客户端引用（幂等；不关闭 daemon——daemon 由 systemd/拥有者管理） */
export async function shutdownDreKernel(): Promise<void> {
  setDreHostClient(null);
  startPromise = null;
}

export { DreDaemonClient };
