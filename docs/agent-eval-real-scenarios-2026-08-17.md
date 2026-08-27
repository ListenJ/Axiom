# Agent 真实任务场景评测 — 全面部署后（2026-08-17）

> 目标：全面部署（docker 容器模式）后，在真实任务场景下评测 Agent 的「是否符合当前场景效果」。通过部署在 data 服务器（192.168.0.10）的容器 API 驱动。

## 部署状态（全面部署 ✅）

| 项 | 状态 |
| --- | --- |
| docker 容器 axiom-agent | ✅ Up (healthy)，端口 18789/3001 |
| PostgreSQL（pgvector 容器） | ✅ 5433，KG 22117 节点 |
| 网络搜索 | ✅ SEARCH_PROXY→mihomo→duckduckgo/bing-html |
| Vault 知识库 | ✅ 149 笔记（52 论文 + 8 模块 + 清单），FTS 已重建（ftsReindexed=149） |
| 账户/鉴权 | ✅ AXIOM_AUTH_TOKEN + 模型 key 在容器 .env |

## 真实场景评测结果

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 1. 联网研究（web_search+web_fetch 多步） | ✅ **通过** | Agent 正确调用 web_search `{"query":...}` → 获取 2026 RAG 文章 → 挑选最相关 → web_fetch 抓取（参数正确） |
| 2. 知识库检索（论文问答） | ⚠️ **部分** | KB 已构建 + FTS 索引（vault.search 直接命中 FlashInfer），但 chat 自适应检索未把笔记放入上下文（应检漏/路由问题） |
| 3. 代码审查（真实文件） | ⚠️ **受限** | Agent 遵循宪法拒绝编造，但 chat 工具面无本地文件读取工具，无法审查真实代码 |
| 4. 基础设施（KG/搜索/Vault/聊天） | ✅ **通过** | /kg/stats、/web-search、/vault/stats、/chat 全通 |

## 评测暴露并修复的真实 bug（本轮）

1. **工具 schema 退化**：`zodToJsonSchema` 不处理纯对象 inputSchema → 全部工具参数变 `{type:string}`，模型瞎编键名（web_search `{"string":...}`）→ 支持纯对象转 object properties（web_search 现在正确传 `{"query":...}`）。**修复**（+3 回归测试）。
2. **duckduckgo 反爬间歇挑战**（经代理 202 挑战页）→ 新增 **bing-html 无 key 引擎** + searchMulti 自动回退；重试仅在 SEARCH_PROXY 场景启用。
3. **KB 笔记未进 FTS**：文件系统同步的论文笔记没走 SQLiteMemory → chat 检索捞不到 → `VaultManager.reindexAll()` 启动重建（容器 `ftsReindexed:149`），`vault.search("FlashInfer")` 直接命中。
4. **docker 部署链**（前置）：frontend bun.lock 漂移、postinstall ensure-env、动态 import bun（awaitPromise）、compose user/plugins、VaultManager dbPath。

## 残余问题（诚实）

- **chat 自适应检索不显示 KB 笔记**：`shouldSearch(intent)` 门控 + `/search` 路由在服务器分发返回 SPA（handler 直接调用正常）——KB 检索需修 `/search` 路由与检索上下文注入（`retrieval 上下文` 只对部分 intent 触发）。
- **chat 无本地文件工具**：代码审查/改代码类任务无法读仓库；MCP filesystem/code-analysis 工具存在但未接入 chat 工具面（只挂了 web+skills）。
- **搜索可靠性**：duckduckgo 经共享代理仍间歇挑战；bing-html 回退已兜底但结果质量一般。
- **本地 proxyFetch 慢**：adaptive-proxy 自动扫描本地代理候选（127.0.0.1:7897 等）+ 健康检查，无网测试环境可能拖慢（docker 部署用 curl 搜索，不受影响）。

## 结论（判断）

- 全面部署完成且容器内核心功能全通；真实场景评测确认 Agent 具备**真实联网多步研究**能力（工具调用正确、遵循宪法不编造）。
- 评测有效暴露 3 类真实问题并修复其 2（工具 schema、搜索可靠性、FTS 索引）；剩余 2 个明确待办：**chat 检索上下文注入** 与 **chat 本地文件工具**。
- 下一步建议：① 修 /search 路由 + 让 chat 检索无条件注入 KB 命中；② 把 MCP filesystem/code-analysis 挂进 chat 工具面；③ 搜索继续加质量回退。

## 2026-08-17 更新 — /search 路由修复后重测：场景 2 通过 ✅

- 路由修复（SPA_ROUTES 劫持 + handleApiKeys 无条件 401 + handleVaultSearch 导航回退）部署到 docker 后，重跑场景 2：
  - docker `/search?q=FlashInfer` → 200 JSON 命中 KB 论文笔记；
  - chat「根据知识库回答 FlashInfer」→ **检索上下文注入**（[自适应检索] 含本地 FlashInfer 笔记），Agent 准确回答（LLM 推理加速库：自定义注意力算子 + KV 缓存管理，解决内存带宽/缓存未命中/高延迟）；
  - docker `/web-search` 仍正常（pgvector 真实结果）。
- 场景 2 从 ⚠️ 部分 → ✅ 通过。剩余：场景 3 代码审查仍受限（chat 工具面无本地文件工具，独立待办）。
