# 语义意义构建 × Runtime 系统优化 迭代计划

> 日期：2026-09-07 ｜ 分支基线：`codex/self-evolving-agent` @ 8251761 ｜ 状态：待执行
> 事实基线：`docs/audit-verification-log.md`（2026-09-07 补验收口，6/6 项含 file:line 证据）
> 合规：AGENTS.md 规则 1-11 全程适用；本计划为规划假设，时间节点非承诺，以切片验收门禁为准。

---

## 〇、前置审查意见（约束审查，规则 10.4/10.6）

| 用户原始约束 | 审查结论 | 处理方式 |
|---|---|---|
| "文本意义 100% 准确构建" | **判断：不可验证目标**；**用户 2026-09-07 已接受撤销 100% 承诺** | 拆两层：可判定层承诺 100%（结构合法/重放一致/幂等）；语义层承诺测量协议 + 分级目标。核心保证改为「长上下文/长会话不崩坏」（新增 S-A7） |
| "防止幻觉导致语义结构崩坏" | **事实：可部分兑现**。崩坏可防（fail-closed），幻觉不可归零 | 防线设计为"生成性组件默认不进主路径 + 校验失败拒绝写入 + 回退确定性检索" |
| "Runtime 整体协同又组件独立运行" | **可行，但需先有依赖事实**。本仓依赖方向从未全量审计（Phase 0 未建立） | 切片 B1 先做依赖清单与环检测，再定接口规范，避免凭感觉解耦 |
| "模型自带工具及网络搜索 100% 稳定" | **不可承诺 100%**。外部引擎（DDG/Bing/SearXNG）可用性不受本仓控制 | 改承诺：健康探针 + 降级路径全覆盖 + 成功率可观测 + 失败不挂起（已有基础，补齐缺口） |

---

## 一、事实基线（全部来自已提交的审计证据，不再重复验证）

**已成立（作为地基）**：
- Rust 检索确定性：`include_recency` 所有构造点均 `false`（local/main.rs:129,173；cloud/main.rs:202,246），gate 于 engine.rs:366。
- 工具面权威：189 工具零重复（`src/testing/tool-count.ts` + `scripts/count-tools.mjs`）。
- KG 幂等：稳定内容寻址 id + INSERT OR REPLACE/IGNORE + created_at 保留（kg/enhanced.ts:214-243,294-323；kg-writer.ts:254-266）。
- 安全底座：isPathSafe 四层（path-safety.ts:22-93）；ssrfGuard 逐跳+DNS 二次校验（proxy-fetch.ts:461-467）；web 结果进上下文前钳制（search-engines.ts:41-58）。
- 自检基础：`src/core/runtime-audit.ts`（结构化自检）、`scripts/audit/dual-probe.ts`（7 探针）、`scripts/audit/oom-probe.ts`（5 探针）。
- 测试门禁：`bun run test:full --isolate`（3640 pass 基线）；`tests/unit/docs-consistency.test.ts` 动态锁定工具数。

**已知缺陷/缺口（本计划的工作面）**：
1. `engine.rs:44` 并列分带截断的排序不确定性（量级低，未处理）。
2. `src/kg/enhanced.ts:752-761` intent 标签死代码（"similarity" 等无控制流消费）。
3. `src/dre/retrieval/{hybrid-fusion,verification-chain,knowledge-wiki,observability}` 四文件无外部消费方（唯一命中为内部互引 hybrid-fusion.ts:25）。
4. `src/dre/system-resource.ts:178-181` 显存预算缺 activation 项（仅权重+KV 两维）。
5. 两条生产向量语义路径文档口径缺口（Medium）：`/settings/search` 默认链尝试 embedding（settings-search.ts:121-176）；`context-manager.ts:251-311` cosine top-k 记忆检索。
6. 网络搜索无主动 per-engine 限流（以总预算替代，Info 级）。
7. 语义输出无统一 schema 与多级校验流水线（目标 A 的主空白）。
8. Phase 0 全量文件清单未建立（整体审计覆盖率分母不存在）。

---

## 二、目标 A：语义沟通与文本意义构建

### A.0 承诺口径（两层）

- **层 1（可判定，验收线 = 100%）**：语义结构输出 100% 通过 schema 校验才可入库/入上下文；确定性重放 5/5 hash 一致；KG 写入幂等回归保持绿；校验器自身 fail-closed 行为 100%。
- **层 2（语义层，验收线 = 测量协议）**：语义等价率在人工标注验证集上测定并发布报告；基线测定后设分级目标（首轮 ≥85%，二轮 ≥90%，按错误分类逐类收敛）；不承诺 100%。

### A.1 实施切片（垂直切片：一个测试 → 一段实现，规则 7）

**S-A1 语义表示 schema + 结构校验器（层 1 地基）**
- 新增 `src/semantic/meaning-schema.ts`：`MeaningRepresentation` 类型（命题集、实体链接、关系三元组、溯源头引用、置信标记）+ zod/JSON-Schema 校验。
- 每个非法结构变体一个测试（缺溯源、悬空实体引用、类型错配、循环关系）。
- 验收：校验器对全部非法变体 fail-closed；对合法样例零误拒。

**S-A2 多级校验流水线**
- `src/semantic/validation-pipeline.ts` 四级，每级独立可测：
  1. 语法级：schema 合法性（S-A1 复用）；
  2. 结构级：实体链接闭合、关系端点存在、溯源头可解析（对 KG/Vault 实存性校验）；
  3. 逻辑一致性：三元组冲突检测（与既有 KG 事实矛盾 → 拒绝或标记 conflict，不静默覆盖——复用 KG 幂等语义）；
  4. 上下文连贯：与当前会话/文档上下文的关键实体重叠度阈值，低于阈值降级为"低置信"标签。
- **fail-closed 铁律**：任一级失败 → 输出拒绝原因码，不入库、不进 LLM 上下文；可配置降级为确定性关键词检索回退。
- 验收：每级独立测试 + 流水线端到端测试；注入畸形样例集（含对抗样例）100% 被拦截且有原因码。

**S-A3 确定性重放 harness**
- `tests/semantic/replay.test.ts`：同输入连续运行 ≥5 次，输出规范化后 hash 全等；覆盖：校验流水线、KG 查询、deterministic-search、Rust 引擎（native 侧用本地 crate 测试或 HTTP 探针）。
- 顺带收口基线缺陷 1：为 `engine.rs:44` 并列截断补稳定次级排序（如 path 字典序），红→绿。
- 验收：重放测试全绿；并列截断不确定性关闭。

**S-A4 语义等价评估集与 runner（层 2 测量协议）**
- `eval/semantic-equivalence/`：seed 集 100-200 例（源文本 + 期望意义结构 + 等价变体），双人独立标注 + 仲裁记录；
- runner 产出：等价率、错误分类（实体错链/关系错向/漏命题/加命题）、逐类明细报告，落 `eval-results/`（沿用 agent-evals 报告惯例）。
- 验收：报告数字可复现（runner 幂等，S-A3 重放）；错误分类与原始样例可对账。

**S-A5 意图标签治理（收口基线缺陷 2）**
- 决策点：`interpretQuery` 的 intent 要么接入控制流（similarity → 走显式相似度路径并受 S-A2 校验），要么删除标签与赋值分支（最小施工优先：删除，按规则 4 归档）。
- 验收：rg 零死标签；相关测试绿。

**S-A6 向量路径口径对齐（收口基线缺陷 5）**
- docs/ARCHITECTURE.md、README.md 点名两条生产向量路径及其开关语义；`/settings/search` 与 context-manager 的 embedder 链显式化为可配置项（默认行为不变，只做口径与可见性对齐，规则 1）。
- 验收：docs-consistency 测试扩展锁定新口径；审计 Medium 项关闭。

### A.3 幻觉防线设计（响应"防崩坏"）

- 生成性组件（LLM 结构化、模型摘要）**默认不进主路径**：沿用 `KNOWLEDGE_USE_LLM=false` 门（knowledge/pipeline.ts:186 现状），任何新引入的生成环节必须带同款显式开关 + 确定性回退。
- 语义结构入库唯一通道 = S-A2 流水线全绿；LLM 产出视为"候选"，与确定性产出同受校验，无特权。
- 崩坏隔离：校验器异常（自身 bug）按 fail-closed 处理并告警，不放行。

---

## 三、目标 B：Runtime 系统优化

### B.1 实施切片

**S-B1 依赖事实与接口规范（先测后改）**
- 建立依赖清单：对 `src/` 顶层模块（core/context/memory/kg/kal/dre/crawl/mcp/router/agents…）做 import 方向矩阵 + 环检测（静态脚本入 `scripts/audit/dep-probe.ts`，输出 JSON 报告）。
- 产出《模块边界与接口规范》文档：每模块对外导出面（深模块原则，规则 8）、允许依赖方向、禁止反向依赖清单。
- 验收：环 = 0（或每环有书面豁免理由）；规范文档经 docs-consistency 锁定关键条目。

**S-B2 独立运行支持（组件级启动面）**
- 盘点各组件当前启动耦合点（如 mcp/server.ts 单体入口），为 memory/kg/crawl 定义可独立实例化的工厂入口（依赖注入参数传入，不在内部 new，规则 8"接受依赖"）。
- 每组件一个冒烟测试：单独实例化 → 最小功能路径 → 销毁，不依赖全局单例状态。
- 验收：冒烟测试全绿；移除的隐式全局依赖逐条记录。

**S-B3 死代码治理（收口基线缺陷 3，规则 4 流程）**
- 对 dre/retrieval 四文件二选一：接线（有真实需求方）或归档（`archive/<项目>/<模块>/` + ARCHIVE-LOG.md 记录 + `git rm`）。
- 默认走归档（最小施工）；若接线 hybrid-fusion，必须先有 S-A2 消费场景。
- 验收：rg 零无主文件；ARCHIVE-LOG 记录完整（时间/目的/原位置/归档位置/所属项目）。

**S-B4 自检查工具链 v2（统一探针框架）**
- 扩展 `scripts/audit/` 为统一 probe runner（`scripts/audit/run-probes.ts`）：聚合现有 dual-probe/oom-probe + 新增：
  - `tool-registry-probe`：动态调 countMcpTools()，断言 = 189 且零重复（防漂移）；
  - `ssrf-coverage-probe`：静态扫描所有 proxyFetch 调用点，输出"用户可控 URL 入口未强制 ssrfGuard"告警（当前白名单：data-pipeline.ts:341）；
  - `dep-probe`（S-B1 产物接入）；
  - `semantic-pipeline-probe`（S-A2 端到端健康）；
  - `vr-budget-probe`（S-B5 接入）。
- 输出统一 JSON + Markdown 报告，PASS/FAIL/SKIP（外部服务不可达时 SKIP 有因，沿用 dual-probe 惯例）。
- 验收：单命令全量探针；CI/本地均可运行；报告落 `docs/` 或 `eval-results/` 可追溯。

**S-B5 显存预算补全（收口基线缺陷 4）**
- `system-resource.ts` 预算增加 activation/scratch 项（可配置，保守默认值），`canRun()` 与 `recommendedMaxTokens` 计算纳入；红→绿测试（先写超额场景测试）。
- 验收：oom-probe 全 PASS；4GB 场景下测算与实测 llama.cpp 峰值偏差记录在案（实机测算如缺环境则标注未验证）。

**S-B6 工具与网络搜索稳定性核验（常态化）**
- 引擎级健康探针：对 DDG/bing-html/searxng 做低频可达性 + 成功率滑动统计（探针模式，不进请求热路径）；失败自动降级路径回归测试（已有引擎级 catch，补测试锁定）。
- 评估引入 per-engine 可选限流（token bucket），默认关闭（规则 1：仅在核验数据支持时启用）。
- ssrfGuard 白名单机制评估：按 proxy-fetch.ts:55-57 既定方向，若实施则 `ssrfAllowHosts` 仅精确放行回环 CDP/本地 LLM，测试锁定。
- 验收：MCP web_search/web_fetch 探针周报产出；失败场景（超时/429/代理失效）测试矩阵全绿。

**S-B7 定期全面核验流程**
- 手动一键：`bun run audit:full`（probe runner + count-tools + docs-consistency + test:full --isolate）；
- 周期执行：按仓库现有 cron/计划任务惯例接入（沿用 dual-probe 的运行方式），产出带日期报告文件。
- 验收：连续两轮全绿报告入库；任一 FAIL 有 issue/记录跟踪。

### B.2 整体协同与独立运行的双态保证

- 协同态：现有单进程入口不变（最小施工）；
- 独立态：S-B2 工厂入口 + 冒烟测试；
- 两态共用同一校验/探针面（S-B4），避免"两套真相"。

---

## 四、时间节点与里程碑（规划假设，非承诺）

| 里程碑 | 周期（假设单人 + 子代理并行） | 内容 | 门禁 |
|---|---|---|---|
| M1 | W1-W2 | S-A1、S-A2（层 1 地基）+ S-B1、S-B2 | 层 1 校验全绿；依赖矩阵 + 边界规范评审 |
| M2 | W3-W4 | S-A3、S-A5、S-A6 + S-B3、S-B4 | 重放 5/5；死代码归档完成；probe runner 单命令可用 |
| M3 | W5 | S-A4 评估集建设与首轮测定 | 首轮等价率报告发布（数字可复现） |
| M4 | W6 | S-B5、S-B6、S-B7 + 全量收口 | `audit:full` 连续两轮全绿；验收清单签署 |

每片独立可交付、可中止（垂直切片，规则 7）；任何切片红不过夜，阻塞即升级决策而非硬试。

---

## 五、资源分配

| 资源 | 用途 |
|---|---|
| 主线程（本人/主 agent） | 切片实施、TDD 红绿、提交与留痕 |
| 子代理（最大并行，规则 2.6） | S-B1 依赖矩阵扫描、S-A4 标注对账、探针脚本独立验证——各自备份/验证/记录 |
| 本地硬件 | RTX 3050 4GB：S-B5 实机测算（如可用）；ollama/边缘 LLM 端点：embedder 链验证 |
| 外部服务 | MinerU Python 服务（只读消费）；搜索引擎（探针对象，不承诺可用性） |
| 评测环境 | `eval-results/` 报告体系（沿用 agent-evals 惯例）；人工标注需用户参与仲裁 |

---

## 六、风险评估与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 语义标注主观性导致等价率波动 | 高 | 双人标注 + 仲裁留痕；错误分类对账；报告标注"判断"与"事实"（规则 10.5） |
| 跨套件测试干扰（既有记录：单进程混跑 131 fail） | 高 | 一律 `test:full --isolate` 门禁；新测试遵循 EXCLUDE_FILES 机制 |
| 工具接口故障（2026-09-06 会话实录） | 中 | 探针幂等 + 重试；报告 SKIP 有因；关键操作前备份（规则 2） |
| 外部服务不可达（192.168.0.150 先例） | 中 | 探针 SKIP 语义 + 降级路径测试锁定；不阻塞本地切片 |
| 死代码归档误删仍有隐性引用 | 中 | 归档前 rg 全量复核 + 双轮 CI 全绿；ARCHIVE-LOG 可回滚 |
| 目标膨胀偏离最小施工 | 中 | 切片门禁；每片提交只含本片文件（规则 3）；超范围需求回写计划再评审 |
| VRAM 实测环境缺失 | 低 | 静态测算 + 单元测试锁定公式；实机项显式标注"未验证" |

---

## 七、阶段性交付成果与验收标准（总表）

| 阶段 | 交付物 | 验收标准（可判定） |
|---|---|---|
| M1 | meaning-schema + 校验流水线 + 依赖矩阵报告 + 组件冒烟测试 | 非法样例 100% 拦截有原因码；依赖环 = 0（或有豁免记录）；冒烟全绿 |
| M2 | 重放 harness + 意图标签治理 + 口径对齐文档 + 归档记录 + probe runner | 重放 5/5 hash 一致；rg 零死标签/死文件；ARCHIVE-LOG 完整；单命令探针出报告 |
| M3 | 语义等价评估集 + 首轮报告 | 100-200 例入库；双人标注记录；报告数字 runner 可复现 |
| M4 | activation 项补全 + 限流/白名单评估 + audit:full 流程 | oom-probe PASS；失败矩阵全绿；连续两轮 audit:full 全绿报告入库 |
| M4 补 | 长会话 soak 报告（S-A7） | N≥200 轮零未捕获异常；逐轮上下文 ≤ 预算；植入记忆召回一致率 ≥ 首轮测定阈值；重复注入零重复 KG/Vault 写入；中断-恢复可续 |
| 终点 | 本计划收口报告 | 七节验收逐条引用证据；未验证项显式列出（延续 audit-verification-log 惯例） |

---

## 八、遗留边界（诚实声明）

1. 本计划不覆盖 Phase 0 全量文件审计（覆盖率分母仍未建立）；如需"审核完成"结论，另立独立任务。
2. 语义层等价率首轮数字出来前，任何"准确率 X%"均为占位假设。
3. 时间节点为单线程 + 子代理并行的规划假设，实际以切片门禁推进为准。

---

## 九、执行修订记录

### R1（2026-09-07）：M3 启动口径（用户批准"按这个方案启动 M3"）

1. **S-A4 首轮测定对象 = 现状基线**：现有确定性抽取产出（`src/crawl/processor/kg-writer.ts` 的 concept 节点抽取，辅以 Vault 摘要路径）作为 candidate_mr 来源，产出 **before 基线**等价率；S-A1/S-A2 上线后以**同一数据集**重测出 after 对比——首轮报告的价值在基线刻画，非达标验收。
2. **标注执行形态**：标注员 A/B = 两个**上下文隔离的子代理实例**（互不可见结果，符合指南 §2 隔离要求）；仲裁人 = 用户本人（指南建议）；`uncertain`/`contested` 规则不变；κ 门禁与 gold 插桩照常执行。
3. **S-A7 依赖澄清与骨架先行**：soak harness 的 5 项崩坏断言**先行针对现有组件**（context-manager compress/retrieve、sqlite-memory、KG 幂等）落地——不阻塞于 M1 的 S-A1/S-A2；S-A2 校验流水线接入为 M1 后的断言增强，harness 断言集不变。
4. **dataset 第一批规模**：100 例（指南下限），三源分布：docs/ 权威文档、Vault 笔记、代码注释/docstring；每例含 source_origin 可回溯定位（指南 §3.1）。
