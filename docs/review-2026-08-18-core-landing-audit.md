# 功能内核落地核查（2026-08-18）

> 目的：核查各功能模块“声称的能力”是否真正实现、可用，并标记空壳/未接通/待验证。
> 方法：代码静态审阅 + 操作日志/审计报告交叉验证；未运行真实测试（当前环境无终端）。

---

## 一、已确认真正落地（有实现 + 有测试/证据）

| 模块 | 能力 | 落地证据 |
| --- | --- | --- |
| DRE 三段甄别 | 阶段2 网络校验 | `pipeline.ts` 真实调用 SearchAggregator；`tests/dre-stage2-webverify.test.ts` 3 用例 |
| DRE 哈希 | SHA-256 统一 | `pipeline.ts` `hashContent()` 使用 `createHash("sha256")` |
| DRE 突触衰减 | epoch 增量 | `engine.ts` + `store.ts` `decay_epoch`/`synapse_meta`；压测 575µs→52µs |
| 搜索去重 | 纯字符串 normalizeUrl | `search-engines.ts`；压测 5189µs→437µs |
| Bing `site:` | 查询拼接 | `search-engines.ts`；`tests/crawl-site-param.test.ts` |
| Bing-html 可用 | 已加入 | `isEngineAvailable` |
| 外部基准 | HumanEval/MBPP | `external-benchmarks/` 164+974 条 |
| DSH 插件 lossless-JSON | 已修复 | `mcp-bridge.ts` 省略 undefined structuredContent、isError 帧转错误 |
| web_fetch 正文 | 已修复 | `chat.ts` 返回 `content: markdown.slice(0,8000)` |
| Vault reindex mtime | 已修复 | `vault-manager.ts` 读取 `fs.statSync().mtimeMs` |

## 二、本轮新增优化（本次会话）

| 文件 | 改动 | 状态 |
| --- | --- | --- |
| `src/ocr/engine.ts` | `assertLangsAvailable` 增加 langPath 目录不存在时的友好错误，避免 readdirSync ENOENT | ✅ 已改 |
| `src/dre/llm/client.ts` | `generateConstrained` 区分 `llm_unavailable` 与 `schema_validation_failed`；`selectMode` 增加 `modeAmbiguous` 标记 | ✅ 已改 |
| `src/dre/engine.ts` | `decide` 钩子 JSON.parse 增加 try/catch 并给出可诊断错误，保持降级链 | ✅ 已改 |

## 三、仍未落地/待验证（按优先级）

| 项 | 现状 | 建议 |
| --- | --- | --- |
| 流式记忆合一 | `CognitivePipeline.runWithLLM` 反思 lessons 未写 Vault；`persist=true` 未加 | 短期：反思 lessons 同步写 Vault；MCP 工具加 persist 参数 |
| 外部基准接入评测 | 数据已引入，未桥接 `agent-evals` runner | 新增 `src/agent-evals/external.ts` 适配层 |
| UnifiedSearch 单例 | 模块加载即打开 `./data/search-cache.db`，无显式生命周期 | 改为显式 `init()`/延迟打开 |
| curlFetch 同步阻塞 | `spawnSync` 阻塞事件循环 | 改为异步 `Bun.spawn` 或加并发信号量 |
| DataPipeline 选择器 | 正则仅支持简单选择器，SITE_RULES 复杂选择器不生效 | 引入轻量 CSS 选择器解析或改用 html-to-markdown |
| SearXNG 公共实例 | 默认硬编码 `https://search.sapti.me` | 默认空，未配置则不启用 |
| DSH 磨砂主题真实验证 | 未在 DSH 页面截图/视觉回归 | 用 `screenshot.mjs` 截图 + SenseNova 审核 |
| DSH 插件重新挂载 | 已从 profile 剥离 | 运行 verify.ps1 后重新 `dsh plugin add` |

## 四、结论

- 核心功能“空实现”问题已基本消除（P0 网络校验已落地）。
- 仍存在若干“架构完整但未接通”的点：流式记忆→持久层、外部基准→评测框架、UnifiedSearch 生命周期、搜索/渲染健壮性。
- 本轮优先修复了 3 个低风险可诊断性问题；下一步建议按上表顺序推进。

---

*本报告基于静态审阅，未替代真实测试；所有改动需在可用终端运行 `bun test` 验证。*