/**
 * 检索键确定性回归测试
 *
 * 背景（审计 C-01/C-02，2026-09-17 修复）：
 *   - retrieveKnowledge 此前默认调用 rewriteKnowledgeQueryWithEdge（LLM 查询改写），
 *     同一自然语言查询每次改写结果可能不同 → 检索键漂移，打破"同输入同输出"。
 *   - settings-search 的 defaultEmbedder 此前本地边缘失败后回落 modelRouter.embeddings
 *     （远端 API）→ "本地语义搜索"实际退化为远端向量搜索。
 *
 * 处置：检索键 = 用户原始查询；embedding 只走本地，不可用降级关键词。
 * 本测试双路验证：静态（链已不存在）+ 行为（原始查询被透传），防链被重新接回。
 */
import { describe, it, expect, mock, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// mock.module 是进程级原地改写（跨文件泄漏）：在任何 mock 之前逐属性展开快照真实现，
// 套件结束后回灌模块注册表（同 tests/consciousness.test.ts 模式；namespace 对象
// 本身会被原地改写，必须展开为独立快照对象）。
import * as realVaultModule from "../../src/memory/vault-manager.js";
import * as realUnifiedSearchModule from "../../src/crawl/unified-search.js";

const REPO = join(import.meta.dir, "..", "..");
const REAL_VAULT_EXPORTS = { ...realVaultModule };
const REAL_UNIFIED_SEARCH_EXPORTS = { ...realUnifiedSearchModule };
const src = (rel: string) => readFileSync(join(REPO, rel), "utf-8");

// ─────────────────────────────────────────────────────────
// 静态断言：被砍的两条链不得回到源码
// ─────────────────────────────────────────────────────────

describe("已砍除链的静态守卫", () => {
  it("edge-assist 不再导出 LLM 查询改写", () => {
    const s = src("src/knowledge/edge-assist.ts");
    expect(s).not.toContain("export async function rewriteKnowledgeQueryWithEdge");
  });

  it("services/knowledge 不再导入/调用查询改写", () => {
    const s = src("src/services/knowledge.ts");
    expect(s).not.toMatch(/rewriteKnowledgeQueryWithEdge\s*\(/);
    expect(s).not.toContain('import("../knowledge/edge-assist.js")');
  });

  it("settings-search 不再回落远端 API embedding（modelRouter）", () => {
    const s = src("src/core/settings-search.ts");
    expect(s).not.toContain("modelRouter");
    expect(s).not.toMatch(/router\.embeddings/);
  });
});

// ─────────────────────────────────────────────────────────
// 行为断言：检索键 = 原始查询（公共接口，不经 LLM）
// ─────────────────────────────────────────────────────────

const captured: string[] = [];
mock.module(join(REPO, "src", "crawl", "unified-search.js"), () => ({
  unifiedSearch: {
    search: async (opts: { query: string; num?: number; cacheTtl?: number }) => {
      captured.push(opts.query);
      return [
        { title: "确定性检索结果", snippet: "检索键透传验证", link: "http://example/1" },
      ];
    },
  },
}));

// 本地 vault 返回空 → queryTool 的 auto 分支必然触发网络搜索，检索键可观测
mock.module(join(REPO, "src", "memory", "vault-manager.js"), () => ({
  // 桩：检索链上多个模块值导入 VaultManager（类型用途），这里给空类即可
  VaultManager: class {},
  getGlobalVault: () => ({ search: () => [] }),
}));

const { retrieveKnowledge } = await import(join(REPO, "src", "services", "knowledge.js"));

describe("retrieveKnowledge 检索键确定性", () => {
  it("自然语言查询原样进入检索（不被改写）", async () => {
    process.env.AXIOM_PRIVACY_MODE = "0";
    captured.length = 0;
    const q = "怎么配置 nginx 的反向代理？";
    await retrieveKnowledge({ query: q, intent: "knowledge", confidence: 0.9 });
    expect(captured).toContain(q);
  });

  it("同输入连续两次运行，检索键完全一致", async () => {
    process.env.AXIOM_PRIVACY_MODE = "0";
    captured.length = 0;
    const q = "docker compose 端口映射怎么配";
    await retrieveKnowledge({ query: q, intent: "question", confidence: 0.2 });
    await retrieveKnowledge({ query: q, intent: "question", confidence: 0.2 });
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured[0]).toBe(q);
    expect(captured.every((c) => c === q)).toBe(true);
  });
});

afterAll(() => {
  // mock.module 是进程级原地改写：套件结束后回灌真实现，防止 VaultManager 空类与
  // unified-search 假实现泄漏到同进程后续测试文件（2026-09-26 归一全量发现的跨文件污染源）。
  mock.module(join(REPO, "src", "memory", "vault-manager.js"), () => REAL_VAULT_EXPORTS);
  mock.module(join(REPO, "src", "crawl", "unified-search.js"), () => REAL_UNIFIED_SEARCH_EXPORTS);
});
