import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  DEFAULT_WEB_SEARCH_CONFIG_PATH,
  MISSING_CONFIG_REVISION,
  WebSearchConfigConflictError,
  WebSearchConfigValidationError,
  applyWebSearchPatch,
  computeWebSearchRevision,
  loadWebSearchConfig,
  loadWebSearchConfigWithRevision,
  saveWebSearchConfig,
  resolveWebSearchConfigPath,
  setEngineEnabled,
} from "../../src/crawl/web-search-config.js";

/**
 * P1（2026-10-22）并发安全测试：内容修订号 / 原子写 / 乐观并发（CAS） / 补丁白名单。
 * 全部在 os.tmpdir() 的临时目录内进行，**不触碰仓库真实 config/web-search.yaml**。
 */
let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-websearch-"));
  cfgPath = join(dir, "web-search.yaml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true }); // 测试自建临时目录（非仓库路径）
});

describe("web-search-config 修订号与原子写", () => {
  test("缺失文件使用固定哨兵修订号（可参与 CAS）", () => {
    expect(computeWebSearchRevision(null)).toBe(MISSING_CONFIG_REVISION);
    const loaded = loadWebSearchConfigWithRevision(cfgPath);
    expect(loaded.revision).toBe(MISSING_CONFIG_REVISION);
    expect(loaded.config.engines.length).toBeGreaterThan(0);
  });

  test("保存返回新修订号，且与重新读取的修订号一致（原子落盘后可解析）", () => {
    const { config, revision } = loadWebSearchConfigWithRevision(cfgPath);
    const next = structuredClone(config);
    next.aggregate.max_results = 20;

    const newRevision = saveWebSearchConfig(next, cfgPath, { expectedRevision: revision });
    expect(newRevision).not.toBe(revision);

    const reloaded = loadWebSearchConfigWithRevision(cfgPath);
    expect(reloaded.revision).toBe(newRevision);
    expect(reloaded.config.aggregate.max_results).toBe(20);

    // 原子写：同目录不应残留 tmp 文件
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);

    // 第二次保存（基于第一版内容）应把旧内容备份为 .bak
    const revision2 = loadWebSearchConfigWithRevision(cfgPath).revision;
    const second = structuredClone(loadWebSearchConfig(cfgPath));
    second.aggregate.max_results = 30;
    saveWebSearchConfig(second, cfgPath, { expectedRevision: revision2 });
    expect(readdirSync(dir)).toContain("web-search.yaml.bak");
  });

  test("CAS 冲突：磁盘内容已变时用旧修订号保存必须失败，且不破坏磁盘内容", () => {
    const first = loadWebSearchConfigWithRevision(cfgPath);
    const cfg = structuredClone(first.config);
    cfg.aggregate.max_results = 15;
    const revA = saveWebSearchConfig(cfg, cfgPath, { expectedRevision: first.revision });

    // 模拟「另一个窗口」在 A 之后又写了一次
    const external = loadWebSearchConfig(cfgPath);
    external.aggregate.max_results = 30;
    const revB = saveWebSearchConfig(external, cfgPath, { expectedRevision: revA });
    const beforeConflict = readFileSync(cfgPath, "utf-8");

    // A 持有旧修订号再次保存 → 冲突
    const stale = structuredClone(first.config);
    stale.aggregate.max_results = 99;
    let thrown: unknown;
    try {
      saveWebSearchConfig(stale, cfgPath, { expectedRevision: revA });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WebSearchConfigConflictError);
    const err = thrown as WebSearchConfigConflictError;
    expect(err.expectedRevision).toBe(revA);
    expect(err.actualRevision).toBe(revB);
    // 磁盘内容未被旧值覆盖
    expect(readFileSync(cfgPath, "utf-8")).toBe(beforeConflict);
    expect(loadWebSearchConfig(cfgPath).aggregate.max_results).toBe(30);
  });

  test("setEngineEnabled 走 CAS 且能持久化开关", () => {
    expect(setEngineEnabled("duckduckgo", false, cfgPath)).toBe(true);
    const loaded = loadWebSearchConfig(cfgPath);
    expect(loaded.engines.find((e) => e.id === "duckduckgo")?.enabled).toBe(false);
    expect(setEngineEnabled("does-not-exist", true, cfgPath)).toBe(false);
  });
});

describe("配置路径 seam（A5：默认值不变，仅测试可覆盖）", () => {
  test("未设置 AXIOM_WEB_SEARCH_CONFIG 时路径与历史默认值完全一致", () => {
    const prev = process.env.AXIOM_WEB_SEARCH_CONFIG;
    delete process.env.AXIOM_WEB_SEARCH_CONFIG;
    try {
      expect(resolveWebSearchConfigPath()).toBe(DEFAULT_WEB_SEARCH_CONFIG_PATH);
      expect(DEFAULT_WEB_SEARCH_CONFIG_PATH).toBe("./config/web-search.yaml");
    } finally {
      if (prev !== undefined) process.env.AXIOM_WEB_SEARCH_CONFIG = prev;
    }
  });

  test("设置 env 时解析到隔离路径（供集成测试使用），空串视为未设置", () => {
    const prev = process.env.AXIOM_WEB_SEARCH_CONFIG;
    try {
      process.env.AXIOM_WEB_SEARCH_CONFIG = cfgPath;
      expect(resolveWebSearchConfigPath()).toBe(cfgPath);
      process.env.AXIOM_WEB_SEARCH_CONFIG = "   ";
      expect(resolveWebSearchConfigPath()).toBe(DEFAULT_WEB_SEARCH_CONFIG_PATH);
    } finally {
      if (prev === undefined) delete process.env.AXIOM_WEB_SEARCH_CONFIG;
      else process.env.AXIOM_WEB_SEARCH_CONFIG = prev;
    }
  });
});

describe("applyWebSearchPatch 白名单与校验", () => {
  test("已知字段生效", () => {
    const { config } = applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, {
      aggregate: { max_results: 20 },
      policy: { respect_robots: false },
      engines: [{ id: "duckduckgo", enabled: false }],
    });
    expect(config.aggregate.max_results).toBe(20);
    expect(config.policy.respect_robots).toBe(false);
    expect(config.engines.find((e) => e.id === "duckduckgo")?.enabled).toBe(false);
  });

  test("未知字段被**拒绝**（D3 决策：不静默忽略，避免脏数据进入配置）", () => {
    expect(() =>
      applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { aggregate: { unknown_knob: 1 } }),
    ).toThrow(WebSearchConfigValidationError);
    expect(() =>
      applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { totallyUnknownSection: { x: 1 } }),
    ).toThrow(WebSearchConfigValidationError);
    expect(() =>
      applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { engines: [{ id: "no-such-engine", enabled: true }] }),
    ).toThrow(WebSearchConfigValidationError);
    // ifRevision 是并发控制元数据，白名单内允许（不写入配置）
    const ok = applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { ifRevision: "abc", aggregate: { max_results: 11 } });
    expect(ok.applied).toContain("aggregate.max_results");
  });

  test("非法类型/越界抛校验错误（避免把脏值写进配置）", () => {
    expect(() =>
      applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { aggregate: { max_results: "20" } }),
    ).toThrow(WebSearchConfigValidationError);
    expect(() =>
      applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { aggregate: { max_results: 999 } }),
    ).toThrow(WebSearchConfigValidationError);
    expect(() =>
      applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { searxng: { base_url: "file:///etc/passwd" } }),
    ).toThrow(WebSearchConfigValidationError);
    expect(() =>
      applyWebSearchPatch(DEFAULT_WEB_SEARCH_CONFIG, { policy: { user_agent: "a\nb" } }),
    ).toThrow(WebSearchConfigValidationError);
  });

  test("不修改入参配置（纯函数）", () => {
    const base = structuredClone(DEFAULT_WEB_SEARCH_CONFIG);
    applyWebSearchPatch(base, { aggregate: { max_results: 42 } });
    expect(base.aggregate.max_results).toBe(10);
  });
});
