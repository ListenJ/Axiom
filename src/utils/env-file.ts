/**
 * .env 文件的受控写入
 *
 * 用途：GUI 里修改某些**只能通过环境变量生效**的配置（例如 AXIOM_APPROVER_MODEL），
 * 需要把值落到 .env 才能在重启后依然生效。
 *
 * 安全约定（重要）：
 *   1. **绝不打印值**：日志/异常只出现变量名。
 *   2. **写后收紧权限到 0600**：.env 里可能有 API Key，不能被同机其他用户读到。
 *   3. **保留原文件内容**：只替换目标变量那一行，其余原样保留（含注释与空行）。
 *   4. **不新建 .env 于错误位置**：默认写项目根的 .env；不存在时创建。
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { logger } from "./logger.js";

const DEFAULT_ENV_PATH = "./.env";

export interface UpsertResult {
  path: string;
  /** 是新增还是替换了已有变量 */
  action: "created" | "updated";
}

/**
 * 写入或更新一个环境变量到 .env。
 *
 * @param name  变量名（必须是合法的环境变量名）
 * @param value 变量值（不会被记录到日志）
 */
export function upsertEnvVar(name: string, value: string, envPath = DEFAULT_ENV_PATH): UpsertResult {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
    throw new Error(`非法的环境变量名: ${name}`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`环境变量值不能包含换行: ${name}`);
  }

  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, "utf-8").split("\n");
  }

  const prefix = `${name}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const action: UpsertResult["action"] = idx >= 0 ? "updated" : "created";

  if (idx >= 0) {
    lines[idx] = `${name}=${value}`;
  } else {
    // 末尾无空行时补一个，避免与最后一行黏连
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`${name}=${value}`);
  }

  writeFileSync(envPath, lines.join("\n"), "utf-8");

  // .env 可能含密钥：写入后立即收紧权限（组/其他用户不可读）
  try {
    chmodSync(envPath, 0o600);
  } catch (e) {
    logger.warn("[EnvFile] 收紧 .env 权限失败（不影响写入）", {
      path: envPath,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  logger.info("[EnvFile] 环境变量已写入", { name, path: envPath, action });
  return { path: envPath, action };
}

/** 读取 .env 里某个变量的值（仅供需要比对环境变量时使用；不要记录返回值） */
export function readEnvVar(name: string, envPath = DEFAULT_ENV_PATH): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf-8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  if (!line) return undefined;
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
}
