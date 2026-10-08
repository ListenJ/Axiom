/**
 * DRE Daemon —— Axiom Runtime 内核的**唯一拥有者**（内核收敛 Step 2）。
 *
 * 决策（用户 2026-10-08 裁定）：唯一 Kernel 拥有者 = DRE daemon。它在本进程内构造并持有
 * 唯一的 `Kernel`（经 `createDreKernel` 工厂），对外提供 HTTP 面；其它入口（主服务、MCP）
 * 作为客户端访问，不再各自 `new Kernel`——从而消除"多套运行时状态 + 多进程写同一库"。
 *
 * 暴露面（v1，按需最小）：
 *   GET  /health                → 存活 + 内核状态
 *   GET  /dre/status            → KernelStatus
 *   GET  /dre/cognitive-state   → DREngine.getCognitiveState()
 *   POST /api/port              → 端口协议（knowledge.*），复用 src/dre/port
 *   POST /dre/run               → 纯确定性认知管道（CognitivePipeline）
 *   GET  /events                → SSE：cognitive.* 事件转发（供主服务 /pipeline/stream）
 *
 * 配置：`AXIOM_DRE_DAEMON_PORT`（默认 18790，绑 127.0.0.1）；可选 `AXIOM_DRE_DAEMON_TOKEN`
 * （设置后所有请求须带 `x-axiom-token`，常量时间比较）。
 */
import { createDreKernel, CognitivePipeline } from "../dre/index.js";
import { buildDreCompositionOverrides } from "./overrides.js";
import { dreDaemonVersionInfo } from "./contract.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import { registerDreTools } from "../mcp/server/dre-tools.js";
import { LocalKnowledgePort } from "../dre/port/index.js";
import { eventBus, type RuntimeEvent } from "../dre/runtime/event-bus.js";
import { readInt, readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

const COGNITIVE_EVENT_TYPES = [
  "cognitive.step.classify",
  "cognitive.step.knowledge",
  "cognitive.step.reasoning",
  "cognitive.step.constraint",
  "cognitive.step.action",
  "cognitive.step.reflection",
  "cognitive.pipeline.completed",
  "cognitive.pipeline.fallback",
];

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface DreDaemonHandle {
  port: number;
  stop: () => Promise<void>;
}

/** 启动 DRE daemon；返回句柄（含实际绑定端口与 stop）。 */
export async function startDreDaemon(opts?: { port?: number; hostname?: string }): Promise<DreDaemonHandle> {
  // 组合根注入（cloudCaller / hallucinationGate / recordVerdict）：与旧主服务一致，
  // 但归属唯一内核拥有者（daemon）。db 惰性解析——init 后才有连接。
  let dbHolder: import("bun:sqlite").Database | null = null;
  const overrides = await buildDreCompositionOverrides(() => dbHolder);
  const kernel = createDreKernel({ overrides });
  await kernel.init();
  const engine = kernel.getEngine();
  dbHolder = engine.getDb();
  const port = new LocalKnowledgePort(engine.knowledgeStore, { db: engine.getDb() });

  // DRE MCP 工具面：唯一内核拥有者在本进程用**自己的引擎**执行处理器；
  // MCP 进程只注册薄转发（POST /dre/tool）。默认 guard = defaultToolGuard，安全不降级。
  const dreRegistry = new ToolRegistry();
  registerDreTools(dreRegistry, { engineProvider: async () => engine });
  const dreToolHandlers = dreRegistry.buildHttpHandlers();

  const bindPort = opts?.port ?? readInt("AXIOM_DRE_DAEMON_PORT", 18790);
  const hostname = opts?.hostname ?? "127.0.0.1";
  const token = readString("AXIOM_DRE_DAEMON_TOKEN", "");

  const authorized = (req: Request): boolean => {
    if (!token) return true;
    return constantTimeEqual(req.headers.get("x-axiom-token") ?? "", token);
  };

  const server = Bun.serve({
    port: bindPort,
    hostname,
    idleTimeout: 255, // SSE 需要长连接（Bun 上限 255s）
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/version" && req.method === "GET") {
        return json({ ok: true, ...dreDaemonVersionInfo() });
      }

      if (url.pathname === "/health" && req.method === "GET") {
        const st = kernel.getStatus();
        return json({ ok: true, state: st.state, uptime: st.uptime, version: "dre-daemon" });
      }

      if (!authorized(req)) return json({ ok: false, error: "unauthorized" }, 401);

      if (url.pathname === "/dre/status" && req.method === "GET") {
        return json({ ok: true, status: kernel.getStatus() });
      }
      if (url.pathname === "/dre/cognitive-state" && req.method === "GET") {
        return json({ ok: true, state: engine.getCognitiveState() });
      }

      if (url.pathname === "/api/port" && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ requestId: "", ok: false, durationMs: 0, error: { code: "VALIDATION_ERROR", message: "invalid JSON", retriable: false } }, 400);
        }
        const res = await port.execute(body as Parameters<typeof port.execute>[0]);
        return json(res, res.ok ? 200 : 400);
      }

      if (url.pathname === "/dre/tool" && req.method === "POST") {
        let body: { name?: unknown; args?: unknown } = {};
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ ok: false, error: "invalid JSON" }, 400);
        }
        const name = typeof body.name === "string" ? body.name : "";
        const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
        const handler = dreToolHandlers[name];
        if (!handler) return json({ ok: false, error: `unknown DRE tool: ${name}` }, 404);
        const result = await handler(args);
        return json({ ok: true, result });
      }

      if (url.pathname === "/dre/run" && req.method === "POST") {
        let body: { input?: unknown; prompt?: unknown } = {};
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ ok: false, error: "invalid JSON" }, 400);
        }
        const input =
          (typeof body.input === "string" ? body.input : "") ||
          (typeof body.prompt === "string" ? body.prompt : "");
        if (!input.trim()) return json({ ok: false, error: "input required" }, 400);
        try {
          const result = await new CognitivePipeline(engine).run(input);
          return json({ ok: true, ...result });
        } catch (err) {
          return json({ ok: false, error: (err as Error).message }, 500);
        }
      }

      if (url.pathname === "/events" && req.method === "GET") {
        const encoder = new TextEncoder();
        const subs: string[] = [];
        const stream = new ReadableStream({
          start(controller) {
            const send = (chunk: string) => {
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                /* 连接已断，close 由 cancel/清理负责 */
              }
            };
            const lastStep = (engine.getCognitiveState() as { pipeline?: { lastStep?: string } } | undefined)?.pipeline?.lastStep ?? "idle";
            send(`data: ${JSON.stringify({ type: "step", stage: lastStep, progress: 0 })}\n\n`);
            for (const evt of COGNITIVE_EVENT_TYPES) {
              subs.push(
                eventBus.subscribe(evt, (event: RuntimeEvent) => {
                  if (event.type.startsWith("cognitive.step.")) {
                    const stage = event.type.replace("cognitive.step.", "");
                    const data = (event.data ?? {}) as Record<string, unknown>;
                    send(`data: ${JSON.stringify({ type: "step", stage, progress: (data.step as number) ?? 0, message: (data.output as string) ?? "" })}\n\n`);
                  } else {
                    const data = (event.data ?? {}) as Record<string, unknown>;
                    const result = (data.conclusion as string) ?? (data.reason as string) ?? "";
                    send(`data: ${JSON.stringify({ type: "done", stage: "complete", result })}\n\n`);
                  }
                }),
              );
            }
          },
          cancel() {
            for (const id of subs) eventBus.unsubscribe(id);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  });

  logger.info("[DRE-Daemon] listening", { hostname, port: server.port });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    await kernel.shutdown();
    logger.info("[DRE-Daemon] stopped");
  };

  return { port: server.port ?? bindPort, stop };
}

if (import.meta.main) {
  const handle = await startDreDaemon();
  const shutdown = async (sig: string) => {
    logger.info(`[DRE-Daemon] ${sig} received, shutting down`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
