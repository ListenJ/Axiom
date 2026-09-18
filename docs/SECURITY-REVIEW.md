# 生产就绪审查报告（终审）

> 日期：2026-07-26 ｜ 审查人：Kimi Code ｜ 范围：免费服务化、Omini 真实项目实测、网络安全/端口/信息暴露/流窜防御
> 结论：**修复后可达生产就绪**（在本文约束条件下）

## 一、免费服务核验（全部使用免费服务）

### 实测可用的免费链路

| 角色 | 可用免费模型 | 状态 |
|---|---|---|
| general-chat / general-tool / english / intent-classifier | zhipu glm-4.7-flash（直连免费） | ✅ 实测通过 |
| 全角色兜底（decision/evaluation/research/code-*/architecture） | zhipu glm-4.7-flash + glm-4-flash + siliconflow THUDM/GLM-4-9B-0414 | ✅ 已补免费覆盖（原这些角色零免费模型） |
| embedding | siliconflow BAAI/bge-m3（免费档） | ✅ |
| 提示词增强 | GLM 免费链（zhipu → siliconflow） | ✅ 实测通过 |
| 边缘判断（分类/初筛/整理） | 本地 llama.cpp（零成本） | ✅ 实测通过 |
| 搜索 | SearXNG 公共实例 / DuckDuckGo（无 key） | ✅ 免费 |
| 知识来源 | GitHub trending、Wiktionary、Gutenberg/arXiv | ✅ 免费 |

### 修复的注册表问题（`registry.ts`）

- `zhipu/GLM-5.1` → `Pro/zai-org/GLM-5.1`、`zhipu/GLM-5` → `zai-org/GLM-5.2`（实测 siliconflow 命名空间，原 id 不存在）
- `glm-4.7-flash-free` → `THUDM/GLM-4-9B-0414`（原 `zhipu/GLM-4.7-Flash:free` 不存在）
- `glm-4-flash-zhipu` / `bge-embedding` isFree 纠正为 true
- `glm-4.7-flash-zhipu` / `glm-4-flash-zhipu` / `glm-4.7-flash-free` 角色覆盖扩到 decision/evaluation/research/code-*/architecture

### Router 效率修复（`model-router.ts`）

- **永久性失败（缺 key/型号不存在/未授权）不再重试**：此前每个死模型每次请求烧 maxRetries 次（实测一个 /chat 烧 ~50 秒才到可用模型）
- **5 分钟黑名单**：死模型拉黑后后续请求直接跳过
- 实测：修复后死模型每个只花 ~1s 一次；注意你的 siliconflow 账户实际有 GLM-5.1 付费权限（修复 id 后它成功响应了）。若要**严格免费**，把付费条目禁用或删除 key 即可，免费兜底已覆盖全角色

## 二、Omini 真实项目实测

Omini（`${LAN_NODE_N1}:/home/listen/Omini`，CUDA 推理引擎，克隆于 `.tmp-e2e/omini`）：

- 真实 kernel 代码问答（gate_params 扩展、decode 8 tok/s 瓶颈分析）：主模型给出专业可用答案，意图增强的"思考框架"结构真实生效
- 提示词优化（GLM 链）+ 意图分类（边缘 2B）在生产路径实测通过
- MCP 工具执行（terminal_exec/fs_read/web_fetch）实测通过

## 三、安全审查：发现 → 修复 → 实证

| # | 发现（严重度） | 修复 | 实证 |
|---|---|---|---|
| 1 | **MCP HTTP 0.0.0.0:3001 零认证**，全工具面暴露（HIGH） | 默认绑定 127.0.0.1（`MCP_HOST` 可显式改），远程必须 x-api-key，无 token fail-closed | netstat 确认回环；远程无 token 401 |
| 2 | **`/config` 明文返回 AXIOM_AUTH_TOKEN** 等密钥（HIGH） | 序列化剥离 auth/obsidianApiToken/serpapiKey，仅回 authConfigured 布尔 | curl 确认 token 不再出现 |
| 3 | **terminal_exec 子进程继承全部 env**（HIGH，任意命令可读全部 API key） | spawn env 过滤 `*_KEY/*_TOKEN/*_SECRET/PASSWORD/CREDENTIAL` | 实测 `env` 输出无密钥变量 |
| 4 | **SSRF**：MCP web_fetch 零校验；重定向跳不校验（HIGH/MED） | 共享 `utils/url-safety.ts`；proxyFetch 新增 `ssrfGuard` 逐跳校验；crawlStructured 全局启用 | 抓取 127.0.0.1:18789/config 被拒 |
| 5 | **`/models` 明文存储+回显 apiKey**、POST 无二次认证（MED） | GET/POST 响应仅回末 4 位；POST/DELETE 加 requireAuthToken | 无 token 401；回显仅 last4 |
| 6 | **fs 沙箱根=仓库根**，.env/数据库可读（MED） | isPathSafe 敏感区域拒绝：.env*/.git/data/*.db/model-config.json | fs_read .env 被拒、package.json 放行 |
| 7 | sanitizeCommand 黑名单可绕过 + 审批层死代码（HIGH） | 部分缓解：见残留风险 R1 | — |

### 端口设计与用户回退余地（答案）

- 网关默认 `127.0.0.1:18789`（`HOST`/`AXIOM_GATEWAY_PORT` 可改）；**回环豁免**（`AXIOM_ALLOW_LOCAL_BYPASS`，默认开）就是给用户的回退通道——token 丢失时本机永远可进，远程未配 token 时敏感路由 503 fail-closed，无后门
- MCP 现在同样：回环默认可用，远程必须 token
- 端口被占用=启动即崩（fail-fast），换端口即可；token 比较为常量时间

### 残留风险（未修，需决策）

- **R1**：`terminal_exec` 的 sanitizeCommand 是黑名单（可绕过：`rm -r --force`、`find -delete`、base64 管道、Windows `rmdir /s`），且 `executeWithModeGuard`/`checkToolPermission` 无调用方（审批层死代码）。建议：MCP 工具注册处接 permission-middleware + 本项目的双层复核，或换白名单。**这是下一步最重要的项**
- **R2**：`data/model-config.json` 落盘仍明文（回显已脱敏）；建议复用 api-key-persistence 加密
- **R3**：`POST /sandbox/execute` 命令拼接有 args 注入；Windows 无资源限制
- **R4**：token 存 localStorage + CSP `unsafe-inline`（前端 XSS 面）；无 TLS（公网暴露需反代终结）
- **R5**：Bing API 为付费项（无 key 时优雅跳过，不影响免费化）；ofoxai-gemini 未注册进 api-key-store、NVIDIA provider 名不一致（"nim" vs "nvidia-nim"）
- **R6**：默认数据外发——vault/代码/对话默认发往云端 LLM，无"隐私模式"开关（有本地边缘层但非全链路）

### 预存测试失败（与本次无关，stash 对比确认）

Architecture Integrity ×3（架构守卫规则）、DataPipeline 网络用例 ×1、EventBus 竞争 ×1、services-chat（getFileSymbolsFromCodeGraph 导出缺失）、CognitivePipeline（偶发）。

## 四、验证汇总

- 新增 `tests/security-fixes.test.ts` 16 用例全绿；全量回归 2000+ 用例零新增失败；`tsc --noEmit` 全绿
- 服务端到端：/chat 真实代码问答、/config、/models、MCP 工具面、SSRF、env 过滤全部实测通过
