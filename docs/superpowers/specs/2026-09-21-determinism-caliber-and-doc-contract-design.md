# 确定性推理口径与文档↔代码一致性门（S1+S2）

> 日期：2026-09-21 ｜ 状态：待评审
> 范围：文档口径改写（S1）+ 文档↔代码交叉验证机器门（S2）+ 使口径为真的最小代码收敛（C 部分）
> 不范围：提权阻断模型（见 `2026-09-21-privilege-escalation-defense-design.md`，S3）

---

## 0. 问题陈述（全部为已核实事实）

### 0.1 绝对化断言只存在于派生件，权威件本身没有

| 文件:行 | 逐字 |
|---|---|
| `docs/ARCHITECTURE.md:10` | `Axiom 是一个确定性 AI Agent 框架，核心设计理念是**零向量、零概率、零 embedding**。所有检索、推理、记忆操作均基于确定性算法（关键词匹配、规则引擎、确定性图遍历），不使用任何 ML 模型进行搜索或聚类。` |
| `docs/ARCHITECTURE.md:94` | `` \| `deterministic-search.ts` \| 603 \| 零向量全文搜索 (关键词 + PARA + 标签) \| `` |
| `docs/PROJECT-GUIDE.md:27` | 同 `ARCHITECTURE.md:10` 句式 + `LLM 在此框架中从"推理主体"降级为 Cognitive Accelerator` |
| `docs/PROJECT-GUIDE.md:155` | `` \| `deterministic-search.ts` \| ~603 \| 零向量全文搜索 \| `` |
| `docs/BROWSER-AGENT-STRATEGY-2026-08-09.md:57` | `` \| 记忆 \| FTS5 + LLM 摘要 + Honcho \| 零向量 Vault + SQLite FTS5 + KG + DRE \| `` |

`docs/AXIOM-ARCHITECTURE.md` §〇 设计哲学（`PHILOSOPHY.md` 转发落点）**不含**任何"零 X"断言，其既有口径是 ADR-002「LLM 仅作为确定性管道的补全器，不作为推理主体」+「Deterministic Cognitive Pipeline」。
→ 结论（事实）：需要重建的不是理念，而是**派生件对理念的失真复述**。权威件 §〇 是新口径的唯一落点。

### 0.2 结构根因：三份互斥"唯一权威"

| 文件:行 | 自称 |
|---|---|
| `docs/ARCHITECTURE.md:4` | 本文件是 Axiom 项目的唯一架构权威参考 |
| `docs/AXIOM-ARCHITECTURE.md:3` | 唯一权威参考 — 覆盖全系统所有模块 |
| `docs/PROJECT-GUIDE.md:3` | 本文档是 Axiom 项目的唯一权威入门与参考文档 |

另 4 份 stub 转发件（`PHILOSOPHY.md` / `DRE-ARCHITECTURE.md` / `MCP_TOOLS_GUIDE.md` / `architecture-evolution.md` / `ROADMAP.md`）把 `AXIOM-ARCHITECTURE.md` 复述为"全系统唯一权威架构文档"。
`docs/ARCHITECTURE-REVIEW-2026-08-06.md:24,:65` 在 3 周前已记录"三份唯一权威互斥 / 版本六套口径 / README 头部指标整体失真"，至今未修。
→ 判断：文档失真是**结构问题**（多源复制），不是笔误。只改 5 行措辞会在下一个复制点重新长出来。

### 0.3 手抄数字必然漂移（实测）

`docs/ARCHITECTURE.md` 表格中 26 行"组件 \| 行数 \| 职责"为手抄，与 `wc -l` 实测差值分布：

| 组件 | 声明 | 实际 | 偏差 |
|---|---|---|---|
| `knowledge/engine.ts`（DRE 主控） | 732 | 216 | 70% |
| `mcp/tool-pool.ts` | 240 | 361 | 50% |
| `memory/distiller.ts` | 168 | 269 | 60% |
| `router/model-router.ts` | 728 | 961 | 32% |
| `memory/vault-manager.ts` | 640 | 763 | 19% |

同类手抄：`PROJECT-GUIDE.md` 15 行、`COMPREHENSIVE-GUIDE.md` 12 行；`DEVELOPER-ONBOARDING.md:224` 写 `AXIOM-ARCHITECTURE.md (1388 行)`，实为 1544 行。
→ 结论：**任何写进散文的定量指标都会过期**。门不校验手抄数字，门禁止手抄数字。

### 0.4 口径为假的实质证据（模块 7 审计结论，S2 门的被测对象）

非确定组件确实存在于**决策路径**上（不是生成路径），且默认开启：

| 编号 | 位置 | 事实 |
|---|---|---|
| P7-1 | `src/local-llm/edge-embeddings.ts:19` | `readString("EDGE_SETTINGS_SEARCH", "1")` → 设置项搜索远端 embedding + cosine 默认开，HTTP 可达 |
| P7-2 | `src/knowledge/collector.ts:86-89` | 边缘 LLM 判质量后 `quality = qualityThreshold` → 推翻确定性门限 |
| P7-3 | `src/knowledge/edge-assist.ts:142` + `collector.ts:99` | `isNearDuplicateWithEdge` 决定是否丢弃样本 |
| P7-4 | `src/services/knowledge.ts:88-97` | `rewriteKnowledgeQueryWithEdge` 线上替换 `effectiveQuery`，改变检索决策输入 |
| P7-5 | `src/knowledge/quality-assessor.ts:32-36,:74-75` | 共形 p 值占 `accuracy` 权重 0.4 |
| P7-6 | `src/local-llm/edge-client.ts:43-46` | `isEdgeEnabled()` 未设置即返回 `true`（4 个 EDGE_* 全默认开） |

聚类侧**未被违反**（`src/kg/enhanced.ts:467-541` 确定性标签传播；`semantic` 向量列恒 NULL，属死特性）。

---

## 1. 新能力口径（写入 `AXIOM-ARCHITECTURE.md §〇`，其余文档只复述指针）

### 1.1 双域模型

- **确定性内核域（Deterministic Core）** — 承担**决策**：检索命中与排序、记忆读写路由、准入与去重、query 归一化、图遍历、约束求解、规则推理。不变式：同输入 + 同版本规则 ⇒ 同输出，可解释、可审计、可回放。
- **显式概率域（Declared Probabilistic Layer）** — 承担**生成与建议**：LLM 摘要/结构化补全、Thompson 模型路由、共形置信度信号、边缘模型判断。允许存在，不承担决策权。

### 1.2 三条契约（每条可机器判定，见 §3）

1. **独立开关**：每条非确定路径必须有一个专属 env 开关（`EDGE_*` / `AXIOM_*`）。
2. **默认值进门**：开关名 + 默认值 + 角色（`decision` / `advisory` / `generation`）登记在 `config/nondeterminism.json`；`role: decision` 的条目数必须为 0（§4 收敛后）。代码里的 `readString(SWITCH, "D")` 默认值必须与登记表一致。
3. **输出处处留痕**：非确定路径产出的结果必须携带 provenance（`mode` / `engine` / `advisory`），使响应可判定"这一条走了概率层"。

### 1.3 措辞禁令（机器扫描，D1）

禁用：`零向量`、`零概率`、`零 embedding`、`零成本`、`不使用任何 ML`、`不使用任何模型`、`100% 确定`、`永不`（安全断言上下文）。
允许并采用如下规范陈述（逐字模板）：

> Axiom 是**确定性认知运行时**：**所有决策路径由确定性算法承担**（FTS5 关键词检索、规则引擎、约束求解、确定性图遍历），可解释、可审计、可回放。系统包含显式声明的**概率层**（LLM 生成、模型路由、共形信号、边缘模型建议），每条具备独立开关、默认值登记在 `config/nondeterminism.json`、输出带 provenance，且**不承担决策权**。

### 1.4 口径为真的前置条件

上述 §1.3 的规范陈述在 §4 的代码收敛落地前为假。因此 S1 的文档改写与 S2 的门必须**同一次提交**落地，且 D5/D6 门负责在 CI 里持续证明它。

---

## 2. 文档结构收敛（S1）

| 文件 | 新定位 | 动作 |
|---|---|---|
| `AXIOM-ARCHITECTURE.md` | **唯一权威**（保留自称，全仓唯一） | §〇 增补「能力口径（双域 + 三契约 + 禁令）」小节；文首声明"定量指标一律不写行数，改由 `test:arch` 校验" |
| `ARCHITECTURE.md` | 分层规则与质量红线**派生件** | 删 `:4` 自称 → 改为"本文从属于 AXIOM-ARCHITECTURE.md §〇，只承载分层与质量红线"；`:10` 换 §1.3 模板；`:94` 及全部表格删「行数」列；修章节断裂（`## 7. 演进记录` → `## 10. 分布式知识网络` 重排为 8/9）；`:282-290` 内网 IP 表按规则 11 收敛为占位符 |
| `PROJECT-GUIDE.md` | 入门导览**派生件** | 删 `:3` 自称；`:27` 换 §1.3 模板；`:155` 及表格删「行数」列；`:29-42` 关键指标只保留机器门已校验项并注明校验用例名 |
| `COMPREHENSIVE-GUIDE.md` | 细节手册 | 删 12 处手抄行数 |
| `DEVELOPER-ONBOARDING.md` | 上手指南 | `:224` 去掉 `(1388 行)` |
| `BROWSER-AGENT-STRATEGY-2026-08-09.md` | 归档策略件 | `:57` 表格内 `零向量 Vault` → `确定性 Vault（FTS5+KG+DRE）` |
| `PHILOSOPHY.md` 等 5 个 stub | 转发件 | 保留（已是正确的单源指针） |

过期评审/审计报告（`ARCHITECTURE-REVIEW*.md`、`VISUAL-REVIEW-*.md`、`FRONTEND-REVIEW-*.md`、`AUDIT-2026-08-08.md`）**保留在原地不归档**：它们是带日期的历史结论，删除会丢掉"问题早已知情"的审计链。

判断（规则 10 异议）：用户要求"重新整理文档"若理解为合并成一份巨型文档，会制造 1,500+ 行的新单点复制源。本设计选择**一权威 + 若干职责单一派生件 + 机器门**，把"整理"落在**去重与可判定**上，而非物理合并。

---

## 3. 机器门（S2）：`tests/doc-contract.test.ts`

与 `tests/architecture-integrity.test.ts`（22 项，实测可跑）同族，挂进 `test:arch` 与 `test:full`，CI 必过。只依赖 `fs`/`path`/`bun:test`，不引第三方解析器。

| 规则 | 命题 | 实现 | 失败时含义 |
|---|---|---|---|
| **D1 禁语** | `docs/**/*.md` + `README.md` 中禁用短语命中数 = 0 | 正则表扫描，命中报 `文件:行` | 绝对化断言回流 |
| **D2 权威唯一** | "自称式唯一权威"命中 ≤ 1 且落在 `AXIOM-ARCHITECTURE.md` | 命中行含「已合并到/已迁移到/全系统唯一权威架构文档 §」判为转发，不计 | 多源复制重新出现 |
| **D3 死引用** | 文档点名的 `` `src/**` `` 文件 100% 存在 | 提取反引号路径 + `fs.existsSync` | 文档描述不存在的代码 |
| **D4 禁手抄行数** | `` | `x.ts` \| 123 \| `` 形态行数行 = 0（阈值型 `≤ N` 豁免） | 必然漂移的定量指标 |
| **D5 契约一致** | `config/nondeterminism.json` 每条：`sourceFile` 存在、`switch` 字符串出现在该文件、`default` 与代码 `readString(SWITCH, "D")` 字面量一致 | 逐条正则核 | 开关改名/默认值偷改 |
| **D6 无未登记的决策型非确定路径** | 决策型符号（`cosineSimilarity`、`pValue`、`isNearDuplicateWithEdge`、`rewriteKnowledgeQueryWithEdge`、`judgeKnowledgeQualityWithEdge`、`Thompson`）所在文件必须登记且 `role != decision` | 反向 grep 全 `src/` | 新增 ML 决策静默绕过口径 |
| **D7 决策位为 0** | 登记表内 `role == "decision"` 的条目数 = 0 | JSON 计数 | §4 收敛被回退 |

诚实边界（写进测试头注与文档）：门只覆盖**可机器判定命题**；散文性论述不受门保护，正因如此散文里不得留定量与绝对断言。

---

## 4. 使口径为真的最小代码收敛（C 部分，规则 1 限定）

每项 = 一条红测试 → 一处最小实现 → 绿（规则 7 垂直切片）。行为改动，故全部落在 `knowledge/`、`services/`、`local-llm/` 三个已涉及模块内，不顺手重构。

| 编号 | 改动 | 回归测试 |
|---|---|---|
| C-1 | `src/knowledge/collector.ts:86-89`：删除"边缘判定即置 `quality = qualityThreshold`"，改为记录 `advisory` 字段，准入由确定性打分决定；`pipeline.ts:169-181` 同理 | 构造"边缘判高分 + 确定性低分"样本 → 必须**不**入库（现红：会入库） |
| C-2 | `src/knowledge/edge-assist.ts:142` `isNearDuplicateWithEdge` → 去重决策改由确定性归一化指纹（`sha1(normalize(content))` + FTS 精确重）承担，边缘结论只写 `nearDupAdvisory`；开关默认 `"0"` | 两篇同文改写样本必须被确定性指纹丢弃；两篇边缘判"相似"的不同样本必须都保留 |
| C-3 | `src/services/knowledge.ts:88-97`：`effectiveQuery` 改由确定性归一化（去停用词/小写/并类）产生；LLM 改写仅在 `EDGE_PROMPT_REWRITE=1` 显式开启时执行并打 `provenance.mode = "edge-rewrite"`；默认关 | 默认路径下断言 `retrieveKnowledge` 收到的 query == 确定性归一化结果（现红：被 LLM 改写） |
| C-4 | `src/local-llm/edge-embeddings.ts:19` `EDGE_SETTINGS_SEARCH` 默认 `"1"` → `"0"`；关闭时走关键词兜底，响应带 `mode: "keyword"` | 未设 env 时不得发出远端 embedding 请求（现红：会发） |
| C-5 | `src/knowledge/quality-assessor.ts:32-36`：`accuracy` 权重 0.4 从 pValue 改为确定性事实重叠度；pValue 保留为 `signals.conformalPValue`（不进决策加权），头注同步 | 无 factBase 且 pValue 缺失的样本，`overall` 不再因 `sum += pValue` 归零 |
| C-6 | 新增 `config/nondeterminism.json`：登记全部 EDGE_*/Thompson/共形条目（`role` 收敛后均为 `advisory` / `generation`），D5–D7 由此生效 | 门自身 |

`src/local-llm/edge-client.ts:43-46` `isEdgeEnabled` 默认开启**不改**（`advisory`/`generation` 角色下默认开是产品能力，且改默认会造成大范围行为变更）；改为在登记表里显式固化其默认值，由 D5 锁定。判断：这是"默认开"与"不做决策"可以共存的边界，避免过度施工。

---

## 5. 备份 / 验证 / 提交（AGENTS 规则 2/3/5）

1. 每个待改文件先复制 `docs/...` → `.tmp/backups/docs/...`（含 `src/` 对应路径）。
2. 改后运行：`bun test tests/doc-contract.test.ts`、`bun test tests/architecture-integrity.test.ts`、`bun test tests/knowledge*.test.ts tests/settings-search.test.ts`、`bun run lint`（`tsc --noEmit`，若本机无 `node_modules` 则如实记录未验证）。
3. 验证通过后删除对应备份。
4. `docs/operations-log.md` 追加一条记录（含 hash 占位后回填）。
5. 提交：仅暂存本任务文件；推送目标 remote 待用户确认（见 §7）。

---

## 6. 验收标准

- [ ] D1–D7 全绿，且在还原任意一条改动后能红（人工各验一次，记录在 ops-log）。
- [ ] `grep -rn "零向量\|零概率\|零 embedding" docs README.md` = 0 命中。
- [ ] 全仓仅剩 1 处自称式"唯一权威"。
- [ ] 文档内不存在手抄 `文件 → 行数` 行。
- [ ] `config/nondeterminism.json` 覆盖 `src/` 内全部决策型非确定符号，且 `role: decision` 计数为 0。
- [ ] C-1…C-5 各自的回归测试入库并全绿。

---

## 7. 未决 / 需用户拍板

1. **推送目标**：AGENTS 规则 3 指定的 remote `internal211` 在本仓不存在（实测 `git remote -v` 只有 `gitea`/`internal` = `ssh://git@192.168.0.10:2222/...` 与 `origin` = GitHub SSH）。本设计先落本地提交，push 待确认。
2. `docs/ARCHITECTURE.md:286-290` 含三台内网机器 IP + 角色 + 硬件指纹，属规则 11 的边缘情形：本设计按"占位符 + 指向本地凭据目录"处理，若用户要保留原样请说明。

## 8. 范围外

提权阻断模型与 4 类守卫根因封堵（S3，另文）；Go/Rust/Tauri/ArkTS 侧任何改动；前端视觉件；`archive/` 归档动作（本次为改写而非删除）。
