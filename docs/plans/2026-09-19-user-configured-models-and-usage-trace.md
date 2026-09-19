# 用户自配模型（subagent / embedding）+ 用量可观测 —— T3 计划与决策请求

- **日期**：2026-09-19
- **分支**：`codex/knowledge-unify-2026-09-17`
- **级别**：**T3**（模型供给架构 + 设置面 + 可观测性 + 删除既有模块）
- **状态**：**计划草案，未施工**。按总则 0.3，T3 须「书面计划 + 用户确认关键决策」后方可动工；第二节为待确认项。
- **来源**：用户指令（2026-09-19）——去掉 siliconflow 等免费模型的使用；给这部分单独加设置，由用户选择 subagent 模型与 embedding 模型；本地只定协议，用户自填 `base_url` / `API key` / 协议，并自选思考等级与上下文；该类调用消耗的 token 要在**轨迹**中按**分类**显示；原 key 已停用；删除 `127.0.0.1:9001`。
- **与另一计划的关系**：本计划**修订** `docs/plans/2026-09-19-knowledge-semantic-layer.md` 的 **D1**（embedding 来源由"siliconflow 免费档"改为"用户自配模型"）。

---

## 一、现状测绘（实测，非推测）

### 1.1 协议适配器**已存在**（这一半不用从零做）

- `src/utils/api-key-store.ts:19,42` —— `adapter: ApiAdapter`，注释「adapter 字段标识 provider 使用的 API 协议」。
- 协议取值：`openai` / `anthropic` / `gemini` / `opencode`（`api-key-store.ts:278`）。
- `src/router/models/providers.ts:7-12` —— router 侧 `PROVIDER_CONFIG` **由 api-key-store 派生**（注释明写"唯一事实源"，杜绝双份漂移）。

⇒ "本地设置好对应的协议"**已有架构落点**，缺的是"**用户可自行新增一个 provider 条目**"。

### 1.2 但"新增自定义 provider"**当前不支持**（关键缺口）

`src/routes/api-keys.ts:94-115` 的 `POST /api-keys`：
- body 确实接受 `{ provider, apiKey, baseURL }`（`:102`）；
- **但 `:109` `if (!isKnownProvider(provider))` → 400 `Unknown provider`**（`:110-114`）。

⇒ 现有能力是"**为已知 provider 覆盖 key/baseURL**"，**不是**"用户新增任意模型端点"。需求 3 需要新增该能力。

### 1.3 siliconflow 是**深度耦合**，不是一处常量

实测命中（`src/` 内，节选）：
`src/router/models/registry.ts:201,218,375,392,460,477,494,618,671,806`（10 处模型条目）、
`src/router/models/providers.ts:12`、`src/utils/api-key-store.ts:70-72`、`src/utils/env.ts:189`、
`src/cli.ts:94,103,151,278`、`src/main.ts:379,385`、`src/cron/scheduler.ts:49`、
`src/memory/bootstrap.ts:234`、`src/router/model-advisor.ts:112,208,211`、
`src/router/dynamic-model-assigner.ts:164,176`、`src/router/reasoning-effort.ts:94`、
`src/db/codegraph-sync.ts:140`、`src/tui/install-wizard.ts:442`、`src/router/models/types.ts:7`。

⇒ "去掉 siliconflow 等免费模型"的影响面**远超知识库任务**，且**语义有歧义**（见 Q1），
在 Q1 落定前**不动**（规则 0.6：范围不清即停机请求决策）。

### 1.4 token 用量追踪**已存在**（需求 4 的地基）

`src/router/token-tracker.ts:1-45` —— 记录 `promptTokens / completionTokens / totalTokens`、
`model / provider / role / taskType / latencyMs / success / fallbackUsed / costUsd / cacheHitTokens / cacheMissTokens / cacheHit`；
存储独立 SQLite `./data/token-usage.db`；提供按模型/角色/时间范围的多维聚合。

⇒ 需求 4 **不是**"从零建计量"，而是"**补分类维度 + 打通到轨迹**"。

### 1.5 但**轨迹里没有 token 字段**（需求 4 的真实缺口）

- `src/utils/agent-trace.ts`（**72 行**）中 `grep token|Token|role|category|model` → **零命中**。
- `src/routes/traces.ts:4-16` —— `GET /traces`（最近 50 条）与 `GET /traces/:id`，数据源即 `agent-trace.js`。

⇒ 需把 `TokenTracker` 的记录**关联到 trace**，并新增**分类**维度（分类集合待 Q3 定）。

### 1.6 设置面已有落点

`src/core/settings-catalog.ts:42` `SETTINGS_CATALOG` → `src/routes/settings.ts:27` 对外暴露 `{ sections, items }`。

### 1.7 删除 `127.0.0.1:9001` 的影响面（**小且封闭**）

实测依赖方仅 3 个文件（+1 处注释）：
- `src/local-llm/edge-embeddings.ts`（模块本体，`:14` 硬编码 `http://127.0.0.1:9001`）
- `src/core/settings-search.ts:12`（唯一运行时消费者）
- `tests/settings-search.test.ts`（182 行）
- `src/utils/proxy-fetch.ts:57`（**注释**中提到该模块，非依赖）

⇒ 删除可行，但**须按规则 4 归档**，且要决定 `settings-search` 语义腿的去向（见 Q4）。

---

## 二、待确认的关键决策（阻塞施工）

| # | 决策 | 选项 | 备注 |
|---|---|---|---|
| **Q1** | "去掉 siliconflow 等免费模型"的**语义** | (a) **彻底移除** provider（含类型联合、适配器表、CLI、安装向导、cron、bootstrap、advisor、assigner、registry 10 处模型、类型）(b) **只取消"预选/默认"**，provider 保留、仅当用户自配 key 才可用 (c) 只移除**embedding 用的** `bge-embedding`，其它 siliconflow 模型不动 | (a) 是 30+ 文件的破坏性重构，且会使**现有用户**的模型路由失效；(b) 与"本地只定协议、用户自填"最贴合、影响可控；请明确选哪个 |
| **Q2** | 自定义 provider 的**落点** | (a) 扩展 `src/utils/api-key-store.ts` 支持用户新增条目（保留"单一事实源"）(b) 新建独立的用户模型配置表/存储 | 建议 (a)：`providers.ts:1-6` 已声明 api-key-store 为唯一事实源，另起一份会立刻产生第二事实源（与既有设计冲突） |
| **Q3** | 轨迹里的 token **分类口径** | 建议初值：`main` / `subagent` / `embedding` / `tool` / `other` | 需你确认集合；`TokenTracker` 现有 `role`/`taskType` 可复用其一，但语义不同，建议**新增显式分类字段**而非复用 |
| **Q4** | 删除 `edge-embeddings` 后，`settings-search` 的**语义腿**去向 | (a) 暂时**退化为纯关键词**（已是现有降级路径，行为安全），待用户配置好 embedding 后再接上 (b) **立即**改为读取用户配置的 embedding 模型 | 选 (b) 则本计划与知识库计划的切片 3/4 合并排序；(a) 可先独立交付、风险最小 |

---

## 三、切片草案（待 Q1–Q4 落定后冻结）

> 原则：**先做不会因 Q1 变化而返工的部分**（用量可观测），再做与协议/供给强耦合的部分。

1. **切片 A｜轨迹用量可观测**：`agent-trace.ts` 增加 token/分类字段；与 `TokenTracker` 打通；`GET /traces` 暴露分类用量；TDD（用一个假 tracker 断言分类聚合正确）。
2. **切片 B｜设置面：用户自配模型**：按 Q2 落点新增"自定义 provider"（protocol 选择 + base_url + api key + 模型名 + 思考等级 + 上下文窗口）；`POST /api-keys` 放开未知 provider（受校验约束）。
3. **切片 C｜模型选择权下放**：subagent 模型与 embedding 模型各由用户指定；移除对应位置的预选（按 Q1）。
4. **切片 D｜删除 `127.0.0.1:9001`**：按规则 4 归档 `edge-embeddings.ts` → `archive/`，登记 `archive/ARCHIVE-LOG.md`，随后 `git rm`；按 Q4 处置 `settings-search` 语义腿；同步测试与文档。
5. **切片 E｜口径与文档收敛**：与知识库计划切片 1 合并处理，避免两轮文档改动。

---

## 四、未验证 / 未覆盖（如实登记）

1. 本文行号与命中数为 2026-09-19 实测；施工前须按规则 2 重新核对。
2. §1.3 的命中清单为 `grep` 结果，**未逐条判定**"必须改 / 可保留 / 仅注释"；Q1 落定后须逐条分类。
3. `TokenTracker` 与 `agent-trace` 之间**是否已有隐式关联**（如共用 requestId）**未核验**；若没有，需先确定关联键。
4. "思考等级"在 `reasoning-effort.ts` 的取值域与"上下文窗口"的**可配置形式**（下拉/自由输入）**未勘察**。
5. 用户现有 `.env` 中的 siliconflow key **实际是否已被移除**未核验（`.env` 未跟踪、我未读取其内容，规则 11）。
6. 本计划**未评估**移除 siliconflow 对既有用户的影响面与迁移路径（属 Q1=(a) 的前置条件）。
