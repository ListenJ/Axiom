/**
 * 发布面闸门：`devOnly` 模型**默认不参与自动解析**（2026-09-20 用户裁定）
 *
 * ## 被锁住的声明
 * 用户裁定（2026-09-20）：**SiliconFlow 暂留，但仅作开发/测试，不作为发布的一部分。**
 * 该声明必须是**可验证的行为**，不能只是一句注释 —— 本文件就是它的门禁。
 *
 * ## 机制（三处，缺一即声明不成立）
 * 1. `src/router/models/types.ts` 的 `UnifiedModel.devOnly`（数据标记）；
 * 2. `src/router/model-capability-registry.ts` 的 `findModelsForRole` **出口过滤**
 *    （`AXIOM_ALLOW_DEV_MODELS=1` 才放行）；
 * 3. `src/router/user-config-loader.ts` 把 `devOnly` **透传**到 capability ——
 *    否则 `config/model-router.yaml` 里那条 siliconflow embedding 会**绕过**闸门。
 *
 * ## 为什么 "零网络" 用子进程验
 * `ModelRouter.embeddings()`（`src/router/model-router.ts:1055-1078`）在 `:1057`
 * 就因"无 embedding 路由"抛错，**早于** `:1066` 的 `proxyFetch`。
 * 但本仓库多处以 `mock.module` 整模块替换 model-router（Bun 的 mock 是**进程级**），
 * 故 router 级断言放在**独立子进程**里跑，保证测到的是真实现而非邻居的 mock。
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { UNIFIED_REGISTRY } from "../../src/router/models/registry.js";
import {
  DEV_MODELS_ENV,
  areDevModelsAllowed,
  findModelsForRole,
  getModel,
  listAllRoles,
} from "../../src/router/model-capability-registry.js";
import { loadUserModels, resetUserModels, parseModelRouterYaml } from "../../src/router/user-config-loader.js";
import { snapshotEnv } from "../../src/utils/env.js";

const ROOT = join(import.meta.dir, "..", "..");
const YAML_PATH = join(ROOT, "config", "model-router.yaml");

/** 让整组用例都在"发布默认"下开始，并在结束时恢复现场（避免跨文件 env / 注册表泄漏）。 */
let envSnap: { restore: () => void };

beforeAll(() => {
  envSnap = snapshotEnv([DEV_MODELS_ENV]);
  delete process.env[DEV_MODELS_ENV];
  resetUserModels();
});

afterAll(() => {
  resetUserModels();
  envSnap.restore();
});

describe("发布面闸门：devOnly 模型默认不可解析", () => {
  it("数据标记存在且非空 —— devOnly 条目全部来自 siliconflow（防标错/标空）", () => {
    const devOnly = UNIFIED_REGISTRY.filter((m) => m.devOnly);
    expect(devOnly.length).toBeGreaterThan(0);
    for (const m of devOnly) expect(m.provider).toBe("siliconflow");
    // 反向：embedding 角色含本地非 dev 条目 + SiliconFlow dev 条目
    const regEmbedding = UNIFIED_REGISTRY.filter((m) => m.roles.includes("embedding"));
    expect(regEmbedding.map((m) => m.id)).toEqual(["local-bge-m3", "bge-embedding"]);
  });

  it(`默认（未设 ${DEV_MODELS_ENV}）→ embedding 角色解析不出 siliconflow 条目`, () => {
    expect(areDevModelsAllowed()).toBe(false);
    const resolved = findModelsForRole("embedding");
    expect(resolved.filter((m) => m.provider === "siliconflow")).toEqual([]);
    expect(resolved.filter((m) => m.devOnly)).toEqual([]);
  });

  it("闸门是**系统性**的：任意角色的默认解析结果里都不含 devOnly", () => {
    for (const role of listAllRoles()) {
      const leaked = findModelsForRole(role).filter((m) => m.devOnly);
      expect(leaked.map((m) => m.id)).toEqual([]);
    }
  });

  it("但**没有被删除**：显式按 id 仍可取到（闸门 ≠ 删除）", () => {
    expect(getModel("bge-embedding")?.provider).toBe("siliconflow");
    expect(getModel("bge-embedding")?.devOnly).toBe(true);
  });

  it("显式放行 AXIOM_ALLOW_DEV_MODELS=1 → 该条目恢复可解析", () => {
    const snap = snapshotEnv([DEV_MODELS_ENV]);
    process.env[DEV_MODELS_ENV] = "1";
    try {
      expect(areDevModelsAllowed()).toBe(true);
      expect(findModelsForRole("embedding").map((m) => m.id)).toEqual(["local-bge-m3", "bge-embedding"]);
    } finally {
      snap.restore();
    }
  });
});

describe("发布面闸门：真实 config/model-router.yaml 不得绕过", () => {
  it("yaml 里的 embedding 条目带 devOnly（解析层可见）", () => {
    const entries = parseModelRouterYaml(readFileSync(YAML_PATH, "utf8"));
    const emb = entries.filter((e) => e.roles?.includes("embedding"));
    expect(emb.length).toBeGreaterThan(0);
    for (const e of emb) expect(e.devOnly).toBe(true);
  });

  it("端到端：加载真实 yaml 后，默认下 embedding 仍解析不出 siliconflow", () => {
    resetUserModels();
    const report = loadUserModels({ configPath: join(ROOT, "data", "model-config.json"), yamlPath: YAML_PATH });
    expect(report.errors).toEqual([]);
    try {
      const resolved = findModelsForRole("embedding");
      expect(resolved.filter((m) => m.provider === "siliconflow")).toEqual([]);
    } finally {
      resetUserModels();
    }
  });

  it("端到端：放行后同一条 yaml 条目**确实可用**（证明闸门可逆、非删除）", () => {
    resetUserModels();
    const snap = snapshotEnv([DEV_MODELS_ENV]);
    process.env[DEV_MODELS_ENV] = "1";
    try {
      loadUserModels({ configPath: join(ROOT, "data", "model-config.json"), yamlPath: YAML_PATH });
      const ids = findModelsForRole("embedding").filter((m) => m.provider === "siliconflow").map((m) => m.id);
      expect(ids.length).toBeGreaterThan(0);
    } finally {
      snap.restore();
      resetUserModels();
    }
  });
});

describe("发布面闸门：默认 embedding 路由不误选 SiliconFlow", () => {
  it("独立进程实测：本地路由无 key 时抛 'Missing API key'，且是**先于网络**的短路", () => {
    // 关键：**故意**给一个（假）key。若实现是"先解析路由再取 key"，或"先取 key 再发请求"，
    // 那么这里就会走到 `Missing API key` 或 `Embedding request failed` 而不是"无路由"。
    // 因此断言错误文案 = 短路确实发生在路由解析处（早于 proxyFetch）。
    const script = `
      import { router } from "./src/router/model-router.js";
      try {
        await router.embeddings(["probe"]);
        console.log("RESULT=NO_THROW");
      } catch (e) {
        console.log("RESULT=" + (e?.message ?? String(e)));
      }
    `;
    const res = spawnSync(process.execPath, ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, [DEV_MODELS_ENV]: "", LOCAL_EMBED_API_KEY: "", SILICONFLOW_API_KEY: "test-placeholder-not-a-real-key" },
      timeout: 60_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).toContain("RESULT=Missing API key for embedding");
    // 用例预算（2026-10-19）：体内是嵌套 bun 子进程（冷启动 + 加载 router 模块图 6~22s），
    // 必须显式声明且严格大于 spawnSync 的 60s，否则默认 5s 会把它误报为断言失败。
  }, 90_000);
});
