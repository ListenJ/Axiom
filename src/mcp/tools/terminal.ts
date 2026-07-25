import { spawn } from "node:child_process";
import * as os from "node:os";
import { TIMEOUTS } from "../../constants/timeouts.js";
import { sanitizeSpawnEnv } from "../../utils/spawn-env.js";

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  command: string;
}

export interface ProcessInfo {
  pid: number;
  command: string;
  cpu?: number;
  memory?: number;
  status: "running" | "stopped" | "unknown";
}

export interface ProcessListResult {
  success: boolean;
  processes?: ProcessInfo[];
  error?: string;
}

// Valid Unix signals for process termination
const VALID_SIGNALS = new Set([
  "SIGTERM", "SIGKILL", "SIGINT", "SIGUSR1", "SIGUSR2", "SIGHUP",
]);

function sanitizeCommand(command: string): { safe: boolean; error?: string } {
  // Block commands that could delete or modify system/user data
  const dangerous = [
    /(?:^|\s|;|&&|\|\||\()\s*rm\s+(?:-\w*\s+)*(-rf|-fr|-r\s+-f|-f\s+-r)\s+/i,
    /(?:^|\s|;|&&|\|\||\()\s*mkfs\./i,
    /(?:^|\s|;|&&|\|\||\()\s*dd\s+if=/i,
    /(?:^|\s|;|&&|\|\||\()\s*fdisk\s+/i,
    /(?:^|\s|;|&&|\|\||\()\s*format\s+/i,
    />\s*\/dev\/[sh]d[a-z]/,
    /curl\s+.*\|\s*(ba)?sh/i,
    /wget\s+.*\|\s*(ba)?sh/i,
    /:\(\)\s*\{\s*:\u007c:\u0026\s*\};/,
  ];
  for (const pattern of dangerous) {
    if (pattern.test(command)) {
      return { safe: false, error: `Dangerous command blocked for safety` };
    }
  }
  return { safe: true };
}

export async function executeCommand(
  command: string,
  options?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
    shell?: boolean;
  }
): Promise<CommandResult> {
  const safety = sanitizeCommand(command);
  if (!safety.safe) {
    return {
      success: false,
      stdout: "",
      stderr: safety.error!,
      exitCode: -1,
      error: safety.error,
      command,
    };
  }

  return new Promise((resolve) => {
    const isWin = os.platform() === "win32";
    const shell = options?.shell ?? true;
    const cwd = options?.cwd ?? process.cwd();

    let args: string[];
    let cmd: string;
    if (shell) {
      cmd = isWin ? "cmd" : "sh";
      args = isWin ? ["/c", command] : ["-c", command];
    } else {
      // Use shell-quote-like parsing for non-shell mode
      const parts = command.match(/(?:"([^"]+)"|'([^']+)'|(\S+))/g);
      if (parts) {
        cmd = parts[0].replace(/^["']|["']$/g, "");
        args = parts.slice(1).map((p) => p.replace(/^["']|["']$/g, ""));
      } else {
        cmd = command;
        args = [];
      }
    }

    const env = sanitizeSpawnEnv(process.env, options?.env);
    const child = spawn(cmd, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = options?.timeout ?? TIMEOUTS.TERMINAL_COMMAND;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeout);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
      // Prevent memory explosion from huge output
      if (stdout.length > 5_000_000) {
        stdout = stdout.substring(0, 5_000_000) + "\n...[truncated]";
        child.stdout?.pause();
      }
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 1_000_000) {
        stderr = stderr.substring(0, 1_000_000) + "\n...[truncated]";
        child.stderr?.pause();
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout,
        stderr,
        exitCode: -1,
        error: err.message,
        command,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          success: false,
          stdout,
          stderr: stderr || "Command timed out",
          exitCode: -1,
          error: `Command timed out after ${timeout}ms`,
          command,
        });
      } else {
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code ?? -1,
          command,
        });
      }
    });
  });
}

export async function listProcesses(): Promise<ProcessListResult> {
  const platform = os.platform();
  let command: string;

  if (platform === "win32") {
    command = 'wmic process get ProcessId,CommandLine,PageFileUsage /format:csv';
  } else if (platform === "darwin") {
    command = 'ps -axo pid,command,pcpu,pmem,state';
  } else {
    command = 'ps -axo pid,command,pcpu,pmem,stat';
  }

  const result = await executeCommand(command, { shell: true, timeout: 10000 });
  if (!result.success) {
    return { success: false, error: result.error || result.stderr };
  }

  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return { success: true, processes: [] };
  }

  const processes: ProcessInfo[] = [];

  if (platform === "win32") {
    // Parse WMIC CSV output (skip header line if present)
    for (const line of lines.slice(1)) {
      const parts = line.split(",");
      if (parts.length >= 3) {
        const pid = parseInt(parts[parts.length - 2], 10);
        const cmd = parts.slice(1, -2).join(",").replace(/"/g, "");
        if (!isNaN(pid) && cmd) {
          processes.push({ pid, command: cmd, status: "running" });
        }
      }
    }
  } else {
    // Parse ps output
    for (const line of lines.slice(1)) {
      const match = line.match(/^\s*(\d+)\s+(\S.*?)\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (match) {
        const pid = parseInt(match[1], 10);
        const cmd = match[2].trim();
        const state = match[5];
        processes.push({
          pid,
          command: cmd,
          cpu: parseFloat(match[3]) || undefined,
          memory: parseFloat(match[4]) || undefined,
          status: state === "R" || state === "running" ? "running" : "stopped",
        });
      }
    }
  }

  return { success: true, processes: processes.slice(0, 100) };
}

export async function killProcess(pid: number, signal: string = "SIGTERM"): Promise<CommandResult> {
  const isWin = os.platform() === "win32";
  if (isWin) {
    return executeCommand(`taskkill /PID ${pid} /F`, { shell: true, timeout: 5000 });
  }
  // Validate signal name for safety
  const normalizedSignal = signal.startsWith("SIG") ? signal : `SIG${signal}`;
  if (!VALID_SIGNALS.has(normalizedSignal)) {
    const validSignalsList = Array.from(VALID_SIGNALS).join(", ");
    return {
      success: false,
      stdout: "",
      stderr: `Invalid signal: ${signal}`,
      exitCode: -1,
      error: `Invalid signal: ${signal}. Valid signals: ${validSignalsList}`,
      command: `kill -${signal} ${pid}`,
    };
  }
  return executeCommand(`kill -${normalizedSignal.replace("SIG", "")} ${pid}`, { shell: true, timeout: 5000 });
}

export function getSystemInfo(): {
  platform: string;
  arch: string;
  nodeVersion: string;
  cpus: number;
  totalMemory: number;
  freeMemory: number;
  cwd: string;
} {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    cwd: process.cwd(),
  };
}
