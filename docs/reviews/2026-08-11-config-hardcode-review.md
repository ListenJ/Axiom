# 内核与配置模板化审核报告（硬编码审计）

- **日期**：2026-08-11
- **性质**：只读审核；本报告为唯一写产物
- **扫描范围**：`src/`、`frontend/src`、`config/`、`scripts/`、`skills/`（跳过 node_modules / dist / data / axiom-memory）
- **目标**：全部不要写死——API Key 与模型链接（baseURL）由用户自配置

---

## 摘要

项目已有**良好的配置底座**（`env.ts` 类型化读取 + `api-key-store.ts` 运行时覆盖 + `config-center.ts` 统一 ENV/YAML/Runtime 优先级 + `cli/setup.ts` 安装向导 + 前端 `/api-keys` 设置页），但存在**三类关键问题**：

1. **配置断链（最严重）**：三套"用户模型配置"入口全部不生效——
   - `config/model-router.yaml` **无任何代码引用（死文件）**，用户改了不生效；
   - `/models` API（前端"模型管理"页写入 `data/model-config.json`）**只有 routes/models.ts 读写，router 从不读取**（写死端）；
   - `config/axiom.yaml` 的 `models:` 数组仅被 config-center 按索引（`models.0.apiKey`…）映射 API Key，**模型条目本身 router 不消费**。
   - 真实路由数据源是 `src/router/models/registry.ts` 的 `UNIFIED_REGISTRY`——**约 50+ 条模型全部硬编码在代码里**，用户无法配置模型与链接。

2. **业务模块绕过 router 直连**：`prompt-optimizer.ts`、`intent-enhancer.ts`、`knowledge/pipeline.ts`、`db/codegraph-sync.ts`、`memory/knowledge-graph-builder.ts`、`hermes-agent.ts`、`edge-client.ts` 等 7+ 处**硬编码模型名/provider/baseURL**，其中 `${LAN_NODE_N1}:9001` 是个人内网 IP 硬编码默认值。

3. **凭据安全总体合格**：git 跟踪文件未发现真实密钥（命中仅为测试夹具）；`.env` 已 gitignore；`data/*.json` 已 gitignore。风险点是 `routes/models.ts` 无 `AXIOM_ENCRYPTION_KEY` 时明文落盘、`POST /config` 整文件覆写 YAML 的既有问题。

---

## 一、硬编码清单（文件:行号 / 类型 / 建议）

### A. 配置断链（P0，用户配置无法生效）

| 位置 | 类型 | 现状 | 建议 |
|---|---|---|---|
| `config/model-router.yaml`（全文件） | 死配置 | 全仓库无任何 `model-router.yaml` 引用 | 要么接入 router 作为用户路由模板，要么删除并在 README 说明真实配置入口 |
| `src/routes/models.ts:8` `CONFIG_PATH = "./data/model-config.json"` | 死数据 | `/models` GET/POST/DELETE 读写该文件，但 `src/router/**` 从不读取 | P0：在 model-capability-registry 启动时加载该文件 → `registerModel()` 注入 EXTENSIONS；或直接废弃此通道统一走新模板 |
| `src/core/config-center.ts:72-77` | 索引脆弱 | `yamlPath: "models.0.apiKey"…"models.5.apiKey"` 按数组下标映射，插入/删除模型即错位 | 改为按 provider id 的稳定键（如 `models.<provider>.apiKey`）或弃用 YAML models 数组 |
| `config/axiom.yaml:15-78` `models:` 数组 | 半死配置 | router 不消费这些模型条目；仅 apiKey 被 config-center 按索引读 | 统一到单一模型配置源（见模板化建议） |

### B. 硬编码模型名 / provider（src 层绕过配置，P0/P1）

| 位置 | 硬编码内容 | 类型 | 建议 |
|---|---|---|---|
| `src/agents/prompt-optimizer.ts:44-46` | `GLM_CHAIN`: `zhipu/glm-4.7-flash` + `siliconflow/THUDM/GLM-4-9B-0414` | 模型名+provider | P0：改读 env `PROMPT_REWRITE_MODEL`/`PROMPT_REWRITE_FALLBACK_MODEL`（无默认或默认走 router role），回退逻辑不变 |
| `src/agents/intent-enhancer.ts:43-44` | `GLM_FLASH_MODEL = "glm-4.7-flash"`, `GLM_FLASH_PROVIDER = "zhipu"` | 模型名+provider | P0：改读 `INTENT_ENHANCE_MODEL`/`INTENT_ENHANCE_PROVIDER`，缺省时回退 intent-router 原逻辑 |
| `src/knowledge/pipeline.ts:12,54` | `ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"` + `model: "glm-4-flash"` | baseURL+模型名 | P0：改走 `getEffectiveBaseURL/getEffectiveApiKey`（api-key-store），模型读 `KNOWLEDGE_STRUCTURE_MODEL`（默认 `glm-4-flash`） |
| `src/db/codegraph-sync.ts:319-329` | `https://api.siliconflow.cn/v1/embeddings` + `BAAI/bge-m3` | baseURL+模型名 | P1：复用 router embedding role 或 `EMBED_BASE_URL/EMBED_MODEL` |
| `src/memory/knowledge-graph-builder.ts:418-425` | 同上 | baseURL+模型名 | P1：同上，两处应合并为共享 embedding 客户端 |
| `src/agents/hermes-agent.ts:233,268,273` | `THUDM/GLM-5.1`（代码审查） | 模型名 | P1：改读 `CODE_REVIEW_MODEL`，缺省走 router `code-review` role |
| `src/agents/kimi-code-agent.ts:32-33` | `KIMI_CODE_MODEL = "kimi-for-coding"`、`KIMI_CODE_BASE_URL`（后者已有 env 覆盖） | 模型名+baseURL | P1：`KIMI_CODE_MODEL` 加 env 覆盖 `KIMI_CODE_MODEL`；baseURL 已可覆盖（合格） |
| `src/dre/config.ts:58` | `cloudModel: "deepseek-chat"`、`cloudBaseUrl: "https://api.deepseek.com"` | 默认值 | 可接受（env 可覆盖）；建议文档提示 |
| `src/agents/opencode-tools/types.ts:6-9`、`src/agents/opencode-agent.ts:28-31` | `OPENCODE_FREE_MODELS` 硬编码列表 | 模型名 | P1：已有 `OPENCODE_DEFAULT_MODEL` env；列表改为可从 env/配置扩展而非纯常量 |

### C. 硬编码内网 IP / 端点（P0/P1）

| 位置 | 硬编码 | 类型 | 建议 |
|---|---|---|---|
| `src/local-llm/edge-client.ts:26` | 默认 `http://${LAN_NODE_N1}:9001`（个人内网 IP）+ `MiniCPM5-1B` | IP+模型 | **P0**：`EDGE_LLM_URL` 无默认或默认 `http://127.0.0.1:9001`；这是别人环境必然失效的地址 |
| `src/local-llm/edge-embeddings.ts:14-15` | `http://${LAN_NODE_N1}:9001` + `BAAI/bge-m3` | IP+模型 | P0：同上 |
| `src/testing/cluster/types.ts:190-203` | `${LAN_NODE_N1}` / `192.168.0.21` | IP | P1：测试集群样本，改从 env/argv 读取 |
| `src/crawl/lightpanda-client.ts:86,217,…`、`src/routes/agents.ts:226…`、`src/tui/app.ts:500` | `http://127.0.0.1:9222` | 本地 CDP 端点 | P2：本机回环可接受；如需远程改为 `LIGHTPANDA_CDP_URL` env |
| `src/core/health-checker.ts:103-105`、`src/cron/scheduler.ts:21-24`、`src/cli.ts:278-282`、`src/router/model-advisor.ts:97-130`、`src/utils/adaptive-proxy.ts:59-61` | provider `/models` 探测 URL 硬编码 | baseURL | P1：统一改走 `PROVIDER_CONFIG`（router/models/providers.ts）+ env baseURL 覆盖 |
| `src/agents/computer-use-agent.ts:392` | `HTTP-Referer: https://axiom-runtime.ai` | 域名 | P2：改 env `OPENROUTER_REFERER`（OpenRouter 要求，默认保留） |

### D. 双份 Provider 配置漂移（P0 设计问题）

| 位置 | 说明 | 建议 |
|---|---|---|
| `src/router/models/providers.ts`（11 个 provider） vs `src/utils/api-key-store.ts:70-130`（另一份 PROVIDER_CONFIG，含国内/海外变体） | **两份独立 provider 表**，字段集不同（后者有 adapter/region/displayName），增删 provider 需同步两处，已出现不一致（router 表无 deepseek-overseas 等变体） | P0：以 api-key-store 为唯一 provider 事实源，router 的 PROVIDER_CONFIG 改为从它派生/读取 |

### E. 前端硬编码（P1）

| 位置 | 内容 | 建议 |
|---|---|---|
| `frontend/src/components/settings/models-section.tsx:21-25,37` | provider 下拉硬编码 `siliconflow/openrouter/deepseek` | 改从后端 `/providers`（routes/models.ts `handleListProviders`）拉取 |
| `frontend/src/components/provider-sections.tsx:78-91` | provider 控制台 URL 硬编码（展示用） | P2 可接受；如要完全动态则后端下发 |
| 前端模型管理 → `POST /models` | 写入 router 不读的 `data/model-config.json` | 随 A 项一并修复，否则 UI 是假功能 |

### F. skills / scripts（P2，低危）

- `scripts/discover-free-models.ts:19-30,135-157`：baseURL 与免费模型列表硬编码（脚本工具，可接受；建议 env 化 baseURL）
- `scripts/dre-e2e-test.ts:11-22`：测试脚本硬编码（可接受）
- `skills/` 下无 API key/baseURL 硬编码（扫描未命中）


---

## 二、现有配置机制盘点（已具备的良好基础）

| 机制 | 位置 | 现状评估 |
|---|---|---|
| 类型化 env 读取 + 校验 | `src/utils/env.ts`（`readString/readInt/readBool` + `REQUIRED_ENV_VARS` + `validateEnv`） | ✅ 优秀，全局唯一入口 |
| 运行时 API Key 覆盖（内存 + SQLite 持久化） | `src/utils/api-key-store.ts` + `api-key-persistence.ts` | ✅ 优秀，支持 `{provider, apiKey, baseURL}`，前端 `/api-keys` 可写可测 |
| 统一配置中心（ENV > YAML > Default） | `src/core/config-center.ts` | ✅ 设计良好，但 yamlPath 按数组索引脆弱（见 A） |
| 模型能力注册表扩展点 | `src/router/model-capability-registry.ts` `EXTENSIONS` + `registerModel()` | ✅ 有正确接缝，但**只被 dynamic-model-assigner 内部调用，无外部配置加载器** |
| 安装向导 | `src/cli/setup.ts`（写 .env，内置 12+ provider baseUrl 模板） | ✅ 良好，baseUrl 模板即"官方默认链接"来源 |
| 密钥加密落盘 | `src/utils/api-key-persistence.ts`（`encryptSecret/decryptSecret`） | ✅ 已用于 routes/models.ts |
| 环境变量模板 | `.env.example` / `.env.production.example` | ✅ 完整；`DEEPSEEK_BASE_URL` 等 baseURL 变量已示范 |
| 前端 Provider Key 设置 | `frontend/src/components/provider-sections.tsx`（写 `/api-keys`，可自定义 baseURL） | ✅ 良好，是"用户配置 key + 链接"的现成入口 |

**结论**：无需新基础设施。缺的不是配置能力，而是**把 router 的实际数据源接到这些配置上**。

---

## 三、模板化设计建议（统一「用户自配置」模型模板）

### 设计原则
- **简单主基调**：不引入新基础设施（不建新 DB/服务），全部基于现有 `env.ts + api-key-store + registerModel`。
- **向后兼容**：`UNIFIED_REGISTRY` 作为内置默认目录保留；用户配置优先级高于内置。
- **单一事实源**：provider 的 key/baseURL 以 `api-key-store` 为准；模型的角色/优先级由用户配置叠加。

### 推荐结构（分阶段）

#### P0 必须先做（3 项，估计 ≤2 个文件改动 + 1 个加载器）

**P0-1 让 `/models`（前端模型管理）真正生效**
- 新增深模块 `src/router/models/user-config-loader.ts`（小接口 `loadUserModels(): ModelCapability[]`，内部读 `data/model-config.json` 并解密 apiKey）。
- 在 `model-capability-registry` 首次 `getAllCapabilities()` 前（或 main.ts 启动时）调用 `loadUserModels()` → 逐个 `registerModel()`（复用现有 EXTENSIONS 接缝）。
- 用户在前端"模型管理"添加的模型即刻可被 router 使用；apiKey 走现有 `encryptSecret`，无密钥时告警（现状已具备）。

**P0-2 消除死配置 `config/model-router.yaml`**
- 二选一（建议前者）：
  a. 让 `user-config-loader` 同时解析 `config/model-router.yaml` 的 `decision/architecture/code-generation/...` 各 role 列表，转换成 `ModelCapability` 注入（文件即"角色→模型"模板，天然匹配 registry 的 roles 概念）；
  b. 若短期不做，在 README 与文件头标注"已废弃，请用前端模型管理"，防止用户误改。
- 注意：model-router.yaml 的 `provider` 值需与 `api-key-store` 的 provider 表对齐（如 `zhipu`、`siliconflow`）。

**P0-3 收敛双份 PROVIDER_CONFIG**
- 以 `api-key-store.ts` 的 `PROVIDER_CONFIG`（含 adapter/region/displayName）为唯一事实源；
- `src/router/models/providers.ts` 改为从它派生（或反向引用），消除漂移；所有 `getEffectiveBaseURL` 调用统一。

**P0-4 拔掉 src 层 7 处业务直连的硬编码模型**
- 统一规则：**业务模块一律不指定模型/provider**，通过 `router.executeWithRole(role)` 分配；必须显式指定时读取 `XXX_MODEL`/`XXX_BASE_URL` env，且默认值允许为空（空则走 router role）。
- 首批：`prompt-optimizer.ts`（role: general-tool）、`intent-enhancer.ts`（role: decision）、`knowledge/pipeline.ts`（role: knowledge）、`edge-client.ts`/`edge-embeddings.ts`（`EDGE_LLM_URL` 默认改为 `http://127.0.0.1:9001` 或空）。

#### P1 建议（1-2 个迭代内）

- **P1-1** `db/codegraph-sync.ts` + `memory/knowledge-graph-builder.ts` 合并为共享 embedding 客户端（`src/utils/embedding.ts`），配置 `EMBEDDING_BASE_URL/EMBEDDING_MODEL`，默认走 router `embedding` role。
- **P1-2** `health-checker.ts`/`cron/scheduler.ts`/`cli.ts`/`model-advisor.ts` 的探测 URL 改为从 `api-key-store` 的 `getEffectiveBaseURL()` 派生，删除硬编码列表。
- **P1-3** `hermes-agent.ts` 代码审查模型改 `CODE_REVIEW_MODEL` env（默认走 router code-review role）。
- **P1-4** 前端 `models-section.tsx` provider 下拉改从 `GET /providers` 拉取。
- **P1-5** `.env.example` 补充新变量命名规范（见下）并注释"留空则走默认角色路由"。

#### P2 可选

- **P2-1** `opencode-tools`/`opencode-agent` 的 FREE_MODELS 列表支持 env 追加（如 `OPENCODE_EXTRA_MODELS` JSON）。
- **P2-2** `computer-use-agent` 的 OpenRouter Referer 改 env。
- **P2-3** 前端"模型管理"支持直接编辑 `config/model-router.yaml` 的角色优先级（若 P0-2 选 a，则天然支持）。

### 变量命名规范（统一模板）

```
# ── 通用约定：模型链接 ──
<PROVIDER>_BASE_URL   # 用户自配置 baseURL（已存在：DEEPSEEK_BASE_URL、MINIMAX_BASE_URL、KIMI_CODE_BASE_URL…）
# 缺失时回退 PROVIDER_CONFIG 内置默认（即 cli/setup.ts 的官方链接模板）

# ── 通用约定：模型名 ──
<MODULE>_MODEL        # 业务模块显式指定时：PROMPT_REWRITE_MODEL / INTENT_ENHANCE_MODEL /
                      # KNOWLEDGE_STRUCTURE_MODEL / CODE_REVIEW_MODEL / EDGE_LLM_MODEL …
# 缺失时走 router 按 role 自动分配（推荐，用户只需配 role 优先级）

# ── 推荐优先级链 ──
# 1) 前端设置页 /api-keys（运行时覆盖，SQLite 持久化）── key + baseURL
# 2) .env（<PROVIDER>_API_KEY / <PROVIDER>_BASE_URL）
# 3) config/axiom.yaml / model-router.yaml（角色→模型模板，P0-2 接入）
# 4) UNIFIED_REGISTRY 内置目录（最后兜底，保证开箱可用）
```

---

## 四、凭据安全风险结论

1. **git 跟踪文件未发现真实密钥**：`sk-*`/`AKIA*` 命中仅存在于 `tests/logger-redact.test.ts`（测试脱敏夹具）与 `tests/coverage-gap/rate-limiter.test.ts`（测试夹具），符合规则 11。
2. `.env` 已 gitignore，git 仅跟踪 `.env.example`/`.env.production.example`；本地 `.env` 存在 `ZHIPU_API_KEY`/`AXIOM_AUTH_TOKEN`/`AXIOM_ENCRYPTION_KEY`（本次审核不回显值）。
3. `data/*.json` 已 gitignore → `data/model-config.json` 不会进仓库，✅。
4. **风险点（需修复/确认）**：
   - `src/routes/models.ts:76-78`：`AXIOM_ENCRYPTION_KEY` 未配置时 apiKey **明文落盘** `data/model-config.json`（已有告警，但建议启动时强制校验该密钥或默认拒绝明文落盘）；
   - `src/routes/health.ts:214-231`：`POST /config` 整文件覆写 `config/axiom.yaml`（此前审计已标记：需鉴权 + sensitive 字段清洗）；`GET /config` 已做字段剥离（gateway.auth/obsidianApiToken/serpapiKey），✅。
   - `config/axiom.yaml` 使用 `${VAR}` 占位符注入（`resolveEnvVars`），若用户误将真实 key 直接写进 YAML 会进 git —— 建议安装向导/文档强调 key 只放 .env 或运行时覆盖。
5. **总评**：凭据本地化执行合格；修复点集中在"明文落盘护栏"与"YAML 覆写鉴权"两项工程防护，而非现有泄漏。

---

## 五、审核方法与证据链

- 扫描方式：PowerShell `Select-String` 对 `src/`、`frontend/src`、`scripts/`、`config/` 全量正则扫描（模型名 / https 端点 / IP / 密钥模式），并交叉核对 git ls-files 与 .gitignore。
- 关键代码路径已通读：`router/models/{registry,providers}.ts`、`router/model-capability-registry.ts`、`router/provider-caller.ts`、`utils/{env,api-key-store,api-key-persistence}.ts`、`core/config-center.ts`、`routes/{models,api-keys,health}.ts`、`cli/setup.ts`、7 处业务直连模块、`local-llm/*`。
- 事实标注：`config/model-router.yaml` 无引用、`data/model-config.json` 无 router 读取、双份 PROVIDER_CONFIG、`${LAN_NODE_N1}` 内网 IP 均为**事实**（代码扫描可复现）。
