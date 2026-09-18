/**
 * 回归测试（P2 audit：env.ts REQUIRED_ENV_VARS 命名错位 DATABASE_URL vs DATABASE_PATH）：
 * REQUIRED_ENV_VARS 必须声明运行时实际读取的变量名（DATABASE_PATH/OBSIDIAN_VAULT_PATH），
 * 且 DATABASE_URL/VAULT_PATH 不再作为 required（它们仅被 backup 脚本/云端检测读取）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validateEnv, REQUIRED_ENV_VARS } from "../../src/utils/env.js";

const TRACKED = ["DATABASE_PATH", "OBSIDIAN_VAULT_PATH", "DATABASE_URL", "VAULT_PATH"] as const;

describe("REQUIRED_ENV_VARS 命名与运行时一致", () => {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TRACKED) snapshot[k] = process.env[k];
    for (const k of TRACKED) delete process.env[k];
  });

  afterEach(() => {
    for (const k of TRACKED) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("声明运行时实际变量名 DATABASE_PATH/OBSIDIAN_VAULT_PATH", () => {
    const names = REQUIRED_ENV_VARS.map((v) => v.name);
    expect(names).toContain("DATABASE_PATH");
    expect(names).toContain("OBSIDIAN_VAULT_PATH");
  });

  test("DATABASE_URL/VAULT_PATH 不再标记 required（假名/脚本用，非运行时必需）", () => {
    const dbUrl = REQUIRED_ENV_VARS.find((v) => v.name === "DATABASE_URL");
    const vault = REQUIRED_ENV_VARS.find((v) => v.name === "VAULT_PATH");
    expect(dbUrl?.required).toBe(false);
    expect(vault?.required).toBe(false);
  });

  test("未设置 DATABASE_URL/VAULT_PATH 不再报 missing（修复前每次启动都假告警）", () => {
    const result = validateEnv({ strict: false, exitOnError: false });
    expect(result.missing).not.toContain("DATABASE_URL");
    expect(result.missing).not.toContain("VAULT_PATH");
    expect(result.missing).not.toContain("DATABASE_PATH");
    expect(result.missing).not.toContain("OBSIDIAN_VAULT_PATH");
  });
});
