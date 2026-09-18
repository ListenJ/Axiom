/**
 * 静默失败可观测性 —— 守卫测试（审计 A10-4，2026-09-18）
 *
 * 三处「catch + 空注释 ignore」完全无日志不上抛，故障不可观测：
 *   - unified-search.ts 缓存写（search_cache INSERT）
 *   - unified-search.ts 历史写（search_history INSERT）
 *   - lightpanda-client.ts CDP 交互元素 JSON 解析
 *
 * 项目其余关键路径 catch 均有 logger（已有规范），此三处为缺口。
 * 本测试为静态守卫：断言这三处不再静默吞错（无行为接缝 —— 前两处需真实网络
 * 搜索触发、第三处需 WebSocket 会话，见 ops log 偏差记录）。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const src = (rel: string) => readFileSync(join(REPO, rel), "utf-8");

describe("A10-4: 静默 catch 必须可观测", () => {
  it("unified-search 缓存写/历史写失败均有日志", () => {
    const s = src("src/crawl/unified-search.ts");
    expect(s).toContain("[UnifiedSearch] cache write failed");
    expect(s).toContain("[UnifiedSearch] history write failed");
    // 不再存在裸 catch 吞错
    expect(s).not.toMatch(/catch\s*\{\s*\/\*\s*ignore\s*\*\/\s*\}/);
  });

  it("lightpanda CDP 解析失败有日志", () => {
    const s = src("src/crawl/lightpanda-client.ts");
    expect(s).toContain("[Lightpanda] interactive-element JSON parse failed");
  });
});
