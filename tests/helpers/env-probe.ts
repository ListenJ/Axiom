/**
 * 测试环境探测 helper（2026-10-19「环境依赖用例的门控设计」§4.1）。
 *
 * 目标：让「环境不可用 → 可见 skip」与「环境可用但结果不对 → 必须红」可区分，
 * 避免 `if (!ok) return;` 式的静默通过把信号彻底丢掉。
 *
 * 约束（与设计稿一致）：
 * - 零新依赖：只用 Node 内置 `child_process` / `net`；
 * - 记忆化：同一进程内每个探测最多执行一次，避免全量 4,823 个测试反复 spawn 子进程；
 * - 探测自身不产生可观察副作用（记忆化除外），不打印，不做 HTTP 请求；
 * - 探测超时上限 2s，超时一律视为「不可用」（宁可判缺失跳过，不让探测自己变红）。
 *
 * 注意：记忆化是进程级的，因此在同一进程内「先探测、后改 env」不会让
 * `hasEnv` 重新求值。探测应在测试收集期（`describe.skipIf` / `it.skipIf` 前）使用。
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

/** 单个探测的超时上限（设计稿 §4.1：≤2s）。 */
const PROBE_TIMEOUT_MS = 2_000;

const commandCache = new Map<string, boolean>();
const envCache = new Map<string, boolean>();
const connectCache = new Map<string, Promise<boolean>>();

/**
 * E1 能力探测：命令是否可执行（只看能否 spawn，不看参数是否支持）。
 *
 * 用 `spawnSync(cmd, ["--version"], { stdio: "ignore" })` 探测：某些命令
 * 不认 `--version` 而返回非 0（如 go），但 `spawnSync` 的 `error` 只在
 * ENOENT/EACCES/超时等「根本无法执行」时出现，因此以 `error === undefined`
 * 作为「命令存在且可执行」的判据。
 *
 * **适用范围限制**：走 `spawnSync` 且不经过 shell，Windows 上只认原生
 * `.exe`（PATH/PATHEXT 解析），`.cmd` / `.bat` 包装器（如 npx、部分工具链
 * 安装器）会 ENOENT → 被误报为「不存在」。本 helper 当前只用于 `go`
 * （原生二进制）这类场景；若将来探测 `.cmd` 包装器，必须改用 `shell: true`
 * 或 `where`/`which`，否则会得出假的「E1 能力缺失」。
 */
export function hasCommand(cmd: string): boolean {
  const cached = commandCache.get(cmd);
  if (cached !== undefined) return cached;

  let available = false;
  try {
    const result = spawnSync(cmd, ["--version"], {
      stdio: "ignore",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    available = result.error === undefined;
  } catch {
    available = false;
  }
  commandCache.set(cmd, available);
  return available;
}

/**
 * E2 凭据/配置探测：所给环境变量是否**全部**存在且非空。
 * 空串视为未设置（与 `.env` 里 `KEY=` 等价）。
 */
export function hasEnv(...names: string[]): boolean {
  const key = names.join("\u0000");
  const cached = envCache.get(key);
  if (cached !== undefined) return cached;

  const present = names.every((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim() !== "";
  });
  envCache.set(key, present);
  return present;
}

/**
 * E2 服务可达性探测：只做 TCP 握手，**不发 HTTP**（避免把测试变成网络探针）。
 * 超时上限固定 2s（传入更大的 `ms` 也会被截断），超时视为不可用。
 *
 * **可信度限制（重要）**：本函数只证明「TCP 三方握手在本机网络栈里成功」。
 * 在存在 TUN / 透明代理 / fake-IP DNS 的环境里，任意远程地址都会被本地代理
 * 立刻接受（实测本机 `10.255.255.1:443`、`192.0.2.123:443` 均 1ms 返回 true），
 * 因此**不可信**、不能拿它当 E2 判据（会得出「服务可达」的错误结论）。
 * 可靠的只有 localhost/已关闭端口场景；当前本 helper 无调用方，保持现状。
 */
export function canConnect(host: string, port: number, ms: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  const timeoutMs = Math.min(Math.max(ms, 1), PROBE_TIMEOUT_MS);
  const key = `${host}:${port}:${timeoutMs}`;
  const cached = connectCache.get(key);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    try {
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect({ host, port });
    } catch {
      finish(false);
    }
  });

  connectCache.set(key, probe);
  return probe;
}

/**
 * `go build` 失败分类：把「模块下载/网络不可达」（E2，可跳过）与
 * 「代码编译不过」（F，必须红）分开。
 *
 * 判据是**行级 + 结构化**的：把 stderr 按行切分，只有某一行命中网络错误的
 * **真实语法形态**才判 "network"。**禁止裸子串匹配**——旧版用裸子串时，
 * `no required module provides package github.com/acme/proxyconnect` 这种
 * 本地依赖/代码错误会被 "proxyconnect" 裸串误判为网络问题而跳过（方向性错误：
 * 让真实编译失败永久静默）；同理裸 `i/o timeout` / `no such host` 也会误伤
 * 源码字符串或包路径。
 *
 * 规则：任一行命中下列 pattern → "network"；其它非空 stderr → "compile"；
 * 空 stderr → "unknown"（调用方对 "unknown" 必须按红处理，不允许当成网络跳过）。
 */
const NETWORK_LINE_PATTERNS: readonly RegExp[] = [
  /\bdial tcp [\w.\-\[\]]+:\d+/, // dial tcp 1.2.3.4:443（必须有端口）
  /\bproxyconnect tcp\b/, // 完整短语，不接受裸 proxyconnect
  /\blookup [\w.\-]+[^\n]*no such host/, // DNS：lookup host ... no such host
  /\bmodule lookup disabled\b/, // GOPROXY=off 的专用串
  /\b(?:read|dial) tcp[^\n]*\bi\/o timeout\b/, // 超时必须在 tcp 上下文里
  /\bconnect: connection refused\b/, // 必须是 connect: connection refused 完整短语
];

export function classifyGoBuildError(stderr: string): "network" | "compile" | "unknown" {
  const text = stderr ?? "";
  if (text.trim() === "") return "unknown";
  const matchesNetwork = text
    .split(/\r?\n/)
    .some((line) => NETWORK_LINE_PATTERNS.some((pattern) => pattern.test(line)));
  return matchesNetwork ? "network" : "compile";
}
