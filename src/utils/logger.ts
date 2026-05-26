/**
 * 结构化日志系统
 * 支持分级日志、结构化输出、文件轮转、上下文追踪
 */
import fs from "fs";
import path from "path";

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
    if (this.opts.format === "json") {
      console.log(JSON.stringify(this.serialize(entry)));
      return;
    }

    const color = this.opts.enableColors ? LEVEL_COLORS[entry.level] : "";
    const reset = this.opts.enableColors ? RESET : "";
    const ctxStr = Object.keys(entry.context || {}).length
      ? " " + JSON.stringify(entry.context)
      : "";
    const errStr = entry.error ? `\n${entry.error.stack || entry.error.message}` : "";

    const line = `${color}[${entry.timestamp.slice(11, 19)}] ${entry.level.toUpperCase().padEnd(5)}${reset} ${entry.message}${ctxStr}${errStr}`;

    if (entry.level === "error" || entry.level === "fatal") console.error(line);
    else if (entry.level === "warn") console.warn(line);
    else console.log(line);
  }

  private async writeFile(entry: LogEntry) {
    if (!this.fileStream) return;
    await this.rotateIfNeeded();
    const line = JSON.stringify(this.serialize(entry)) + "\n";
    this.fileStream.write(line);
    this.currentSize += Buffer.byteLength(line, "utf8");
  }

  private serialize(entry: LogEntry): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
    };
    if (entry.context && Object.keys(entry.context).length) obj.context = entry.context;
    if (entry.error) {
      obj.error = {
        name: entry.error.name,
        message: entry.error.message,
        stack: entry.error.stack,
      };
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
