/**
 * 能力执行隔离层（ADR-014 §7-2）。
 *
 * 注册时校验"隔离级别声明"，执行时**按声明强制隔离**——不允许声明了 worker/sandbox
 * 却退回进程内执行（fail-closed）。三种隔离：
 *   - `in-process`：调用 provider.invoke（仅限低危；高危在注册处已被拒）；
 *   - `worker`：子进程 `bun run <entry>`，请求经 stdin、结果经 stdout（JSON）；
 *   - `sandbox`：复用 `src/sandbox` 的 `executeInSandbox`（docker 优先 / process 兜底）。
 *
 * 任何"声明了隔离却缺可执行体"的情形都在此处**拒绝**，绝不静默降级到 in-process。
 */
import { executeInSandbox } from "../../sandbox/index.js";
import { readString } from "../../utils/env.js";
import type { CapabilityProvider } from "./capability-registry.js";

export class CapabilityIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityIsolationError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function parseJsonOut(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new CapabilityIsolationError(`隔离执行返回非 JSON 输出：${text.slice(0, 200)}`);
  }
}

async function runWorker(
  provider: CapabilityProvider,
  req: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const w = provider.worker;
  if (!w?.entry) {
    throw new CapabilityIsolationError(`provider '${provider.id}' 声明 worker 隔离但缺 worker.entry`);
  }
  // 轮 7 审计：运行时可执行体写死 "bun"——宿主为 node/打包二进制时 worker 形态
  // 直接不可用且报错难读。AXIOM_RUNTIME_BIN 可覆盖，默认保持 bun 兼容。
  const runtimeBin = readString("AXIOM_RUNTIME_BIN", "bun");
  const proc = Bun.spawn([runtimeBin, "run", w.entry, ...(w.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(req));
  proc.stdin.end();
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* 已退出 */ }
  }, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new CapabilityIsolationError(`worker '${provider.id}' 退出码 ${code}：${err.trim().slice(0, 300)}`);
    }
    return parseJsonOut(out);
  } finally {
    clearTimeout(timer);
  }
}

/** 按 provider 的隔离声明执行；不匹配即拒绝（不退回 in-process）。 */
export async function runIsolated(
  provider: CapabilityProvider,
  req: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const iso = provider.isolation ?? "in-process";

  if (iso === "in-process") {
    if (typeof provider.invoke !== "function") {
      throw new CapabilityIsolationError(`provider '${provider.id}' 声明 in-process 隔离但无可执行体 invoke`);
    }
    return provider.invoke(req);
  }

  if (iso === "worker") return runWorker(provider, req, timeoutMs);

  if (iso === "sandbox") {
    const s = provider.sandbox;
    if (!s?.command) {
      throw new CapabilityIsolationError(`provider '${provider.id}' 声明 sandbox 隔离但缺 sandbox.command`);
    }
    const r = await executeInSandbox({
      command: s.command,
      args: s.args,
      timeoutMs,
      readOnly: true,
      networkAccess: false,
    });
    if (r.exitCode !== 0) {
      throw new CapabilityIsolationError(`sandbox '${provider.id}' 退出码 ${r.exitCode}：${(r.stderr || r.error || "").trim().slice(0, 300)}`);
    }
    return parseJsonOut(r.stdout);
  }

  throw new CapabilityIsolationError(`provider '${provider.id}' 未知 isolation：${String(iso)}`);
}
