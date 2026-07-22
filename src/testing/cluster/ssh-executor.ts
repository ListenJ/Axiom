/**
 * SSH 命令执行器
 *
 * 基于系统 ssh 命令（通过 child_process.execFile 调用），不依赖任何外部 SSH 库。
 * 支持连通性测试、远程命令执行、远程脚本执行，并支持超时 kill。
 *
 * 命令格式：ssh <options> <user>@<host> <command>
 * SSH 选项：-o StrictHostKeyChecking=no -o ConnectTimeout=<n> -p <port> -i <keyPath>
 */
import { execFile } from "child_process";
import { logger } from "../../utils/logger.js";

/** SSH 执行结果 */
export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** SshExecutor 构造选项 */
export interface SshExecutorOptions {
  /** SSH 端口，默认 22 */
  port?: number;
  /** SSH 私钥路径 */
  keyPath?: string;
  /** 连接超时（秒），默认 10 */
  connectTimeout?: number;
}

/** 默认连接超时（秒） */
const DEFAULT_CONNECT_TIMEOUT = 10;

export class SshExecutor {
  private readonly host: string;
  private readonly user: string;
  private readonly port: number;
  private readonly keyPath?: string;
  private readonly connectTimeout: number;

  constructor(host: string, user: string, options?: SshExecutorOptions) {
    this.host = host;
    this.user = user;
    this.port = options?.port ?? 22;
    this.keyPath = options?.keyPath;
    this.connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
  }

  /** 构建 ssh 公共参数（不含远程命令本身） */
  private buildSshArgs(): string[] {
    const args: string[] = [
      "-o", "StrictHostKeyChecking=no",
      "-o", `ConnectTimeout=${this.connectTimeout}`,
      "-p", String(this.port),
    ];
    if (this.keyPath) {
      args.push("-i", this.keyPath);
    }
    args.push(`${this.user}@${this.host}`);
    return args;
  }

  /** 测试 SSH 连通性，成功返回 true */
  async connectTest(): Promise<boolean> {
    try {
      const result = await this.exec("echo ok");
      return result.exitCode === 0 && result.stdout.trim() === "ok";
    } catch (err) {
      logger.warn("SSH 连通性测试失败", { host: this.host, error: (err as Error).message });
      return false;
    }
  }

  /** 在远程执行一条命令 */
  exec(command: string, timeoutMs?: number): Promise<SshExecResult> {
    const args = [...this.buildSshArgs(), command];
    return this.run(args, timeoutMs);
  }

  /** 在远程执行脚本（脚本内容通过 stdin 传给远程 bash -s） */
  execScript(scriptContent: string, timeoutMs?: number): Promise<SshExecResult> {
    const args = [...this.buildSshArgs(), "bash", "-s"];
    return this.run(args, timeoutMs, scriptContent);
  }

  /**
   * 执行 execFile 并收集结果。
   * 永不 reject —— 错误以非零 exitCode 体现，便于上层统一处理。
   * 超时则用 SIGKILL 杀掉进程，exitCode 返回 -1。
   */
  private run(args: string[], timeoutMs?: number, stdinInput?: string): Promise<SshExecResult> {
    return new Promise<SshExecResult>((resolve) => {
      // timeout=0 表示不超时（execFile 默认行为）
      const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 0;

      const child = execFile(
        "ssh",
        args,
        {
          maxBuffer: 10 * 1024 * 1024,
          encoding: "utf8",
          timeout,
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          // encoding:"utf8" 时 stdout/stderr 为 string；此处统一兜底转换
          const out = stdout != null ? String(stdout) : "";
          const errOut = stderr != null ? String(stderr) : "";
          let exitCode: number;
          if (err) {
            const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
            exitCode = typeof code === "number" ? code : -1;
          } else {
            exitCode = 0;
          }
          resolve({ stdout: out, stderr: errOut, exitCode });
        },
      );

      // 脚本执行模式：将脚本内容写入 ssh 的 stdin，由远程 bash -s 读取
      if (stdinInput && child.stdin) {
        child.stdin.write(stdinInput);
        child.stdin.end();
      }
    });
  }
}

/**
 * 独立函数：测试 SSH 连通性。
 * 内部创建一次性 SshExecutor 并执行 echo ok 验证。
 */
export async function testSshConnectivity(
  host: string,
  user: string,
  options?: SshExecutorOptions,
): Promise<boolean> {
  const executor = new SshExecutor(host, user, options);
  return executor.connectTest();
}
