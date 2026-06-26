---
id: code-utils.logger
type: code-index
source: utils\logger.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 498
tags: [code, auto-indexed]
exports: ["logger", "Logger"]
imports: ["fs", "path"]
---

# utils.logger

## 元信息

- **源文件**: `utils\logger.ts`
- **模块**: `utils.logger`
- **行数**: 146
- **索引时间**: 2026-05-25T05:11:12.541Z

## 依赖

- [[fs]]
- [[path]]

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| variable | `logger` | 136 |
| named | `Logger` | 145 |

## 代码

```typescript
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

class Logger {
  private opts: Required<LoggerOptions>;
  private fileStream?: fs.WriteStream;
  private context: Record<string, unknown> = {};

  constructor(opts: LoggerOptions = {}) {
    this.opts = {
      minLevel: opts.minLevel ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
      outputs: opts.outputs ?? [{ type: "console" }],
      format: opts.format ?? "text",
      enableColors: opts.enableColors ?? true,
    };

    const fileOut = this.opts.outputs.find((o) => o.type === "file" && o.path);
    if (fileOut?.path) {
      const dir = path.dirname(fileOut.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.fileStream = fs.createWriteStream(fileOut.path, { flags: "a" });
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

  private writeFile(entry: LogEntry) {
    if (!this.fileStream) return;
    this.fileStream.write(JSON.stringify(this.serialize(entry)) + "\n");
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
export const logger = new Logger({
  minLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
  outputs: [
    { type: "console" },
    { type: "file", path: "./data/logs/agent.log" },
  ],
  format: (process.env.LOG_FORMAT as "json" | "text") || "text",
});

export { Logger };

```