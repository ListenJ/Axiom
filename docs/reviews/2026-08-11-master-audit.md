---
type: review
created: 2026-08-11
tags: [audit, master, frontend, backend, config, toolchain]
---

# Axiom 全面审核总报告（2026-08-11）

> 本轮审核方式：并行子代理（配置/后端/工具链）+ SenseNova 视觉模型（前端 10 页）+ 主线程汇总。子代理受上游 provider 影响多次失败，最终 3/4 成功；前端改为 SenseNova 视觉审核（用户指定）。

## 一、四份报告索引（事实）

| 领域 | 报告 | 关键结论 |
| --- | --- | --- |
| 前端视觉 | `docs/reviews/2026-08-11-frontend-visual-sensanova-review.md` | 10 页平均 6.8/10；P0×7、P1×20、P2×20；共性：辅助文字对比度不足、空态/占位块、缺品牌强调色 |
| 后端架构 | `docs/reviews/2026-08-11-backend-architecture-review.md` | 架构上乘（22 项护栏、统一执行端口、降级文化、凭据零硬编码）；P1×4：purgeOld 无调用方、auto-induce skill 幂等失效、model-config.json 死配置、executeWithRole 无模型时 throw |
| 内核配置 | `docs/reviews/2026-08-11-config-hardcode-review.md` | 配置底座良好但三处致命断链：`config/model-router.yaml` 死文件、`/models` 写 `data/model-config.json` 但 router 不读、`config/axiom.yaml` models 不消费；`router/models/registry.ts` 50+ 模型硬编码；7+ 业务模块直连硬编码；内网 IP 硬编码（P0）；双份 PROVIDER_CONFIG 漂移 |
| 工具链 | `docs/reviews/2026-08-11-toolchain-review.md` | **bun 1.3.14 本身稳定，无需迁移 npm/vitest**；全量 2300 通过/14 失败，13 个为 mock.module 跨文件泄漏，`bun test --parallel`（隐含 --isolate）可根治；CI 只跑白名单有盲区；CI 缓存键 `bun.lockb` 失效；BUN_VERSION 未钉死 |

## 二、统一行动清单（按性价比排序）

### P0（本轮工具链修复，已完成见下）
1. `package.json`：`test` 脚本改为 `bun test --parallel tests/`（隔离 mock 泄漏）
2. `package.json`：新增 `packageManager: bun@1.3.14` 钉版本
3. `.github/workflows/ci.yml`：缓存键 `**/bun.lockb` → `**/bun.lock`；`BUN_VERSION: "1.3"` → `"1.3.14"`

### P0（配置断链，需下一轮实施，详见 config 报告）
4. 新增 `user-config-loader` 深模块：`data/model-config.json` + `model-router.yaml` 经 `registerModel()` 注入 registry EXTENSIONS，让前端 `/models` 配置真正生效
5. 收敛双份 PROVIDER_CONFIG（`router/models/providers.ts` 与 `utils/api-key-store.ts`），以 api-key-store 为唯一事实源
6. 业务模块（prompt-optimizer/intent-enhancer/knowledge-pipeline/codegraph-sync/hermes-agent）一律走 `router.executeWithRole`，显式指定时读 `XXX_MODEL/XXX_BASE_URL` env
7. edge-client/edge-embeddings 默认地址 `${LAN_NODE_N1}` → `127.0.0.1`

### P1（后端/前端，下一轮）
8. `model-output-store.purgeOld` 接入定时清理（磁盘无限增长）
9. `skill-promotion` skill id 去 `Date.now()` 后缀，保证幂等去重
10. `executeWithRole` 无模型时返回降级响应而非 throw
11. 前端：侧边栏/导航辅助文字对比度提升；空态/占位块补内容或骨架屏；引入品牌强调色（见视觉报告）

## 三、审核方法论与局限（事实）
- 子代理 5 次 spawn 中 4 次因上游 provider `Console Go` 400 报错失败；最终后端/配置/工具链 3 份成功，前端子代理失败后改用 SenseNova 视觉模型完成。
- 前端仅审暗色主题；light/交互态未覆盖（待后续）。
- 工具链数据来自 Raman 实测（全量 126s、单测复现污染子集）。

---
*主线程汇总：2026-08-11。*
