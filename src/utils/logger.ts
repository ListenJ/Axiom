/**
 * 结构化日志系统
 * 支持分级日志、结构化输出、文件轮转、上下文追踪
 */
import fs from "fs";
import path from "path";
import { sanitizeRequestBody } from "./security.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

interface LoggerOptions {
  minLevel?: LogLevel;
  outputs?: Array<{ type: "console" | "file"; path?: string }>;
  format?: "json" | "text";
  enableColors?: boolean;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, fatal: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",   // gray
  info: "\x1b[36m",    // cyan
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
  fatal: "\x1b[35m",   // magenta
};
const RESET = "\x1b[0m";

interface LogRotationOptions {
  maxSize?: number;      // bytes, default 10MB
  maxFiles?: number;     // number of rotated files to keep
  maxAge?: number;       // days
}

class Logger {
  private opts: Required<LoggerOptions>;
  private fileStream?: fs.WriteStream;
  private filePath?: string;
  private context: Record<string, unknown> = {};
  private rotation?: LogRotationOptions;
  private currentSize = 0;

  constructor(opts: LoggerOptions = {}, rotation?: LogRotationOptions) {
    this.opts = {
      minLevel: opts.minLevel ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
      outputs: opts.outputs ?? [{ type: "console" }],
      format: opts.format ?? "text",
      enableColors: opts.enableColors ?? true,
    };

    this.rotation = {
      maxSize: rotation?.maxSize ?? 10 * 1024 * 1024, // 10MB
      maxFiles: rotation?.maxFiles ?? 5,
      maxAge: rotation?.maxAge ?? 30,
    };

    const fileOut = this.opts.outputs.find((o) => o.type === "file" && o.path);
    if (fileOut?.path) {
      this.filePath = fileOut.path;
      this.initFileStream();
    }
  }

  private initFileStream() {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    // Check current file size
    try {
      const stats = fs.statSync(this.filePath);
      this.currentSize = stats.size;
    } catch {
      this.currentSize = 0;
    }

    this.fileStream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  private async rotateIfNeeded() {
    if (!this.filePath || !this.rotation?.maxSize) return;
    if (this.currentSize < this.rotation.maxSize) return;

    this.fileStream?.end();
    // 审计 Low（2026-08-29）：end() 是异步关闭，立即 renameSync 在 Windows 上会因
    // 文件句柄未释放而 EPERM/EBUSY。等 close 事件后再 rename（1s 上限容错，
    // 超时则按原 try/catch 路径重试失败处理，不卡日志主流程）。
    if (this.fileStream) {
      const stream = this.fileStream;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        stream.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedPath = `${this.filePath}.${timestamp}`;

    try {
      fs.renameSync(this.filePath, rotatedPath);
      this.currentSize = 0;
      this.initFileStream();
      await this.cleanupOldLogs();
    } catch (error) {
      console.error("Failed to rotate log file:", error);
    }
  }

  private async cleanupOldLogs() {
    if (!this.filePath) return;
    
    const dir = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath);
    
    try {
      const entries = fs.readdirSync(dir);
      const logFiles = entries
        .filter((e) => e.startsWith(baseName + "."))
        .map((e) => ({
          name: e,
          path: path.join(dir, e),
          stat: fs.statSync(path.join(dir, e)),
        }))
        .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

      // Remove old files exceeding maxFiles
      if (this.rotation?.maxFiles && logFiles.length > this.rotation.maxFiles) {
        for (const file of logFiles.slice(this.rotation.maxFiles)) {
          try {
            fs.unlinkSync(file.path);
          } catch {
            // ignore
          }
        }
      }

      // Remove files older than maxAge
      if (this.rotation?.maxAge) {
        const maxAgeMs = this.rotation.maxAge * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - maxAgeMs;
        for (const file of logFiles) {
          if (file.stat.mtime.getTime() < cutoff) {
            try {
              fs.unlinkSync(file.path);
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  withContext(ctx: Record<string, unknown>): Logger {
    const child = new Logger(this.opts);
    child.context = { ...this.context, ...ctx };
    return child;
  }

  debug(msg: string, ctx?: Record<string, unknown>) { this.log("debug", msg, ctx); }
  info(msg: string, ctx?: Record<string, unknown>) { this.log("info", msg, ctx); }
  warn(msg: string, ctx?: Record<string, unknown>) { this.log("warn", msg, ctx); }
  error(msg: string, error?: Error, ctx?: Record<string, unknown>) { this.log("error", msg, ctx, error); }
  fatal(msg: string, error?: Error, ctx?: Record<string, unknown>) { this.log("fatal", msg, ctx, error); }

  private log(level: LogLevel, message: string, ctx?: Record<string, unknown>, error?: Error) {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.opts.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.context, ...ctx },
      error,
    };

    for (const out of this.opts.outputs) {
      if (out.type === "console") this.writeConsole(entry);
      else if (out.type === "file" && this.fileStream) this.writeFile(entry);
    }
  }

  private writeConsole(entry: LogEntry) {
    // 宿主互操作契约（2026-09-06 OpenCode 冒烟实证）：MCP stdio 传输（--stdio）下
    // stdout 仅承载 JSON-RPC 帧，宿主按行解析协议流——info/debug 日志经 console.log
    // 混入 stdout 会使标准客户端解析失败并标记 server unavailable。故 stdio 模式
    // 全部日志改写 stderr（协议流纯净性回归：tests/mcp-stdio-stdout-purity.test.ts）。
    if (process.argv.includes("--stdio")) {
      console.error(this.formatLine(entry));
      return;
    }
    if (this.opts.format === "json") {
      console.log(JSON.stringify(this.serialize(entry)));
      return;
    }

    if (entry.level === "error" || entry.level === "fatal") console.error(this.formatLine(entry));
    else if (entry.level === "warn") console.warn(this.formatLine(entry));
    else console.log(this.formatLine(entry));
  }

  /** text 格式行渲染（redactContext/SECRET_VALUE_RE 语义保持不变，仅抽取复用） */
  private formatLine(entry: LogEntry): string {
    if (this.opts.format === "json") return JSON.stringify(this.serialize(entry));

    const color = this.opts.enableColors ? LEVEL_COLORS[entry.level] : "";
    const reset = this.opts.enableColors ? RESET : "";
    // 整改 D4（2026-08-25）：text 路径与 json 路径同样过 redactContext，
    // 防止 context 中密钥值经 console 明文输出。
    const safeCtx = entry.context && Object.keys(entry.context).length
      ? this.redactContext(entry.context)
      : entry.context;
    const ctxStr = safeCtx && Object.keys(safeCtx).length
      ? " " + JSON.stringify(safeCtx)
      : "";
    // B3-Medium（2026-08-29）：errStr 与 JSON 路径（serialize）一致套用 SECRET_VALUE_RE，
    // 防止 error.stack/message 中的密钥值经 console 文本输出泄漏。
    const errStr = entry.error
      ? `\n${(entry.error.stack || entry.error.message || "").replace(Logger.SECRET_VALUE_RE, "[REDACTED]")}`
      : "";

    return `${color}[${entry.timestamp.slice(11, 19)}] ${entry.level.toUpperCase().padEnd(5)}${reset} ${entry.message}${ctxStr}${errStr}`;
  }

  private async writeFile(entry: LogEntry) {
    if (!this.fileStream) return;
    await this.rotateIfNeeded();
    const line = JSON.stringify(this.serialize(entry)) + "\n";
    this.fileStream.write(line);
    this.currentSize += Buffer.byteLength(line, "utf8");
  }

  /** 敏感值正则：捕获常见密钥格式（key-based 脱敏由 sanitizeRequestBody 处理，此处补 value-based） */
  private static readonly SECRET_VALUE_RE =
    /(sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20}|xoxb-[0-9A-Za-z-]+)/g;

  /** 脱敏上下文：先按字段名递归脱敏（复用 security.ts），再按值扫描密钥模式 */
  private redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
    const cleaned = sanitizeRequestBody(ctx) as Record<string, unknown>;
    for (const [k, v] of Object.entries(cleaned)) {
      if (typeof v === "string") {
        cleaned[k] = v.replace(Logger.SECRET_VALUE_RE, "[REDACTED]");
      }
    }
    return cleaned;
  }

  private serialize(entry: LogEntry): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
    };
    if (entry.context && Object.keys(entry.context).length) {
      obj.context = this.redactContext(entry.context);
    }
    if (entry.error) {
      const msg = entry.error.message?.replace(Logger.SECRET_VALUE_RE, "[REDACTED]") ?? "";
      const stack = entry.error.stack?.replace(Logger.SECRET_VALUE_RE, "[REDACTED]");
      obj.error = { name: entry.error.name, message: msg, stack };
    }
    return obj;
  }

  close() {
    this.fileStream?.end();
  }
}

/** 全局默认日志实例 */
export const logger = new Logger(
  {
    minLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    outputs: [
      { type: "console" },
      { type: "file", path: "./data/logs/agent.log" },
    ],
    format: (process.env.LOG_FORMAT as "json" | "text") || "text",
  },
  {
    maxSize: parseInt(process.env.LOG_MAX_SIZE || "10485760", 10), // 10MB
    maxFiles: parseInt(process.env.LOG_MAX_FILES || "5", 10),
    maxAge: parseInt(process.env.LOG_MAX_AGE || "30", 10),
  }
);

export { Logger };
