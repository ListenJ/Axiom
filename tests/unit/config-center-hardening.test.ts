/**
 * Step 4 回归：ConfigCenter 敏感审计 / 单一事实源 / 原子写 / 畸形 env / 未知类型。
 *
 * 证据（OCR）：
 *   - src/core/config-center.ts:261 set() 审计日志存原始 oldValue/newValue（敏感键泄露）；
 *   - src/core/config-center.ts:607 getConfig() 绕过 ConfigCenter 直调 readString/readInt；
 *   - src/core/config-center.ts:444 saveYaml() 直接 writeFileSync，非原子；
 *   - src/core/config-center.ts:474 checkType() 未知类型返回 valid:true（fail-open）。
 * 附带核查：OCR 称 resolveEnvVars 遇未闭合 ${VAR 会抛异常 —— 本轮未复现，
 * 用守卫用例锁定“按字面保留、不抛异常”的现有行为，不改代码。
 */
import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigCenter,
  CONFIG_SCHEMA,
  getConfig,
  getConfigCenter,
  resetConfigCenter,
} from "../../src/core/config-center.js";

function tmpYaml(name: string): string {
  return path.join(os.tmpdir(), `axiom-config-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
}

describe("Step 4 — ConfigCenter 加固", () => {
  afterEach(() => {
    resetConfigCenter();
  });

  test("AC-1 敏感键审计脱敏；非敏感键保持原值", () => {
    const cc = new ConfigCenter(tmpYaml("audit"));
    cc.set("gateway.auth_token", "supersecret-token-123456", "tester", false);
    const entry = cc.getAuditLog(1)[0];
    expect(entry).toBeDefined();
    expect(String(entry.newValue)).not.toContain("supersecret-token-123456");
    expect(String(entry.newValue)).toMatch(/\*\*\*\*/);
    expect(String(entry.oldValue)).not.toContain("supersecret-token-123456");

    cc.set("memory.vault_path", "/tmp/legit-vault", "tester", false);
    expect(cc.getAuditLog(1)[0].newValue).toBe("/tmp/legit-vault");
  });

  test("AC-2 getConfig 尊重 ConfigCenter runtime override（单一事实源）", () => {
    resetConfigCenter();
    const cc = getConfigCenter();
    cc.set("memory.obsidian_api_port", 12345, "tester", false);
    cc.set("memory.obsidian_api_token", "runtime-token", "tester", false);
    cc.set("crawler.search_api", "runtime-search", "tester", false);
    cc.set("crawler.request_delay", 4321, "tester", false);

    const cfg = getConfig();
    expect(cfg.memory.obsidianApiPort).toBe(12345);
    expect(cfg.memory.obsidianApiToken).toBe("runtime-token");
    expect(cfg.crawler.searchApi).toBe("runtime-search");
    expect(cfg.crawler.requestDelay).toBe(4321);
  });

  test("AC-3 saveYaml 原子写：临时文件 + rename，无残留 .tmp", () => {
    const yamlPath = tmpYaml("atomic");
    const cc = new ConfigCenter(yamlPath);
    cc.set("memory.vault_path", "/tmp/atomic-vault", "tester", true);

    expect(fs.existsSync(yamlPath)).toBe(true);
    expect(fs.readFileSync(yamlPath, "utf8")).toContain("/tmp/atomic-vault");
    const leftovers = fs
      .readdirSync(path.dirname(yamlPath))
      .filter((f) => f.startsWith(path.basename(yamlPath)) && f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    fs.rmSync(yamlPath, { force: true });
  });

  test("AC-3 静态接线：saveYaml 使用 renameSync(tmpPath)", () => {
    const src = fs.readFileSync("src/core/config-center.ts", "utf8");
    expect(src).toContain("renameSync(tmpPath");
    expect(src).toContain(".tmp");
  });

  test("AC-4 未闭合 ${VAR 不抛异常且按字面保留（OCR 发现未复现，守卫锁定）", () => {
    // Bun 会自动加载仓库 .env，OBSIDIAN_VAULT_PATH 会覆盖 YAML；本用例只验证 resolveEnvVars
    // 对未闭合 ${ 的字符串行为，因此临时摘掉该 ENV。
    const saved = process.env.OBSIDIAN_VAULT_PATH;
    delete process.env.OBSIDIAN_VAULT_PATH;
    const yamlPath = tmpYaml("malformed");
    fs.writeFileSync(yamlPath, "memory:\n  vaultPath: '${UNCLOSED'\n", "utf8");
    try {
      let cc: ConfigCenter | undefined;
      expect(() => { cc = new ConfigCenter(yamlPath); }).not.toThrow();
      expect(cc!.getString("memory.vault_path")).toBe("${UNCLOSED");
    } finally {
      if (saved === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
      else process.env.OBSIDIAN_VAULT_PATH = saved;
      fs.rmSync(yamlPath, { force: true });
    }
  });

  test("AC-5 checkType 未知类型 fail-closed（validate 报错）", () => {
    const fake = {
      key: "test.unknown_type",
      envVar: "TEST_UNKNOWN_TYPE",
      yamlPath: "test.unknownType",
      type: "mystery" as never,
      required: false,
      default: "x",
      description: "test",
      category: "advanced" as const,
    };
    CONFIG_SCHEMA.push(fake);
    try {
      const cc = new ConfigCenter(tmpYaml("unknown"));
      const result = cc.validate();
      expect(result.errors.some((e) => e.key === "test.unknown_type")).toBe(true);
    } finally {
      const idx = CONFIG_SCHEMA.indexOf(fake);
      if (idx >= 0) CONFIG_SCHEMA.splice(idx, 1);
    }
  });

  test("AC-6 getNumber 非有限值回退 schema 默认（轮 7 审计：YAML 空值/runtime set(null) 归 0 风险）", () => {
    // 轮 7 审计 §4.2：YAML 显式空值（`obsidianApiPort:`）以 null 入 values 表，
    // getNumber = Number(null ?? 0) = 0 → obsidianApiPort=0 / requestDelay=0（无节流）；
    // set(key, null) 同病。getNumber 应对非有限结果回退 schema.default。
    const cc = new ConfigCenter(tmpYaml("empty-numeric"));
    // 直接注入 null（模拟 YAML 空值或 runtime set(null) 后的存储态）
    (cc as unknown as { values: Map<string, { key: string; value: unknown; source: string; lastModified: number; validated: boolean }> }).values.set("memory.obsidian_api_port", {
      key: "memory.obsidian_api_port",
      value: null,
      source: "yaml",
      lastModified: Date.now(),
      validated: true,
    });
    expect(cc.getNumber("memory.obsidian_api_port")).toBe(27124); // schema 默认，非 0
    cc.set("crawler.request_delay", null);
    expect(cc.getNumber("crawler.request_delay")).toBe(1000); // schema 默认
    // 正常路径不受影响：显式值仍然生效
    cc.set("crawler.request_delay", 500);
    expect(cc.getNumber("crawler.request_delay")).toBe(500);
    // 无 schema 登记的键保持旧行为（0），不影响未登记键的调用方
    expect(cc.getNumber("not.in.schema")).toBe(0);
  });
});
