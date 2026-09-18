# 审计遗留项二期（Remediation Phase 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛审计留档项——Rust 引擎确定性收口、缓存键强化、搜索域多样性、DNS rebinding 纵深、dre→router 依赖倒置，以及能力演进四小项。

**Architecture:** Phase A/B 聚焦核心承诺与安全纵深（纯函数化+可注入时钟/解析器保证可测）；Phase C 以端口接口倒置依赖方向；Phase D 为能力演进 spike 与卫生项。全部沿用 TDD 红→绿、每任务独立提交的既有纪律。

**Tech Stack:** Rust (cargo, axum, rayon) / TypeScript (Bun, node:crypto, node:dns) / bun:test

## Global Constraints

- 全程遵守 AGENTS.md：改前备份 `.tmp/backups/`、读全文、最小改动、验证后删备份；提交推送 `internal211 codex/self-evolving-agent`。
- 不引入任何新第三方依赖（Rust 不加 filetime/once_cell 等；TS 仅用 node 内建与 Bun 内建）。
- 每任务完成门禁：`bun run lint` 0 错误；相关测试套件全绿；Rust 任务另加 `cargo test -p oc-search` 且工作区 `cargo build` 通过。
- 文档数字一律标注快照日期或改为动态断言，禁止新增易漂移硬编码。

---

### Task 1: Rust 搜索引擎确定性收口（M9）

**Files:**
- Modify: `native/crates/shared/src/types.rs:38-45`（SearchOptions 增加 `include_recency`）
- Modify: `native/crates/search/src/indexer.rs:109-112`（modified_at 改用文件真实 mtime）
- Modify: `native/crates/search/src/engine.rs:201-258`（评分抽纯函数 + recency 门控 + 同分按 path 升序稳定排序）
- Modify: `native/crates/local/src/main.rs`（构造 SearchOptions 字面量补新字段）
- Test: `indexer.rs` / `engine.rs` 的 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `SearchOptions { ..., #[serde(default)] pub include_recency: bool }`；`pub(crate) fn compute_score(note:&LiteNote, tokens:&[String], include_recency:bool, now_secs:u64) -> f64`

- [ ] **Step 1: 写失败测试（mtime 来自文件而非索引时刻）**

在 `indexer.rs` 测试模块追加：

```rust
#[test]
fn modified_at_uses_file_mtime_not_index_time() {
    let dir = std::env::temp_dir().join(format!("oc-mtime-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("a.md");
    std::fs::write(&p, "---\ntitle: A\n---\nbody\n").unwrap();
    let older = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    set_mtime(&p, older);

    let idx = VaultIndex::new(&dir);
    let note = idx.get("a.md").unwrap();
    let want = older.duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap().as_secs();
    assert_eq!(note.modified_at, want, "modified_at 必须等于文件 mtime");
    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(windows)]
fn set_mtime(p: &std::path::Path, t: std::time::SystemTime) {
    use std::os::windows::fs::FileTimesExt;
    let f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
    f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
}
#[cfg(unix)]
fn set_mtime(p: &std::path::Path, t: std::time::SystemTime) {
    let f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
    f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
}
```

> 注：`std::fs::FileTimes` 自 Rust 1.75 起跨平台可用（含 windows ext），零新依赖。

- [ ] **Step 2: 写失败测试（默认无 recency；开启时加分且同分按 path 升序）**

在 `engine.rs` 测试模块追加：

```rust
use super::*;
use std::collections::HashMap;

fn note_with(path: &str, title: &str, age_secs: u64) -> LiteNote {
    LiteNote {
        path: path.into(), title: title.into(),
        frontmatter: HashMap::new(), tags: vec![], wiki_links: vec![], backlinks: vec![],
        word_count: 1,
        modified_at: std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap().as_secs() - age_secs,
    }
}

#[test]
fn recency_off_by_default_and_on_when_flagged() {
    let n_old = note_with("01-projects/old.md", "KW old", 86_400 * 365);
    let tokens = vec!["kw".to_string()];
    let s_off = compute_score(&n_old, &tokens, false, 0);
    let s_on_now = compute_score(&n_old, &tokens, true, n_old.modified_at);
    let s_on_old = compute_score(&n_old, &tokens, true, n_old.modified_at + 86_400);
    assert_eq!(s_off, compute_score(&note_with("x.md", "KW x", 0), &tokens, false, 0),
        "关闭 recency 时年龄不得影响得分");
    assert!(s_on_now > s_on_old, "开启 recency 时越新得分越高");
}

#[test]
fn ties_sorted_by_path_ascending() {
    let dir = std::env::temp_dir().join(format!("oc-tie-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("03-resources")).unwrap();
    for name in ["c.md", "a.md", "b.md"] {
        std::fs::write(dir.join("03-resources").join(name),
            format!("---\ntitle: KW {name}\n---\nbody {name}\n")).unwrap();
    }
    let eng = DeterministicEngine::new(dir.to_string_lossy().into_owned());
    let opts = SearchOptions { limit: 10, types: None, tags: None, para_category: None,
        date_range: None, include_reasons: false, include_recency: false };
    let r1: Vec<String> = eng.search("kw", &opts).iter().map(|r| r.note.path.clone()).collect();
    let r2: Vec<String> = eng.search("kw", &opts).iter().map(|r| r.note.path.clone()).collect();
    assert_eq!(r1, r2, "两次调用顺序必须一致");
    let mut sorted = r1.clone(); sorted.sort();
    assert_eq!(r1, sorted, "同分必须按路径升序稳定输出");
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 3: 运行确认失败**

Run: `cd native && cargo test -p oc-search`
Expected: 编译失败（`include_recency` 不存在 / `compute_score` 未定义）。

- [ ] **Step 4: 实现**

`shared/types.rs` SearchOptions 追加：

```rust
    /// M9：是否启用时间衰减新近度加分（默认关闭以保严格确定性）
    #[serde(default)]
    pub include_recency: bool,
```

`indexer.rs` `index_note` 中替换 modified_at 赋值：

```rust
        let modified_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
```

`engine.rs`：`score_and_rank` 改造为纯函数调用 + 同分稳定排序：

```rust
    fn score_and_rank(
        &self,
        candidates: &mut [(Arc<LiteNote>, f64, Vec<String>)],
        plan: &QueryPlan,
        opts: &SearchOptions,
    ) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        candidates.par_iter_mut().for_each(|(note, score, reasons)| {
            let mut s = compute_score(note, &plan.tokens, opts.include_recency, now);
            // wiki-link/backlink 相关性留在纯函数外
            let link_matches = note.wiki_links.iter()
                .filter(|l| plan.tokens.iter().any(|t| l.to_lowercase().contains(t))).count();
            s += link_matches as f64 * 10.0;
            s += note.backlinks.len() as f64 * 4.0;
            *score = s;
            reasons.push(format!("score={:.1}", s));
        });
        // M9：同分按 path 升序稳定输出
        candidates.sort_by(|a, b| {
            b.1.partial_cmp(&a.1).unwrap()
                .then_with(|| a.0.path.cmp(&b.0.path))
        });
    }
```

文件底部追加纯函数：

```rust
/// M9：确定性评分纯函数（recency 显式开关，now 由调用方注入以便测试）
pub(crate) fn compute_score(
    note: &LiteNote,
    tokens: &[String],
    include_recency: bool,
    now_secs: u64,
) -> f64 {
    use oc_shared::utils::{tokenize_unique, slugify};
    let title_tokens = tokenize_unique(&note.title);
    let title_score = oc_shared::utils::score_tokens(tokens, &title_tokens);
    let mut s = title_score * 30.0;
    let tag_matches = tokens.iter().filter(|t| note.tags.iter().any(|tag| tag == *t)).count();
    s += tag_matches as f64 * 25.0;
    if let Some(para) = slugify(&note.path).split('/').next() {
        if tokens.iter().any(|t| para.contains(t)) { s += 5.0; }
    }
    if include_recency {
        let age_days = now_secs.saturating_sub(note.modified_at) / 86_400;
        s += (30.0 / (1.0 + age_days as f64)).min(5.0);
    }
    s
}
```

`local/src/main.rs` 两处 `SearchOptions{...}` 字面量补 `include_recency: false,`（cloud crate 若有字面量同样补齐，以 cargo build 报错为准）。

- [ ] **Step 5: 通过 + 工作区构建**

Run: `cd native && cargo test -p oc-search && cargo build --workspace`
Expected: 全部 PASS；workspace 无编译错误。

- [ ] **Step 6: Commit**

```bash
git add native/crates
git commit -m "fix(native): M9 搜索引擎确定性收口(mtime/同分序/recency门控)"
```

---

### Task 2: unified-search 强缓存键（L12a）

**Files:**
- Modify: `src/crawl/unified-search.ts:283-292`
- Test: `tests/unit/unified-cache-key.test.ts`（新建）

**Interfaces:**
- Produces: `export function strongCacheKey(...parts: Array<string | number>): string`

- [ ] **Step 1: 失败测试**

```ts
import { describe, test, expect } from "bun:test";
import { strongCacheKey } from "../../src/crawl/unified-search.js";

describe("strongCacheKey（L12a）", () => {
  test("相同输入稳定；不同输入不碰撞", () => {
    const k1 = strongCacheKey("q", ["a", "b"], 10, 0.5);
    expect(k1).toBe(strongCacheKey("q", ["a", "b"], 10, 0.5));
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(strongCacheKey(`q${i}`, ["e"], i, i / 100));
    expect(seen.size).toBe(500);
  });

  test("输出形如 cache_<32hex>", () => {
    expect(strongCacheKey("x", [], 1, 0)).toMatch(/^cache_[0-9a-f]{32}$/);
  });
});
```

- [ ] **Step 2: 失败运行**

Run: `bun test tests/unit/unified-cache-key.test.ts`
Expected: FAIL（未导出 strongCacheKey）。

- [ ] **Step 3: 实现**（unified-search.ts 顶部 import 区 + 类外导出）

```ts
import { createHash } from "node:crypto";

/** L12a：SHA-256 强缓存键（替代 32 位弱 hash，消除串缓存碰撞面） */
export function strongCacheKey(...parts: Array<string | number>): string {
  return "cache_" + createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}
```

类内 `buildCacheKey` 委托：

```ts
  private buildCacheKey(query: string, engines: string[], num: number, threshold: number): string {
    return strongCacheKey(query, engines.join(","), num, threshold);
  }
```

- [ ] **Step 4: 通过 + 回归**

Run: 目标测试 PASS；`bun test tests/unit/web-search-truncation.test.ts tests/settings-search.test.ts` 回归绿；lint 0 错。

- [ ] **Step 5: Commit** `fix(crawl): L12a unified-search SHA-256 强缓存键`

### Task 3: 搜索域名多样性上限（L12b）

**Files:**
- Modify: `src/crawl/search-engines.ts`（导出纯函数 + searchMulti 接线）
- Test: `tests/unit/domain-diversity.test.ts`（新建）

**Interfaces:**
- Produces: `export function enforceDomainDiversity<T extends { link: string }>(results: T[], maxPerDomain: number): T[]`

- [ ] **Step 1: 失败测试**

```ts
import { describe, test, expect } from "bun:test";
import { enforceDomainDiversity } from "../../src/crawl/search-engines.js";

const mk = (i: number, host: string) => ({
  position: i, title: `t${i}`, link: `https://${host}/p/${i}`,
  displayedUrl: "", snippet: "s", source: host, engine: "ddg",
});

describe("enforceDomainDiversity（L12b）", () => {
  test("单域最多保留 maxPerDomain 条，其余让位后续域", () => {
    const input = [
      ...Array.from({ length: 5 }, (_, i) => mk(i, "a.com")),
      mk(5, "b.com"), mk(6, "c.com"),
    ];
    const out = enforceDomainDiversity(input, 2);
    expect(out.map((r) => new URL(r.link).hostname)).toEqual(["a.com", "a.com", "b.com", "c.com"]);
  });

  test("max<=0 或空数组直通", () => {
    expect(enforceDomainDiversity([], 3)).toEqual([]);
    const one = [mk(0, "x.io")];
    expect(enforceDomainDiversity(one, 0)).toEqual(one);
  });

  test("主机名大小写归一", () => {
    const input = [mk(0, ""), { ...mk(1, ""), link: "HTTP://Shop.Example.COM/a" }];
    expect(enforceDomainDiversity(input, 1)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 失败运行** `bun test tests/unit/domain-diversity.test.ts` Expected: FAIL（未导出）。

- [ ] **Step 3: 实现**（search-engines.ts，置于 mergeAndDeduplicate 之后）

```ts
/** L12b：域名多样性 —— 每 host 至多保留 maxPerDomain 条，防单域垄断结果页 */
export function enforceDomainDiversity<T extends { link: string }>(results: T[], maxPerDomain: number): T[] {
  if (maxPerDomain <= 0 || results.length === 0) return results;
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const r of results) {
    let host = "";
    try { host = new URL(r.link).hostname.toLowerCase(); } catch { /* 解析失败计入 unknown 桶 */ }
    const c = (counts.get(host) ?? 0) + 1;
    counts.set(host, c);
    if (c <= maxPerDomain) out.push(r);
  }
  return out;
}
```

`searchMulti` 返回行改为：

```ts
    const merged = this.mergeAndDeduplicate(results.flat());
    const maxPerDomain = Number(readString("SEARCH_MAX_PER_DOMAIN", "3")) || 3;
    return enforceDomainDiversity(merged, maxPerDomain);
```

- [ ] **Step 4: 通过 + 回归**（`tests/crawl/` 套件 + lint）+ Commit `feat(crawl): L12b 域名多样性上限(默认3/域,可配 SEARCH_MAX_PER_DOMAIN)`

---

### Task 4: DNS rebinding 纵深（L13）

**Files:**
- Modify: `src/utils/url-safety.ts`（新增 `assertResolvedHostSafe`）
- Modify: `src/utils/proxy-fetch.ts`（ssrfGuard 初始校验与重定向逐跳处各加一行解析后校验）
- Test: `tests/unit/resolved-host-guard.test.ts`（新建）

**Interfaces:**
- Produces: `export async function assertResolvedHostSafe(hostname: string, resolve?: (h: string) => Promise<string[]>): Promise<void>`

- [ ] **Step 1: 失败测试**

```ts
import { describe, test, expect } from "bun:test";
import { assertResolvedHostSafe } from "../../src/utils/url-safety.js";

describe("assertResolvedHostSafe（L13）", () => {
  test("解析含私网/环回 → 抛错", async () => {
    await expect(assertResolvedHostSafe("evil.example",
      async () => ["10.0.0.7"])).rejects.toThrow(/private/i);
    await expect(assertResolvedHostSafe("rebind.example",
      async () => ["93.184.216.34", "127.0.0.1"])).rejects.toThrow(/private/i);
  });

  test("全公网放行；解析失败放行(交由连接层报错)", async () => {
    await expect(assertResolvedHostSafe("ok.example",
      async () => ["93.184.216.34"])).resolves.toBeUndefined();
    await expect(assertResolvedHostSafe("nx.example",
      async () => { throw new Error("ENOTFOUND"); })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 失败运行** Expected: FAIL（未导出）。

- [ ] **Step 3: 实现**（url-safety.ts；复用文件内 isPrivateIPv4）

```ts
import { promises as dnsPromises } from "dns";

/** L13：解析后二次校验（缓解 DNS-rebinding 到私网）；解析失败不拦截，交由连接层报错。
 *  TOCTOU 残窗（校验后连接前再变）为已知局限，在 LIMITATIONS 披露。 */
export async function assertResolvedHostSafe(
  hostname: string,
  resolve: (h: string) => Promise<string[]> =
    async (h) => (await dnsPromises.lookup(h, { all: true })).map((a) => a.address),
): Promise<void> {
  try {
    const addrs = await resolve(hostname);
    for (const ip of addrs) {
      if (ip.includes(".") && isPrivateIPv4(ip)) {
        throw new Error(`resolved private address blocked: ${hostname} -> ${ip}`);
      }
      const bare = ip.replace(/^\[|\]$/g, "").toLowerCase();
      if (bare.includes(":") && (bare === "::1" || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare))) {
        throw new Error(`resolved private ipv6 blocked: ${hostname} -> ${ip}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("blocked")) throw err;
    // ENOTFOUND 等解析异常不在此拦截
  }
}
```

`proxy-fetch.ts`：初始 URL 的 `if (opts.ssrfGuard && !isSafeUrl(url.href))` 块之后追加：

```ts
      // L13：DNS 解析后二次校验（rebinding 缓解）
      await assertResolvedHostSafe(url.hostname);
```

重定向逐跳处 `isSafeUrl(url.href)` 通过后追加同一调用。

- [ ] **Step 4: 通过 + 回归**（目标测试 + `tests/crawl/curl-fetch.test.ts` + lint）+ Commit `fix(security): L13 ssrfGuard 解析后私网二次校验(rebinding缓解)`

---

### Task 5: dre→router 依赖倒置（L1）

**Files:**
- Create: `src/dre/ports/cloud-caller.ts`
- Modify: `src/dre/engine.ts`（cloudConsciousnessStep 改走端口；删除对 `../router/provider-caller.js` 的动态 import 与 provider 名硬编码）
- Modify: `src/router/provider-caller.ts`（底部新增适配器 createDreCloudAdapter）
- Modify: `src/dre/host.ts`（组合根装配默认适配器）
- Modify: `src/dre/config.ts` 或 engine DREConfig 定义处（增加可选字段 cloudCaller）
- Test: `tests/architecture-integrity.test.ts` 新增断言

**Interfaces:**
- Port: `export interface DreCloudCaller { call(input: { system: string; user: string; timeoutMs: number; temperature: number }): Promise<{ content: string }>; }`
- Config: `DREConfig.cloudCaller?: DreCloudCaller`

- [ ] **Step 1: 架构断言（RED）** 在 architecture-integrity 测试追加：

```ts
test("L1: src/dre 不得引用上层 router/", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
        const c = readFileSync(p, "utf8");
        if (/from\s+"(\.\.?\/)*router\//.test(c) || /import\("[^"]*\/router\//.test(c)) hits.push(p);
      }
    }
  };
  walk("src/dre");
  if (hits.length) console.log("[L1] dre→router 引用:\n" + hits.join("\n"));
  expect(hits).toEqual([]);
});
```

Run: `bun test tests/architecture-integrity.test.ts -t "L1"` Expected: FAIL（engine.ts 命中）。

- [ ] **Step 2: 实现**

`src/dre/ports/cloud-caller.ts`（新建）：

```ts
/** L1 端口：云端降级调用器（组合根注入适配器，核心不再反向依赖路由层） */
export interface DreCloudCallInput {
  system: string;
  user: string;
  timeoutMs: number;
  temperature: number;
}

export interface DreCloudCaller {
  call(input: DreCloudCallInput): Promise<{ content: string }>;
}
```

engine.ts：删除 `await import("../router/provider-caller.js")` 与 `callProvider(...)` 调用块，改为：

```ts
    const caller = this.config.cloudCaller;
    if (!caller) throw new Error("[DRE] cloudCaller 未装配，无法执行云端降级");
    if (!fb?.apiKey) throw new Error("[DRE] cloudFallback 未配置 apiKey，无法执行云端降级");
    const result = await caller.call({
      system: DRE_DECISION_SYSTEM,
      user: input.observation,
      timeoutMs: 30000,
      temperature: 0,
    });
```

DREConfig 增加 `cloudCaller?: import("./ports/cloud-caller.js").DreCloudCaller;`。

provider-caller.ts 底部追加适配器（原 override 语义原样迁移，provider 名/baseUrl/model 校验内聚于此，顺带消除 M10 硬编码问题面）：

```ts
import type { DreCloudCaller } from "../dre/ports/cloud-caller.js";

/** L1 适配器：DRE 云端口 → 具体 provider 调用 */
export function createDreCloudAdapter(fb: { baseUrl?: string; apiKey?: string; model?: string }): DreCloudCaller {
  return {
    async call(input) {
      const result = await callProvider(
        fb.baseUrl ? "custom-openai" : "deepseek",
        fb.model ?? "deepseek-v4-flash",
        [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        input.timeoutMs,
        input.temperature,
        undefined,
        undefined,
        { baseURL: fb.baseUrl, apiKey: fb.apiKey },
      );
      return { content: result.content ?? "" };
    },
  };
}
```

host.ts init 中 cloudFallback 就绪后装配：

```ts
    if ((config as { cloudFallback?: { apiKey?: string } }).cloudFallback?.apiKey
        && !(config as { cloudCaller?: unknown }).cloudCaller) {
      const { createDreCloudAdapter } = await import("../../router/provider-caller.js");
      (config as { cloudCaller?: unknown }).cloudCaller =
        createDreCloudAdapter((config as { cloudFallback?: { baseUrl?: string; apiKey?: string; model?: string } }).cloudFallback!);
    }
```

（若 host.ts 类型可直接引用 DREConfig 则去掉断言写法。）

- [ ] **Step 3: GREEN**：L1 断言 PASS；`tests/dre-scenarios.test.ts` B/C、`tests/integration/backend-full-pipeline.test.ts`、lint 全绿。

- [ ] **Step 4: Commit** `refactor(dre): L1 端口倒置解除 dre→router 反向依赖(顺带收敛M10 provider语义)`

---

### Task 6: Phase D 能力演进与卫生

#### 6a. MCP tools/list 载荷基线测量（懒加载前置 spike）

**Files:** Create `scripts/mcp-payload-size.mjs`
- [ ] 实现：动态 import `src/mcp/server.ts` 不可行（会拉起服务）——改为静态扫描 ToolRegistry 注册面（复用 `src/testing/tool-count.ts` 思路）+ 估算每工具 schema 字节（读取 zod shape 源码段不可靠），因此脚本交付物定义为：统计 188 工具的 name+description 字节数与 inputSchema 源码近似字节（按注册文件分片计），输出 JSON 到 stdout。验收：数字落盘 `docs/test-reports/mcp-payload-baseline.json` 并在报告中引用。
- [ ] Commit `chore(mcp): tools/list 载荷基线测量脚本`

> 真·懒加载实现（registry 存 zod shape factory、tools/list 仅返回元数据）依据基线数据另立计划，不在本计划盲改协议层。

#### 6b. 编排链生产者接线（M3 最小闭环）

**Files:** Modify `src/dre/kernel.ts`（init 订阅 reasoning.request → scheduler.submit）、Modify `src/dre/actor/system.ts`（四个 Behavior 增加 execute 分支返回结构化应答）
- [ ] 失败测试（orchestration-closure 追加）：提交 task assignedTo="reasoning"、topic="execute"，经 createDefaultActorSystem ask 得到非 error 应答且 payload 含 `{ executed: true, actor: "reasoning" }`。
- [ ] 实现：Behavior.execute 分支统一返回 `{ id: resp-, type:"response", topic:"execute.result", payload:{ executed:true, actor:this.id }, replyTo }`（诚实代理标记，与既有 query/validate 同构，不伪造业务结果）。
- [ ] kernel.init 接线：

```ts
    eventBus.subscribe("reasoning.request", (event: RuntimeEvent) => {
      scheduler.submit({
        name: "reasoning-request",
        priority: "normal",
        payload: event.data,
        assignedTo: "reasoning",
        maxRetries: 1,
        dependencies: [],
      });
    });
```

- [ ] 回归：dre-core-modules + orchestration-closure 全绿；Commit `feat(dre): M3 编排链生产者接线(reasoning.request→scheduler→actor execute 应答)`

#### 6c. kg 近重复工具 deprecation 标注（L11）

**Files:** Modify `src/mcp/server/kg-tools.ts`
- [ ] 四组重复中每组保留主工具，副工具 description 前缀 `[deprecated] 使用 <主工具>`（不改行为、不删注册，兼容既有客户端）。组别映射：kg_enhanced_stats→kg_stats；kg_echarts_data/kg_d3_data→kg_graph；kg_search_nodes/kg_entities→kg_search；cognitive_pipeline_run(_full)/cognitive_loop(_full)→保留 cognitive_loop 主口径。
- [ ] 断言：tool-count 总数不变（188）；kg-tools 相关既有测试绿。Commit `docs(mcp): L11 kg 近重复工具 deprecation 标注`

#### 6d. 行数快照自动化（L15）

**Files:** Create `scripts/doc-linecount.mjs`
- [ ] 输出 README 模块表涉及文件的物理行数 JSON；README 表格注释追加命令指引 `bun run scripts/doc-linecount.mjs`。Commit `chore(docs): L15 行数快照自动化脚本`

---

## 执行顺序与里程碑

- **Phase A（本日）**: Task 1 → Task 2（核心承诺收口 + 缓存键）
- **Phase B**: Task 3 → Task 4（搜索质量与安全纵深）
- **Phase C**: Task 5（架构解耦）
- **Phase D**: Task 6a→6d（能力演进与卫生）

每任务独立提交并推送；全部完成后运行一次全量矩阵（预期 ≥450 用例全绿）并在 operations-log 追加批次 6 条目。

