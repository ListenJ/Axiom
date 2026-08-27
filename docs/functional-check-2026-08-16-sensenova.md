# 后端/核心/功能全量检查 — sensenova deepseek-v4-flash（2026-08-16）

> 检查方式：起真实后端（bun run src/main.ts）→ 逐项实测 API / 核心模块 / 工具链路。目标不是评测提示词，而是「是否符合当前场景效果」。

## 结论总览

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 后端启动 | ✅ | 165 路由，DRE/Vault/SQLiteMemory 初始化成功 |
| 模型路由 | ✅ | /chat 自动选中 sensenova deepseek-v4-flash（fallback_used=false，2.9s） |
| 对话链路 | ✅ | 意图识别 + 角色路由 + 会话持久化 + usage 追踪全通 |
| DRE 管线 | ✅ | /dre/run 六阶段（classify→knowledge→reasoning→constraint→action→reflection）676ms |
| OCR（中文） | ✅ 修复 | chi_sim 语言包缺失曾崩掉整个后端 → 预校验 + 语言包后实测通过 |
| 联网工具 | ✅ 修复 | chat 工具面接入 web_fetch/web_search/search_engines_list（原只有 skills） |
| Vault 记忆 | ✅ | 100 notes / 229K 词 / 统计正常 |
| Agents | ⚠️ | opencode/kimiCode 可用，hermes 未安装 |
| 知识图谱 | ❌ 环境 | PostgreSQL 未配置（DATABASE_URL 缺失） |
| 外部 MCP | ❌ 环境 | sqlite 模块缺失、free-search/filesystem 包 404、freeweb/obsidian 超时 |
| Web 搜索 | ❌ 环境 | duckduckgo 超时 + searxng 未启动 → 空结果 |

## 关键修复（代码）

1. **OCR 崩溃**：tesseract.js worker 找不到语言包时抛未捕获异常 → 整个进程崩溃。`src/ocr/engine.ts` 增加 `assertLangsAvailable` 预校验（缺失给清晰错误 + 可用语言列表）；本地放入 `chi_sim.traineddata`（git-ignored）后中文 OCR 实测 `success:true`，正确识别「有什么可以帮助你的/代码审查/知识问答/解释一下什么是确定性记忆引擎」，结构化输出 + markdown，1.8s。
2. **chat 工具面**：原来只暴露 `skill_run/skill_list`，模型「无法联网」是真实的（新闻情报官 skill 返回模板垃圾）。`src/routes/chat.ts` 三处（chat/agent-chat/chatStream）接入 `web_fetch/web_search/search_engines_list`（复用 DataPipeline，结果自动写 Vault）。实测模型能发现并调用 `search_engines_list`。
3. **sensenova 注册**：`src/router/models/registry.ts` 新增 `deepseek-v4-flash-sensenova`（provider=sensenova，1M ctx，免费国内端点）。/chat 路由实测自动选中该模型。

## sensenova deepseek-v4-flash 可用性（事实）

- 端点 `https://token.sensenova.cn/v1`，模型列表含 deepseek-v4-flash / glm-5.2 / sensenova-6.8-flash-lite 等，**全部免费**（pricing=0，tokenplan/metered）。
- 返回 `content` + `reasoning_content` 分离——比 opencode 的空内容问题（隐藏推理吃预算）处理得更好。
- 实测一句话对话 1.9s；完整工具循环可发起 tool_calls。

## 环境缺口（需运维配置，非代码 bug）

- `DATABASE_URL`/`VAULT_PATH` 未设 → PostgreSQL 知识图谱不可用（/kg/stats 报错）。
- 外部 MCP 依赖缺失/不可达（npmmirror 404、obsidian 超时）。
- web 搜索需可用引擎：duckduckgo 当前网络超时；可启动本地 searxng（config/searxng/settings.yml 已存在）或配置 bing key。
- /health 平台检查未覆盖 sensenova —— 建议后续把 sensenova 加入健康检查清单。

## 2026-08-17 更新 — PostgreSQL + 网络搜索落地

补充到《后端/核心/功能全量检查》：

### PostgreSQL（已完成 ✅）
- data 服务器原生 postgres 需 sudo（不可用）→ 改用 **pgvector/pgvector:pg16 docker 容器**（5433，含 vector 扩展），凭据在本地 secrets + .env（git-ignored）。
- 恢复被移除的真实 `src/db/pg-client.ts`（DATABASE_URL 连接池 / isPgAvailable / initPgSchema / pgQuery / pgBulkInsert / pgVectorSearch）。
- 实测：schema 初始化成功；`/kg/stats` 21268 节点 15316 边；`/kg/entities`、`/kg/search`（语义）全通。

### 网络搜索（已完成 ✅，代理方案替代 CDN/浏览器）
- 根因链：duckduckgo 直连超时 → data 服务器 mihomo 代理 192.168.0.10:7890 可达海外（curl 验证 200）→ app 的 proxyFetch HTTPS 在 Bun 的 `tls.connect({socket})` 隧道挂起（CONNECT 200 后 TLS 升级不兼容）→ **搜索引擎 fetch() 配代理时改用 curl.exe**。
- 实测：`/web-search` 返回 10 条真实结果；chat 内 `web_search`/`web_fetch` 工具真实调用并获取「Node.js 2026 起每年一个主版本、Node 27 起全 LTS」。
- 说明：SEARCH_PROXY 仅作用于搜索，避免 Bun 隧道影响其他 HTTPS 调用；searxng docker 因服务器 8080 被 1Panel openresty 劫持 + 容器上游 TUN 不通而弃用；浏览器/插件搜索方案暂不需要（Playwright 仍在依赖中作备选）。
