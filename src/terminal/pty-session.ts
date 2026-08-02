/**
 * PTY 会话管理（深模块）—— 真正的交互式系统终端后端。
 *
 * 与一次性 sandbox 不同：每个会话持有一个常驻 shell 子进程
 * （Windows: cmd.exe；Linux/macOS: /bin/bash），stdin 可多次写入，
 * stdout/stderr 经订阅者推送给 SSE 前端 —— 支持 cd、环境变量、
 * 连续命令等真实终端语义。
 *
 * 安全边界：
 *   - env 复用 sanitizeSpawnEnv 过滤 API key（与 sandbox/terminal 一致）。
 *   - 会话进程直接运行于服务进程身份；终端面向已通过 API 鉴权的本地管理员，
 *     高危操作由 AXIOM_PTY_APPROVAL_MODE 审批门人工把关（R-024：off/risky/strict）。
 *   - 输出不设截断（真实终端语义），但订阅断开后停止读取推送。
 */
import { logger } from "../utils/logger.js";
import { sanitizeSpawnEnv } from "../utils/spawn-env.js";

export interface PtySession {
  id: string;
  /** 写入 stdin（可多次调用；关闭后静默忽略） */
  write(input: string): void;
  /** 向输出订阅者推送一条本地提示（不经 stdin；用于审批拒绝等场景） */
  notify(chunk: string): void;
  /** 订阅 stdout/stderr 输出块；返回退订函数 */
  subscribe(listener: (chunk: string) => void): () => void;
  /** 关闭会话（终止子进程，幂等） */
  close(): void;
  /** 子进程退出码（进程结束后 resolve） */
  exited: Promise<number>;
}

type ChunkListener = (chunk: string) => void;

const sessions = new Map<string, PtySessionImpl>();

/** 最大并发终端会话数（防失控进程积累） */
const MAX_PTY_SESSIONS = 16;

/** 当前存活会话数（审计/诊断用） */
export function ptySessionStats(): { sessions: number } {
  return { sessions: sessions.size };
}

/** 按 id 取会话 */
export function getSession(id: string): PtySession | undefined {
  return sessions.get(id);
}

/** 全部会话 id */
export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

/** 关闭全部会话（进程退出钩子用）；返回关闭数量 */
export async function closeAllSessions(): Promise<number> {
  const names = Array.from(sessions.keys());
  await Promise.all(
    names.map(async (id) => {
      const s = sessions.get(id);
      if (s) {
        sessions.delete(id);
        s.close();
      }
    }),
  );
  return names.length;
}

let seq = 0;

function nextId(): string {
  seq += 1;
  return `pty-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function shellCommand(): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    return { cmd: "cmd.exe", args: [] };
  }
  return { cmd: "/bin/bash", args: ["-i"] };
}

class PtySessionImpl implements PtySession {
  readonly id: string;
  readonly exited: Promise<number>;
  private listeners = new Set<ChunkListener>();
  private closed = false;
  private proc: ReturnType<typeof Bun.spawn> | null = null;

  constructor(cwd?: string) {
    this.id = nextId();
    const { cmd, args } = shellCommand();
    try {
      this.proc = Bun.spawn([cmd, ...args], {
        cwd: cwd ?? process.cwd(),
        env: sanitizeSpawnEnv(process.env as Record<string, string>),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      logger.warn("[PtySession] spawn failed", { error: (e as Error).message });
      throw new Error(`终端会话启动失败: ${(e as Error).message}`);
    }
    this.exited = this.proc.exited.then((code) => {
      this.emit("\r\n[process exited] ");
      this.close();
      return code;
    });
    this.pump(this.proc.stdout, "stdout");
    this.pump(this.proc.stderr, "stderr");
    sessions.set(this.id, this);
  }

  private pump(stream: ReadableStream<Uint8Array> | number | undefined, label: string): void {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    const loop = async (): Promise<void> => {
      try {
        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            this.emit(decoder.decode(value, { stream: true }));
          }
        }
      } catch (e) {
        logger.debug("[PtySession] pump stopped", { label, error: (e as Error).message });
      }
    };
    void loop();
  }

  private emit(chunk: string): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l(chunk);
      } catch {
        /* 订阅者异常不影响其他订阅者 */
      }
    }
  }

  write(input: string): void {
    if (this.closed || !this.proc?.stdin) return;
    const stdin = this.proc.stdin;
    if (typeof stdin === "number") return;
    try {
      stdin.write(input);
    } catch {
      /* 进程已退出：静默忽略 */
    }
  }

  notify(chunk: string): void {
    if (this.closed) return;
    this.emit(chunk);
  }

  subscribe(listener: ChunkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    sessions.delete(this.id);
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

/** 创建新 PTY 会话 */
export function createPtySession(opts?: { cwd?: string }): PtySession {
  if (sessions.size >= MAX_PTY_SESSIONS) {
    throw new Error(`终端会话数量已达上限（${MAX_PTY_SESSIONS}），请先关闭不再使用的会话`);
  }
  return new PtySessionImpl(opts?.cwd);
}
