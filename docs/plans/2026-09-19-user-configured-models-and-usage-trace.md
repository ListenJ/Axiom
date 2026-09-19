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

### 1.8 专项审计：「api-key-store 是唯一事实源」这一自称是否成立

**被审主张**（`src/router/models/providers.ts:1-6` 原文）：
> "Provider configurations — 兼容层（**唯一事实源**：src/utils/api-key-store.ts）… 启动时派生，**杜绝双份漂移**。"

**裁定：不一致（该表述在系统级不成立；仅在 router 兼容层这一对关系上成立）。**

**支持"部分成立"的证据**：
- `providers.ts:11-38` 经 `getProviderConfig()` 从 api-key-store 派生，且 `getProviderConfig` 缺失时**抛错**（`:33-35`）。
- 存在守护测试 `tests/utils/provider-config-convergence.test.ts:24-31`：遍历 `PROVIDER_CONFIG`，断言每项在 api-key-store 中存在且 `baseURL`/`apiKeyEnv` **逐字段相等**。

**证伪"唯一/杜绝漂移"的证据（实测计数）**：
- `"*_API_KEY"` 字面量在 `src/` 内的分布：`api-key-store.ts` **17** 处；其**之外**约 **90** 处，其中
  `src/cli.ts` 19、`src/cli/setup.ts` 16、`src/core/config-center.ts` 8、`src/router/model-advisor.ts` 7、
  `src/utils/env.ts` 6、`src/main.ts` 6、`src/routes/models.ts` 5、`src/memory/bootstrap.ts` 4、`src/cron/scheduler.ts` 4 等。
- provider `baseURL` 在 api-key-store 之外的硬编码：`src/cli/setup.ts` 7、`src/router/model-advisor.ts` 5、
  `src/routes/models.ts` 3、`src/cron/scheduler.ts` 3、`src/cli.ts` 3、`src/main.ts` 2、`src/core/health-checker.ts` 2 等。
- **另有一张字段更多的独立 provider 表**：`src/router/model-advisor.ts:110-120` 持有
  `{ name, baseURL, apiKeyEnv, models[], pricing }` —— 其中 `models[]`/`pricing` **是 api-key-store 没有的字段**，
  故它是"更富"的第二事实源，而非子集。

**守护测试的覆盖缺口（两条，均实测）**：
1. **单向**：`provider-config-convergence.test.ts:25` 只遍历 `PROVIDER_CONFIG`，**未**断言反向
   （api-key-store 有、router 漏）；新增 api-key-store provider 而漏加 router 名单时**不会失败**。
2. **穷尽性无机制**：`ALL_MODEL_PROVIDERS` 原为 `: ModelProvider[]` 注解 —— 该注解把元素类型**拓宽**为
   `ModelProvider`，任何 `Exclude<ModelProvider, …>` 断言都会恒为 `never`（**恒真**）。
   即"与 models/types.ts 保持一致"**只是注释约定，没有任何拦截机制**。

**本次已做的修正（切片 B 的前置）**：
- `providers.ts` 头部改为**精确表述**：说明单一事实源只覆盖**传输字段**、只在 router 兼容层成立，并列出外围多表清单。
- 将"人工保持一致"升级为**编译期穷尽性断言**（`providers.ts:42-46`），且**必须**配合
  `as const satisfies readonly ModelProvider[]`（`:38`）——否则断言恒真（本人在验证中**先写出了恒真版本**，
  经可证伪探针发现并修正，详见 ops log）。
- **未做**：外围约 90 处字面量的收敛（属独立 T3，见切片 B 前置）。

---

### 1.9 施工前状态确认（2026-09-19，按 skill 协议执行）

> 依 `methodology-ascetic-breaker`（动手前先检索**项目内既有资产**）+ `verification-before-completion`（论证前先取**新鲜可执行证据**）执行。
> 结论：**方案 C 的实现路径被显著修正 —— 不应新建 trace 存储，而应复用已生产接线的采集管线。**

**(1) 四个子系统的真实状态**

| 要素 | 既有实现 | 粒度 | 是否持久 | 缺口 |
|---|---|---|---|---|
| 轨迹步骤 | `src/utils/agent-trace.ts`（内存 Map） | **step 级** | ❌ 完成即删 | 无持久化 |
| 任务轨迹 | `src/agent-evals/real-usage.ts`（JSONL） | **task 级** | ✅ **已生产接线** | 无 token/category |
| token 用量 | `src/router/token-tracker.ts`（SQLite） | **call 级** | ✅ | 无 taskId（本轮已补 category） |
| 上下文传播 | —— | —— | —— | **无** `AsyncLocalStorage`/`async_hooks`（全仓零命中） |

**(2) 我上一轮的一处表述需要更正（结论不得强于证据）**
我称轨迹"跑完就查不到"是"真实可用性缺口"，该措辞**不准确**。实测：这是 **B3-Medium 审计的有意修复**，且有测试锁定 ——
`tests/agent-trace-bounded.test.ts:2-7` 头部即写明"审计症状：completeTrace/failTrace 不删 activeTraces 条目 → 长进程内 trace 随任务数无界增长"。
本轮新鲜执行证据：`bun test tests/agent-trace-bounded.test.ts` → **3 pass / 0 fail**（含 `getTrace(...)` 断言为 `null`、`getAllTraces()` 增量归零）。
⇒ 准确定性：**这是"有界内存"与"可回看历史"之间的有意取舍**，不是疏漏。
⇒ **对方案 C 的硬约束：C 不得回退 B3-Medium 的修复**（内存表仍须有界），持久化只能落在**磁盘侧**。

**(3) 关键资产：`real-usage` JSONL 采集管线（可复用，勿重建）**
- `src/agent-evals/real-usage.ts:29` `REAL_USAGE_PATH` = `data/real-usage-traces.jsonl`（env 可覆盖）。
- `:96-120` `captureRealUsageTrace()` —— 批处理队列 + per-target 串行写链，避免并发交错。
- `:133-151` `loadRealUsageTraces()` —— 逐行解析、坏行告警跳过。
- **已接线生产**：`src/agent-evals/auto-evolve.ts:4` 注明"captureRealUsageTrace **已接线 chat 三处** → data/real-usage-traces.jsonl"。
- 记录形状：`RealUsageTrace extends TaskTrace`（`self-evolve/types.ts:68-73` = `{id, task, plan?, success}`）+ `{model?, latencyMs?, timestamp?, source?, feedback?}`。

**(4) ⚠️ 兼容性陷阱（若误用会导致"静默无记录"）**
`loadRealUsageTraces` 的收行条件是 **`:143` `typeof obj.id === "string" && typeof obj.task === "string"`**。
而 `AgentTrace` 的形状是 `{agentName, taskId, startTime, steps, status, result?}`，**既无 `id` 也无 `task`**
⇒ 若把 `AgentTrace` 原样写入该 JSONL，**加载时会被 `:143` 静默跳过**（只留下文件里的死行，不报错）。
**故 C 必须做形状映射**（`taskId → id`、补 `task`、`status → success`），否则功能"看起来写了、实际读不到"。

**(5) 由此确定的 C 实现路径**
1. 复用 `real-usage` 的写入/读取管线（不新建存储、不新增依赖）；
2. 为轨迹补 `id`/`task`/`success` 的**映射层**（避开 (4) 的静默丢弃）；
3. token 与轨迹的关联用**显式传参**（无 `AsyncLocalStorage` 可用）；
4. 磁盘文件需**有界**（现有 `real-usage` 是纯追加，**无上限**——这是 C 必须新增的部分，否则只是把内存泄漏换成磁盘增长）。

---

## 二、决策已确认（2026-09-19 冻结）

| # | 用户裁定 | 落地含义（施工基线） |
|---|---|---|
| **Q1** | **(a) 彻底移除** siliconflow 等免费模型 | 从 `ModelProvider` 联合、`api-key-store` 条目、`registry.ts` 10 处模型、`providers.ts` 名单、CLI、安装向导、cron、bootstrap、model-advisor、dynamic-model-assigner、reasoning-effort 等处一并移除。**必须附带迁移路径**：既有用户若在用这些 provider，升级后会无模型可用 —— 需给出显式启动告警 + 迁移指引（不得静默失效）。 |
| **Q2** | 先**审查**"自称唯一事实源"的部分，**不正确就修正它**，然后把自定义 provider 放进**同一个事实源**，**不再新建事实源** | 审查已完成（**§1.8，裁定：该表述系统级不成立**）。本次已修正表述 + 补编译期穷尽性断言；**外围约 90 处字面量的收敛**列为切片 B0（自定义 provider 的**前置**）。自定义 provider 一律写入 `src/utils/api-key-store.ts`。 |
| **Q3** | **显式分类字段** | `TokenUsageRecord` 新增显式 `category` 字段（初值集合 `main` / `subagent` / `embedding` / `tool` / `other`），**不复用** `role`/`taskType`。 |
| **Q4** | 先看**有没有更好的 embedding 实现方式**；不行则在删除时**告知用户影响**（无法词嵌入、搜索效率降低等） | 评估见 **§2.1**（结论：没有单一更优替代，但有"分层"改进）。删除 `edge-embeddings` 时必须输出**影响披露文案**；⚠️ 文案须**区分"召回质量下降"与"响应延迟"**，不得笼统说"效率降低"（见 §2.1 末）。 |

### 2.1 Q4 专项：有没有更好的 embedding 实现方式

**结论：没有"更优的单一替代"。** 逐个评估如下（均为工程判断，标注依据强度）：

| 方案 | 是否确定性 | 成本 | 召回能力 | 判定 |
|---|---|---|---|---|
| BM25/词法（**已在用**） | 是 | 零 | 同义不同词/跨语言 **零命中** | 保留为基线 |
| **确定性同义词/术语扩展**（词典增强查询） | 是 | 零模型零网络；需维护词典 | 覆盖**词表内**的同义/缩写/中英对照 | **建议新增**：性价比最高的一步 |
| 字符 n-gram / 编辑距离模糊匹配 | 是 | 低 | 只解错别字，**不解语义** | 可选，非语义方案 |
| 本地 ONNX 小模型（如 bge-small） | 是（固定权重） | 需引入运行时依赖 + 下载模型（数十~数百 MB） | 接近远程 embedding | **不建议**：与"不新增重型依赖"及已砍本地推理子系统的方向冲突 |
| 静态词向量查表（预训练词表） | 是 | 需随仓库分发词表数据 | 中等，短语/领域词差 | 备选，但收益/体积比一般 |
| **用户自配 embedding 模型** | 取决于模型版本（远程可能静默升级） | 按用户所配模型计价 + 网络 | **最好** | 主方案（受授权门控制） |

**建议的分层策略**：`BM25（已有）` → `+ 确定性同义词扩展（新增，零模型）` → `+ 用户授权后的 embedding（补长尾）`。
这样"未授权/无模型"时仍比现状好一档，而不是"要么有 embedding、要么纯关键词"。

**删除 `edge-embeddings` 后的影响文案必须精确区分两件事**（用户原话为"搜索效率会降低"，此处需更正）：
- **召回质量下降**：同义不同词、跨语言、缩写类查询会**召回为零**；这是**真实损失**，且可用切片 2 的对拍集**量化**。
- **响应延迟**：删掉 embedding 后**少了网络往返，延迟通常下降**，不是上升。
  ⇒ 因此**不得**笼统写"搜索效率降低"（会误导用户以为变慢）；应写「**语义召回能力缺失，词法召回延迟不变或略降**」。

---

## 三、执行顺序（垂直切片，2026-09-19 冻结）

> 原则：**先做不被 Q1 影响的**（用量可观测、事实源收敛），再做破坏性的移除。

**切片 A（方案 C，按 §1.9 的状态确认重定义）｜轨迹用量可观测**

> 设计基线：**复用** `real-usage` JSONL 管线；**不改回** B3-Medium 的内存有界修复；
> 关联键走**显式传参**（无 `AsyncLocalStorage` 可用）。

- **A1（已完成，c9a9266）**：`TokenUsageRecord.category` 显式分类字段 + 老库迁移 + `getStatsByCategory()`；
  TDD 红→绿 0/4 → 4/4。
- **A2｜映射层（先做，避免 §1.9(4) 的静默丢弃）**：新增 `AgentTrace → RealUsageTrace` 的映射
  （`taskId → id`、补 `task`、`status → success`），并**加一条守门用例**：映射后的记录必须能通过
  `loadRealUsageTraces():143` 的收行条件 —— 该用例是防"写了读不到"的唯一机制。
- **A3｜完成时落盘（磁盘有界）**：`completeTrace`/`failTrace` 出口处**追加**写入 JSONL（复用 `capture`）；
  同时**必须**为文件增加**保留上限**（现有 `real-usage` 为纯追加、无上限；不回退内存有界的同时，不能把泄漏搬到磁盘）。
  保留策略需与 §4 的未决项一并定（按条数/按体积/按时间）。
- **A4｜taskId 贯通到 token 记录**：`TokenUsageRecord` 增加显式 `taskId?`；由调用方**显式传入**
  （需改 `src/router/model-router.ts:164-183` 的 `meta` 形态 —— 属接口变更，改前回 Plan 报备）。
- **A5｜读取面**：`GET /traces/:id` 在轨迹已出表时，改为从 JSONL + TokenTracker 组装
  「步骤（若有）+ 按 category 的 token 用量」；`GET /traces` 暴露历史列表（受 A3 上限约束）。
- 产出：A2/A3/A4/A5 各自的红→绿用例；"已完成任务可回看其分类用量"可被端到端验证。

**切片 B0｜事实源收敛（自定义 provider 的**前置**，Q2）**
- 把外围约 90 处 `"*_API_KEY"` 字面量与 provider baseURL 逐步收敛到 `src/utils/api-key-store.ts`，
  每步按规则 2/7 做红→绿；**先做只读的表驱动收敛，再做删除**。
- 产出：事实源**系统级**成立（而非仅 router 兼容层成立）；`providers.ts` 头部可去掉"仅在兼容层成立"的限定语。

**切片 B｜自定义 provider（写入同一事实源，Q2）**
- 在 `api-key-store.ts` 增加用户自定义条目：**协议（openai/anthropic/gemini/opencode）+ base_url + api key + 模型名 + 思考等级 + 上下文窗口**。
- 放开 `src/routes/api-keys.ts:109` 的 `isKnownProvider` 限制（改为受校验的"已知 ∪ 用户自定义"）。
- 产出：用户可自行添加模型端点，且**不产生第二个事实源**。

**切片 C｜按 Q1=(a) 移除 siliconflow 等免费模型**
- 移除范围：`ModelProvider` 联合、api-key-store 条目、`registry.ts` 10 处模型、`providers.ts` 名单、
  `cli.ts`/`cli/setup.ts`/`main.ts`/`cron/scheduler.ts`/`memory/bootstrap.ts`/`model-advisor.ts`/
  `dynamic-model-assigner.ts`/`reasoning-effort.ts`/`db/codegraph-sync.ts`/`tui/install-wizard.ts`/`models/types.ts`。
- **必须**附迁移路径：启动时若检测到配置里仍引用被移除的 provider → 输出**显式告警**与迁移指引，**不得静默失效**。
- 产出：全量测试绿；迁移告警有测试覆盖。

**切片 D｜删除 `127.0.0.1:9001`（Q4）**
- 按规则 4：归档 `src/local-llm/edge-embeddings.ts` → `archive/`，登记 `archive/ARCHIVE-LOG.md`，再 `git rm`。
- `src/core/settings-search.ts:12` 的语义腿：按 §2.1 的分层策略处置（先退化为词法；同义词扩展层见切片 F）。
- **必须**输出 §2.1 末的影响披露文案（区分召回质量 vs 延迟）。
- 同步 `tests/settings-search.test.ts`、`src/utils/proxy-fetch.ts:57` 注释与相关文档。

**切片 E｜文档口径收敛**
- 与 `docs/plans/2026-09-19-knowledge-semantic-layer.md` 切片 1 合并执行，避免两轮文档漂移。

**切片 F｜确定性同义词/术语扩展层（§2.1 建议，可选）**
- 在 BM25 与 embedding 之间补一层零模型的词典扩展，使"未授权 embedding"状态下仍优于纯词法。
- 是否纳入取决于你对 §2.1 的采纳意见。

---

## 四、未验证 / 未覆盖（如实登记）

1. 本文行号与计数为 2026-09-19 实测；施工前须按规则 2 重新核对。
2. §1.3 与 §1.8 的命中清单为 `grep` 结果，**未逐条判定**"必须改 / 可保留 / 仅注释"；切片 B0 与 C 开工前须逐条分类。
3. **`TokenTracker` 与 `agent-trace` 之间是否已有可复用的关联键（如 requestId）未核验** —— 这是切片 A 的第一件事；若无关联键，须先设计（属接口变更，须回 Plan）。
4. "思考等级"在 `reasoning-effort.ts` 的取值域、"上下文窗口"的可配置形式（下拉/自由输入/校验）**未勘察**。
5. **移除 siliconflow 对既有用户的影响面与迁移路径未评估** —— 这是 Q1=(a) 的**强制前置**，未完成前不得开工切片 C。
6. 用户 `.env` 中该 key 是否已清除**未核验**（未读取其内容，规则 11）。
7. §2.1 的词典扩展方案**仅为本人的工程判断**，未做召回率实测；若采纳，收益须以切片 2 的对拍集量化后才能对外表述。
8. 切片 B0 的工作量**未估算到行级**（"约 90 处"为字面量命中数，不等于需改行数）。
