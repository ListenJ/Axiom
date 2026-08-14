/**
 * env 模板完整性测试 —— 代码中读取的每个环境变量都应在 .env.example 有登记。
 *
 * 规则依据：AGENTS.md 规则 11（敏感资产本地化）+ 项目长期要求「配置不写死、
 * 模板齐全」。扫描 src/ 中 readString/readInt/readBool 与 config-center 的
 * envVar 声明，逐一断言 .env.example 中存在对应条目；防止新增 env 读取后模板漂移。
 */
import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");

/** 系统继承变量：随进程环境而来，不属于用户配置模板 */
const SYSTEM_INHERITED = new Set([
  "PATH",
  "PATHEXT",
  "TERM",
  "MSYSTEM",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function envKeysReadInSource(): Set<string> {
  const keys = new Set<string>();
  const re = /readString\("([A-Z_][A-Z_0-9]*)"|readInt\("([A-Z_][A-Z_0-9]*)"|readBool\("([A-Z_][A-Z_0-9]*)"|envVar: "([A-Z_][A-Z_0-9]*)"/g;
  for (const file of walk(path.join(ROOT, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1] || m[2] || m[3] || m[4];
      if (key) keys.add(key);
    }
  }
  return keys;
}

function envKeysInTemplate(): Set<string> {
  const keys = new Set<string>();
  const text = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const re = /^#?\s*([A-Z_][A-Z_0-9]*)\s*=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

describe("env 模板完整性", () => {
  const readKeys = envKeysReadInSource();
  const templateKeys = envKeysInTemplate();

  it("src 中读取的每个 env 变量都在 .env.example 登记（或属系统继承）", () => {
    const missing = [...readKeys]
      .filter((k) => !templateKeys.has(k) && !SYSTEM_INHERITED.has(k))
      .sort();
    expect(missing).toEqual([]);
  });

  it("至少覆盖核心配置类变量", () => {
    for (const key of [
      "PROMPT_OPTIMIZER_CACHE_TTL_MS",
      "PROMPT_OPTIMIZER_MAX_INPUT_CHARS",
      "SEMANTIC_CACHE_ENABLED",
      "AXIOM_GATEWAY_PORT",
      "MCP_PORT",
      "GITHUB_TOKEN",
      "REDIS_URL",
    ]) {
      expect(templateKeys.has(key), `${key} 应在 .env.example`).toBe(true);
    }
  });
});
