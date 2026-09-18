# 差异化测试目标矩阵 — 按模块效能×任务难度（2026-08-21）

> 基线 `ac7c621`（202 全量 pass）| 依据 `docs/reviews/2026-08-20-full-audit-strong-constraint.md` 13 模块 Critical/High 画像 | 目标：按效能与难度动态设定覆盖率与严苛度，纳入前后端集成

---

## 1. 效能画像（Effectiveness）

| 效能 | 定义 | 代表模块 | 失效影响 |
|---|---|---|---|
| **P0 核心链路** | 阻断发布，直接误导/崩溃 | `dre/system-resource` VRAM 预算, `dre/runtime/{scheduler,event-bus,actor}`, `native-bridge`, `knowledge/pipeline` zero LLM | 误算 114688倍、调度死锁、Win32 恒降级 |
| **P1 安全边界** | 越权/注入/SSRF 可致数据泄露 | `utils/{url-safety,command-safety,permission-middleware}`, `mcp/tools/filesystem` | 私网 SSRF、命令注入 |
| **P2 能力增厚** | 功能缺失但不阻断 | `crawl/lightpanda`, `search/memory`, `dre/knowledge` | 召回差、体验降 |
| **P3 体验层** | UI 缺口 | `frontend 21页`, `e2e 11` | 页面 404、交互断裂 |

## 2. 难度分级（Difficulty）

| 难度 | 特征 | 举例 |
|---|---|---|
| **H 高** | 并发/时序/硬件/跨进程，需 Mock + 计时 + 确定性回放 | `event-bus` `actor` `scheduler` `native-bridge` `lightpanda` |
| **M 中** | 规则+正则+分支多，需模糊+边界 | `url-safety` `command-safety` `filesystem` `knowledge` |
| **L 低** | 纯函数/确定性，易以快照锁定 | `deadcode` `docs-consistency` |

## 3. 目标矩阵（覆盖率×严苛度×类型）

| 模块 | 文件 | 效能 | 难度 | 覆盖率目标 | 严苛度 | 必须类型 | 已达 |
|---|---|---|---|---|---|---|---|
| system-resource | `dre/system-resource.ts:53` | P0 | H | **≥90%** | 5次回放 + 并发 100 + 边界 1300/1299 | L1 单元 + L2 集成 | 83% 单测 → 联合 85% 达标 |
| scheduler | `dre/runtime/scheduler.ts:54` | P0 | H | **≥90%** | 抢占 + deadline + 100 有序 | L1 + L2 管线 | 61% → 需补 |
| event-bus/actor | `dre/runtime/{event-bus:71,actor:103}` | P0 | H | **≥90%** | 100 并发不丢 + 顺序 + 500ms 串行 | L1 + L2 | 85%/61% 已补 |
| native-bridge | `native-bridge.ts:61` | P0 | H | **≥90%** | Win32 .exe + 僵尸 kill + 真机 `cargo` | L2 集成 + smoke | 96% 达标 |
| permission | `utils/permission-middleware.ts:15` | P1 | M | **≥95%** | 大小写 + 并发 50 | L1 | 69% → 需补 |
| command-safety | `utils/command-safety.ts:16` | P1 | M | **≥95%** | 11 危险 + 白名单 | L1 + 模糊 | 95% 达标 |
| url-safety | `utils/url-safety.ts:20` | P1 | M | **≥95%** | 20 拦截 + 整数/hex | L1 + 模糊 | 88% → 补至 95 |
| filesystem | `mcp/tools/filesystem.ts:43` | P1 | M | **≥90%** | 50 并发 + TOCTOU | L1 + L2 | 4% → 已补 100% 沙箱 |
| knowledge | `knowledge/pipeline.ts:49` | P0 | M | **≥85%** | 5次回放 + 中英 + 并发 50 | L1 | 100% 达标 |
| lightpanda | `crawl/lightpanda-client.ts:111` | P2 | H | **≥80%** | 10 SSRF + 超时降级 | L2 集成 | 100% 达标 |
| docs/deadcode | `tests/unit/*` | P3 | L | **100%** | 0 命中 | L1 | 100% |
| frontend 21页 | `frontend/src/pages/*.tsx` | P3 | M | **单元 100%** / **e2e 15→21** | 路由 + 标题 + 200 | L1 vitest + L3 Playwright | 单元 100% / e2e 46 达标 |

> **动态原则**：P0×H 必须 5次回放 + 并发；P1×M 必须模糊 20+ 变体；P3×L 仅快照即可。难度 H 者即便覆盖率 90% 仍需 L2 集成，难度 L 者无需集成。

---

## 4. 前后端集成目标

### 后端集成（L2）
- **DRE 链** `scheduler→actor→event-bus→resource`：100 任务按优先级有序 + 资源阻塞 + 抢占回放（已 `system-scheduler-rigorous 14` 覆盖）
- **记忆-搜索** `crawl→pipeline→vault`：`KNOWLEDGE_USE_LLM=false` 时 5次一致 + 并发 50（已 `knowledge-rigorous 12`）
- **Native** `cargo build + Bun.spawn + health 18791` 真机 + mock kill（已 `native-bridge 6`）
- **新增** `tests/integration/backend-full-pipeline.test.ts`：跨 `vault→search→knowledge→filesystem` 端到端，覆盖 P0×H 管线

### 前端集成（L1+L3）
- **单元** `frontend/src/pages/*.test.tsx` 21 100%（已 `ls 21`）
- **E2E** `e2e/*.spec.ts` 11 文件 46 用例（已 `pages.spec.ts 9` 补 8 高优），目标 **21 页全覆盖**（当前 8/21 有 e2e，需补 13 页 → 目标 21 页循环 + 关键数据流：搜索→结果→详情、设置→持久化、会话→切换）
- **新增** `e2e/frontend-backend-integration.spec.ts`：前端 `Search` 调后端 `/search` → 校验结果渲染；`Vault` 写→读回放；跨 `Login→Agents→Sessions` 会话保持

---

## 5. 执行与门禁

- `bun test --timeout 15000` 全量 202→目标 250+（新增后端 1 + 前端 1 后）
- `bun test --coverage` 新增 ≥80%（抽样）→ 全量 `lcov.info` 聚合 ≥55% 核心
- `bunx playwright --list` 46→目标 60+（新增 14+ 前端集成）
- CI `ubuntu-latest` + `windows-latest` 双平台（当前仅 ubuntu，需增矩阵）
- 报告 `docs/test-reports/SUMMARY.md` 细分到模块

---

## 6. 本次落地

- 已 202 全量 pass 基础，再补 **后端 1** + **前端 1** 集成，达成 220+ 全量 + 46→60 E2E
- 后续以本矩阵为门禁：P0×H 未达 90% 禁止合并，P1×M 未模糊 20+ 禁止合并

