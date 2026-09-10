/**
 * Task 8（docs/superpowers/plans/2026-08-29-audit-hardening-plan.md，审计 §4 Low 批）小测试。
 * 覆盖：memory-gate maxWritesPerDay 生效（#9）、skill-quality 原子写+路径锚定（#11）、
 * env.readInt 严格解析+钳制（#15）、permissions .env 精确段匹配（#16）、
 * install-wizard .env 0600 静态断言（#18）。
 * 全部用例在修复前代码上为红、修复后为绿（红绿验证见 docs/operations-log.md T8 条目）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryGate, type SignificanceContext } from "../src/memory/memory-gate.js";
import { createFileQualityStore } from "../src/self-evolve/skill-quality.js";
import { readInt } from "../src/utils/env.js";
import { checkFilePermission } from "../src/utils/permissions.js";

// ─── #9 memory-gate：maxWritesPerDay 参与限流判定 ───────────────────────────

function signCtx(overrides: Partial<SignificanceContext> = {}): SignificanceContext {
  return {
    agentRole: "test",
    taskType: "coding",
    responseLength: 600,
    hasCode: true,
    hasCitations: false,
    hasErrors: false,
    responseTimeMs: 100,
    userMessageLength: 50,
    isFirstTurn: false,
    hasStructuredData: false,
    hasTechnicalTerms: false,
    ...overrides,
  };
}

describe("memory-gate 每日写入上限（审计 #9）", () => {
  test("当日写入达到 maxWritesPerDay 后 shouldWrite 被拒且原因标明 daily", () => {
    // hourly 放得很宽，仅让 daily 阈值可触发——旧实现只查 hourly，此用例为红
    const gate = new MemoryGate({ maxWritesPerHour: 1000, maxWritesPerDay: 3 });
    for (let i = 0; i < 3; i++) {
      gate.recordWrite(`hash-day-${i}`, "notes/test.md");
    }
    const decision = gate.shouldWrite(
      "x".repeat(600) + "-fourth",
      "user message long enough",
      signCtx(),
    );
    expect(decision.shouldWrite).toBe(false);
    expect(decision.category).toBe("skip");
    expect(decision.reason).toContain("Daily rate limit");
  });

  test("每小时上限仍独立生效", () => {
    const gate = new MemoryGate({ maxWritesPerHour: 2, maxWritesPerDay: 1000 });
    for (let i = 0; i < 2; i++) {
      gate.recordWrite(`hash-hour-${i}`, "notes/test.md");
    }
    const decision = gate.shouldWrite(
      "y".repeat(600) + "-third",
      "user message long enough",
      signCtx(),
    );
    expect(decision.shouldWrite).toBe(false);
    expect(decision.reason).toContain("Hourly rate limit");
  });
});

// ─── #11 skill-quality：原子写 + 路径锚定 + 往返 ─────────────────────────────

describe("skill-quality 文件存储（审计 #11）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-quality-t8-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("save/load 往返且重复覆盖后读到最新值", () => {
    const store = createFileQualityStore(join(dir, "skill-quality.json"));
    store.save({ "auto-a": { calls: 3, successes: 1, lastUsedAt: 1 } });
    expect(store.load()).toEqual({ "auto-a": { calls: 3, successes: 1, lastUsedAt: 1 } });
    store.save({ "auto-a": { calls: 5, successes: 2, lastUsedAt: 2 } });
    expect(store.load()).toEqual({ "auto-a": { calls: 5, successes: 2, lastUsedAt: 2 } });
  });

  test("save 为原子替换：落盘后目录内不残留 .tmp 临时文件", () => {
    const store = createFileQualityStore(join(dir, "skill-quality.json"));
    store.save({ "auto-b": { calls: 1, successes: 1, lastUsedAt: 1 } });
    expect(existsSync(join(dir, "skill-quality.json"))).toBe(true);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("默认落点锚定项目根 data/ 目录（源码级断言：相对字面量缺省已移除）", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "self-evolve", "skill-quality.ts"),
      "utf8",
    );
    // 旧实现：createFileQualityStore(filePath = "data/skill-quality.json") —— 相对 cwd，
    // 目录漂移时读写分裂；新实现默认 path.join(process.cwd(), "data", "skill-quality.json")。
    expect(source.includes('filePath = "data/skill-quality.json"')).toBe(false);
    expect(source.includes('path.join(process.cwd(), "data", "skill-quality.json")')).toBe(true);
  });
});

// ─── #15 env.readInt：严格解析 + 可选范围钳制 ────────────────────────────────

describe("env.readInt 严格解析（审计 #15）", () => {
  const KEY = "OC_T8_INT";
  afterEach(() => {
    delete process.env[KEY];
  });

  test("纯数字串正常解析", () => {
    process.env[KEY] = "42";
    expect(readInt(KEY, 0)).toBe(42);
  });

  test("尾部非数字回退默认值（旧 parseInt('12abc') → 12，为红）", () => {
    process.env[KEY] = "12abc";
    expect(readInt(KEY, 99)).toBe(99);
  });

  test("负数与前导空白回退默认值（旧实现宽松接受，为红）", () => {
    process.env[KEY] = "-5";
    expect(readInt(KEY, 7)).toBe(7);
    process.env[KEY] = " 42";
    expect(readInt(KEY, 7)).toBe(7);
  });

  test("可选范围钳制：超出 min/max 收敛到边界", () => {
    process.env[KEY] = "500";
    expect(readInt(KEY, 0, { min: 1, max: 100 })).toBe(100);
    process.env[KEY] = "0";
    expect(readInt(KEY, 0, { min: 1, max: 100 })).toBe(1);
    process.env[KEY] = "50";
    expect(readInt(KEY, 0, { min: 1, max: 100 })).toBe(50);
  });
});

// ─── #16 permissions：.env 精确段匹配 ────────────────────────────────────────

describe("permissions .env 精确段匹配（审计 #16）", () => {
  test(".env 段与 .env.<suffix> 仍被拦截（read/write）", () => {
    expect(checkFilePermission(".env", "read").allowed).toBe(false);
    expect(checkFilePermission("src/.env", "read").allowed).toBe(false);
    expect(checkFilePermission(".env.local", "write").allowed).toBe(false);
    expect(checkFilePermission("config/.env.production", "delete").allowed).toBe(false);
  });

  test("非 .env 段不再被子串误伤（旧 includes('.env') 为红）", () => {
    expect(checkFilePermission("docs/.environment", "read").allowed).toBe(true);
    expect(checkFilePermission("backup/my.env.bak", "read").allowed).toBe(true);
  });

  test("其他敏感路径语义保持不变", () => {
    expect(checkFilePermission("home/.ssh/id_rsa", "read").allowed).toBe(false);
    expect(checkFilePermission("project/.git/config", "write").allowed).toBe(false);
    expect(checkFilePermission("/etc/passwd", "read").allowed).toBe(false);
    expect(checkFilePermission("src/normal.ts", "read").allowed).toBe(true);
  });
});

// ─── #18 install-wizard：.env 写入 0600（静态断言，仓库既有惯例） ────────────

describe("install-wizard .env 权限（审计 #18 静态断言）", () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, "..", "src", "tui", "install-wizard.ts"),
    "utf8",
  );

  test(".env 写入带 mode: 0o600，且对已存在文件显式 chmod 收敛", () => {
    expect(SOURCE.includes('writeFileSync(".env", envLines.join("\\n") + "\\n", { mode: 0o600 })')).toBe(true);
    expect(SOURCE.includes('chmodSync(".env", 0o600)')).toBe(true);
  });

  test("不存在无 mode 的 .env 写入调用", () => {
    const bare = SOURCE.match(/writeFileSync\("\.env",[^\n]*/g) ?? [];
    expect(bare.length).toBeGreaterThan(0);
    for (const call of bare) {
      expect(call).toContain("0o600");
    }
  });
});
