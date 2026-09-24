# 全自动审计链首轮报告（2026-09-25）

> 审计对象：Axiom Runtime（axiom-agent 4.0.0，本仓库工作树 @ `de068129` 附近，分支 `codex/laya-audit-chain-2026-09-25`）。
> 审计方式：**Laya 驱动的全自动审计链**（`bun run audit:chain`，本日建成）执行机械化底座 + 人工裁定写入本文。
> 口径：每条结论给到 `文件:行号` 或可重跑命令；做不到的一律进"未验证"栏，不折算成成绩。
> 本报告把"审计提示词（强约束版）"的六节输出格式全部保留；覆盖率不满 100% ⇒ 按 §七 如实声明"全量深审尚未完成"。

## 一、审核覆盖率

| 通道 | 覆盖面 | 数字 |
| --- | --- | --- |
| 文件清单（Phase 0 分母） | `audit:inventory` 递归全树，排除 node_modules/.git/dist/archive/tmp/reports/test-results/vendor/python_libs/external-benchmarks/knowledge-base/data 等 | **2363/2363 = 100%**（core 891 · test 538 · config 475 · docs 246 · asset 213；文本行 323,423） |
| 依赖清单扫描 | 全部 package.json 的 dependencies/dev/optional/peer 四节 | 100%（命中 0，见 §二） |
| 代码模式扫描 | 1357 个 ts/tsx/js/py/go/rs 文件 | **1357/1357 = 100%**（命中 202，见 §二） |
| 声明提取 | README/LIMITATIONS/docs 8 份权威文档 | 37 条声明落 `file:line` |
| 深度人工评审 | 核心逻辑逐文件读码 | **约 14/891 core 文件 ≈ 1.6%**（清单见 §五"未验证项"） |

**判定：机械化通道 100%；深度逐文件评审未达 100% ⇒ 本轮不宣称"全量审核完成"**，完成范围 = 机械化底座 + 模块 7 专项置顶核查 + 两处文档一致性发现 + 仓库最大待办（91 红跨文件污染）的根因定位与修复。

## 二、核心技术承诺核查结果（模块 7，置顶）

### 2.1 "非向量化本地语义搜索"

**裁定：部分一致。** 依赖通道与默认检索路径与承诺一致；但树内存在**两条真实向量路径**，与"非向量化"的扁平表述冲突，与仓库自身文档"余弦仅可选语义层"的限定表述一致。

- **依赖通道（强证据）**：全部 package.json 四节依赖对 faiss/chromadb/qdrant/annoy/hnswlib/sentence-transformers/pgvector/pinecone/weaviate/milvus/lancedb 等模式 **0 命中**（证据：`.tmp/audit/vector-scan.json` depHits=[]；重跑 `bun run audit:chain -- --stages-only --stage=audit:vector-scan`）。
- **代码通道**：1357 个代码文件 202 处命中，逐类定性：
  - `faiss` ×3 —— 全部是本审计链自身的扫描正则与新测试夹具（`src/decision/audit-chain.ts:154`、`tests/unit/audit-chain.test.ts:95,102`），**非真实使用**。
  - `cosineSimilarity` ×32 —— 真实实现集中于共享件 `src/utils/math.ts`；调用方：`src/core/settings-search.ts:10`（设置语义搜索，bge-m3 embedding + 余弦，`engine:"semantic"|"hybrid"`，阈值 0.15）、`src/context/context-manager.ts:265`（记忆检索 `cosineSimilarity(queryEmbedding, entry.embedding)`）、`src/dre/consciousness/stream.ts` ×3。其余为文档测试断言。
  - `embedding` ×167 —— 其中 `src/local-llm/edge-embeddings.ts:1-30` 是**真实的本地向量化客户端**（BAAI/bge-m3，默认端点 `http://127.0.0.1:9001`，`EDGE_SETTINGS_SEARCH=0` 可禁用）。
- **确定性默认路径（与承诺一致）**：`src/memory/deterministic-search.ts` + SQLite FTS5 主索引（`src/memory/sqlite-memory.ts`），README.md:271-284 自述"四阶段漏斗检索"且"余弦仅可选语义层"；PG vector 无启用路径（依赖清单 0 命中佐证）。
- **语义召回边界（如实告知）**：默认路径是 FTS5 + 关键词加权打分，对**同义改写、跨语言、意图级泛化**的召回弱于向量检索；语义补强的同义词表只覆盖人工登记词对（`src/core/settings-search.ts:31-33`）。不应把默认路径默认等价于向量检索。

### 2.2 "确定性推理"

**裁定：部分验证（本轮实测的通道全部通过，未覆盖通道已列明）。**

- **模型侧（13.5 口径实测）**：`audit:laya-determinism` —— 同一 spec 跨进程独立运行 **N=5**，laya_gate（bf16/CUDA）输出**逐字节一致**，退出码 `0,0,0,0,0`（证据 `.tmp/audit/laya-determinism.json`）。不以"代码看起来无随机性"替代实测。
- **链侧结构确定性**：vector-scan/claims 同进程复跑 **N=5** 逐字节一致；inventory N=2 一致（重清单降配，已在证据 JSON 内如实标注口径）。
- **KAL 查询**：静态证据——`src/kal/knowledge-access-layer.ts`（594 行）全文零 LLM 引用；`src/knowledge/pipeline.ts:121,281` 的 LLM 分支受 `KNOWLEDGE_USE_LLM` 门控且**默认 false**，默认走确定性 TF-IDF。**N≥5 独立运行实测未做**（见 §五）。

## 三、声明 vs 实际对照总表（模块 13）

| # | 声明（出处） | 实际（证据） | 裁定 |
| --- | --- | --- | --- |
| 1 | "非向量化本地语义搜索"（审计提示词对项目的描述） | 存在两条真实向量路径（settings-search 语义引擎、context-manager 记忆 embedding），均非默认必经 | **不一致（对扁平表述）** |
| 2 | "余弦仅可选语义层"（README.md:282） | 与代码一致：默认 FTS5+关键词，语义层需 edge endpoint 且可禁用 | **一致** |
| 3 | "确定性 TF-IDF 回退（zero LLM 承诺）"（pipeline.ts:46） | `KNOWLEDGE_USE_LLM` 默认 false，默认分支无 LLM 调用（静态追踪） | **一致（待 N≥5 实测加固）** |
| 4 | 版本自述单源 4.0.0（tests/version-consistency.test.ts） | 运行时五落点已收口，但 README.md:1 仍自述 "Axiom Runtime v3.1"（门不覆盖 README） | **不一致（F1）** |
| 5 | 工具总数 189 = 单一事实源（README.md:5、ARCHITECTURE.md:291） | `bun run scripts/count-tools.mjs` 实测 **189**；但 LIMITATIONS.md:15 仍写 188 | **部分一致（F2）** |
| 6 | Laya"模型只能提高警觉"（ADR-008） | 实测 5 个只读 stage noul 全部高值（0.92/0.93/0.59/0.54/0.72）但裁定仍按登记表 AUTO、仅留痕；guard 条目（engineering+external_write）被 ESCALATE | **一致（本轮实跑）** |
| 7 | Laya 输出确定性（skill 隐含承诺） | 跨进程 N=5 逐字节一致（本机 bf16/CUDA） | **一致（单机口径）** |

## 四、分模块问题清单

| 编号 | 级别 | 位置 | 证据与描述 | 影响 | 缓解 |
| --- | --- | --- | --- | --- | --- |
| F1 | Low | `README.md:1`、`tests/version-consistency.test.ts:18` | README 首行 "Axiom Runtime v3.1" vs `src/version.ts` `APP_VERSION="4.0.0"`；版本等值门的 `SELF_REPORT_FILES` 不含 README，门自身自证不能覆盖此落点 | 文档读者拿到过期版本号；违反"版本单源"意图 | 待修（本轮任务面，见 §六） |
| F2 | Low | `LIMITATIONS.md:15` | 写 "当前 **188**"；权威计数实测 189（`bun run scripts/count-tools.mjs` → total=189, duplicates=0） | 单一事实源在第二份文档里失真 | 待修（同上） |
| F3 | High | `tests/hallucination-wiring.test.ts:29-63`（修复前） | 6 个 `mock.module`（model-router/intent-enhancer/prompt-optimizer/read-optimizer-init/codegraph-index/knowledge）**无任何还原**；bun 的 module mock 进程级残留 ⇒ 串行全量 91 红（23 文件），受害指纹 `router.routeByIntent is not a function`（model-router.test.ts:87）、`buildEnhancedSystemPrompt` 缺身份声明。最小红对实测：毒源+model-router=6 红、+intent-enhancer=21 红、+prompt-optimizer=1 红，与串行聚类分簇吻合 | CI（不带 `--parallel` 的两条路径）长期处于隐性红态；"并行=8 掩盖 83 条"之谜（2026-09-24 §八）在本轮拿到代码级根因 | **已修**：mock 前快照真导出 + afterAll 回灌（先例 consciousness.test.ts:194-207）；红→绿闭环见 §六.2 |
| F3b | High | 同类病根一次清点（修复前均无还原）：`tests/chat-memory-loop.test.ts:64`、`tests/internal-agent-budget.test.ts:7`、`tests/routes-chat-validation.test.ts:22`、`tests/memory/archiver-safe-move.test.ts:21`、`tests/services-chat.test.ts:11-43`（5 个 mock）、`tests/minimax.test.ts:9`、`tests/agents/risk-verdict-cache.test.ts:31`（relative 路径未复现泄漏，一并补齐） | 全部为绝对路径 `mock.module` 顶掉 `src/router/model-router.js` 等真模块；受害指纹 `router.assign is not a function`（部分 mock 无 assign） | 同上 | **已修（7 文件）**：同款快照+回灌；risk-verdict-cache 连带补 env 还原 |
| F6 | Low | `tests/env-example-completeness.test.ts:78`（真红，单跑可复现） | 缺 `AUDIT_DET_RUNS`、`AUDIT_LAYA_TIMEOUT_MS` —— 本轮新增审计链的两个 env 变量未登记 `.env.example`，门立即抓住 | env 模板完整性失真 | **已修**：登记进 `.env.example`（带默认值注释）；门复测 2/0 绿 |
| F7 | Medium | `tests/workers/pdf-worker.test.ts` ×3、`tests/business-scenarios/retrieval-workflows.test.ts:298`（残余） | 修复后串行仅剩 4-5 条：pdf-worker `res.json is not a function`（`src/workers/pdf-worker.ts:35`）指向**跨文件 fetch 桩时序泄漏**（8 个桩文件配对均绿、单跑绿 ⇒ 多文件累积态/竞态）；场景 1 `layerSum` 期望 <1.1 实得 2（相位比率疑似被污染状态双计），单跑 10/0 绿 | 串行口径下仍有约 0.1% 用例不可靠 | **未修（留档下轮）**：需全量二分定位（约 8 次 × 4 分钟）；指纹与紧邻前文已登记（pdf-worker 前文 withTimeout-listener-leak/tool-schema；场景 1 前文 bug-hunt/security-and-integrity） |
| F4 | Info | `src/core/settings-search.ts`、`src/local-llm/edge-embeddings.ts` | 语义引擎默认尝试启用（`EDGE_SETTINGS_SEARCH` 默认开），但需 edge embedding 端点在线；端点缺失时降级关键词 | 行为因环境而异；对外表述应统一到"余弦仅可选语义层"限定语 | 文档已披露（README:282） |
| F5 | Info | 本链 `src/decision/audit-chain.ts`（施工中发现并当场修） | laya-determinism 首版把 5 次 exit=2 的一致报错判成"确定"（假绿）——判据说谎模式 | 确定性证据可信性 | 已修：`determinismVerdict` 要求全零退出（tests/unit/audit-chain.test.ts 假绿回归锁） |

模块 1-6、8-12 的逐文件深审清单与文件指针见 §五；本轮未发现新的 Critical 级问题，**但深审覆盖率仅 1.6%，不得据此推断"其余模块无问题"**。

## 五、未验证/无法访问项清单

1. **KAL/检索 N≥5 独立运行确定性**：仅静态追踪（表格 §二.2.2 第三行）；需要可在本机跑的检索 harness，属下轮。
2. **模块 1（架构一致性双向核对）、模块 2（Agent 编排竞态）、模块 3（100+ 工具逐个输入校验）、模块 4（网络搜索清洗/降级）、模块 6（摄取管线异常分支 + KG 幂等）、模块 8-9（KV cache 换页/VRAM 滞回，对应 `src/dre/system-resource*.ts`、`src/dre/llm/client.ts`）、模块 10-12（注入面/性能峰值/自研度）**：本轮未深审。这些模块的入口文件已在 2363 份清单中登记（`audit:inventory` 证据），属"已列入分母、未逐文件读码"状态。
3. **向量语义行为实测**：edge endpoint 在线时的 embedding 质量与降级路径行为未实测。
4. **跨硬件确定性**：模型 N=5 在单机（WSL2 Arch + CUDA）完成；跨硬件/跨后端的非结合性误差未测。

## 六、本轮经审计链完成的仓库任务（非算力类）

### 6.1 交付物（新增/修改）

| 文件 | 性质 |
| --- | --- |
| `skills/laya-local-decision-model/SKILL.md` | 用户级 Laya skill 入库 + Jev 扫描结论 + Linux 原生用法（解决 2026-09-24 §五"仓库零引用"登记项） |
| `docs/research/system-one-decision-model-skills-2026-09-25.md` | Jev（TypeSafe AI System One）→ Laya skill 纪律映射调研（规则 10.3 知识文件） |
| `src/decision/laya-triage.ts` | +`createLocalLayaRunner`（Linux 原生，不经 wsl.exe）+`selectRunnerKind`+`createPlatformLayaRunner` |
| `src/decision/audit-chain.ts` | 全自动审计链：5 个只读 stage + 链驱动 + CLI（`bun run audit:chain`，`--stages-only` 为人工直跑口） |
| `src/decision/laya-cli.ts` | 注册 5 个审计动作；check/runner 平台自适应；修 `--spec` 解析的 indexOf 隐患 |
| `docs/decisions/laya/audit-chain-triage.json` | 审计链分诊 spec（5×local_reversible + 1×guard 证明条目） |
| `tests/unit/audit-chain.test.ts` | 16 测试（ADR-008"注册即补测试"） |
| `tests/hallucination-wiring.test.ts` + 7 个 mock 文件 | **F3/F3b 修复**：8 个文件的 `mock.module` 补"mock 前快照 + afterAll 回灌" |
| `.env.example` | **F6 修复**：登记 `AUDIT_DET_RUNS`/`AUDIT_LAYA_TIMEOUT_MS` |
| `README.md:1`、`LIMITATIONS.md:16` | **F1/F2 修复**：v3.1→v4.0.0（与 README:17 及单源一致）、188→189（与权威计数一致） |

### 6.2 验证证据

- 单测：`bun test tests/unit/audit-chain.test.ts tests/unit/laya-triage.test.ts` → **31 pass / 0 fail**。
- 三道门（ADR-008 教训：改 src 必连跑）：`audit:runtime` **16/16**、`architecture-integrity` **25/25**、`doc-contract` **35/35**。
- 全链实跑（真模型分诊）：5 stage AUTO→`EXECUTED ok=true`；`release:tag-and-push` →`ESCALATED`（领域封杀）；noul 交叉核对 5 条留痕不改裁定。
- 确定性：模型跨进程 N=5 逐字节一致（exit 0×5）；扫描通道 N=5 一致。
- 91 红根因修复（F3）：修复前毒源+受害者三对 = 6/21/1 红；修复后同三对 = **0/0/0** 红、毒源自身 16/0。全量串行复跑读数见 §六.3。

### 6.3 全量串行复跑（修复后）

<!-- SERIAL-AFTER-FIX -->

**全量串行复跑（`bun test --timeout 15000 ./tests`，同一台机器、同一入口）三轮对照：**

| 轮次 | 读数 | 说明 |
| --- | --- | --- |
| 修复前（基线复跑） | 4258 pass / **91 fail** / 34 skip（419 文件，225s） | 91 失败归属 23 文件；intent-enhancer 21、prompt-optimizer 10、proxy-fetch-hardening 9、model-router 7、flat-router 6… |
| 修复 #1（hallucination-wiring 补还原） | 4289 pass / **60 fail**（236s） | -31：intent-enhancer/prompt-optimizer 族全绿 |
| 修复 #2（另 7 个 mock 文件补还原 + env 登记） | **4344 pass / 5 fail**（250s） | 残余 = pdf-worker ×3（F7 fetch 桩时序）+ 场景 1 ×1（F7 相位双计）+ env ×1（F6，已修，门复测 2/0） |

⇒ **91 → 5，其中 87 条根因修复并红→绿闭环**；残余 4 条为时序型（F7 留档），env 门真红当场修复。并行口径（`bun run test`，`--parallel=8`）未在本轮重跑 —— 它掩盖的 83-86 条正是本轮修掉的泄漏面，按 2026-09-24 §八的"三元组"纪律，任何绿度声明必须带入口/开关/dist 三要素，本轮口径 = 串行 + 无 `--parallel` + dist 在工作树。

## 七、总体结论

按 §七 完成判定标准逐条核对：文件覆盖率 100%（机械通道）/ 1.6%（深审）；模块 7 已给出"部分一致"的明确裁定；Critical/High 问题（F3/F3b）带可复现红→绿证据（串行 91→60→5，87 条根因闭环）；对照总表无空缺行。**本轮结论："机械化审计底座建成并 100% 跑通；模块 7 专项闭环；仓库最大待办（§八之 90 红谜题）根因定位并修复 87/91，env 门真红当场修掉，时序型残余 4 条（F7）带指纹留档下轮；全量深审（模块 1-6/8-12）尚未完成，分母与清单已就位，续做入口即 `bun run audit:chain`。"** 不得把本轮结果泛化为"项目整体审核通过"。
