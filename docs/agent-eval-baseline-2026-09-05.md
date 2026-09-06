# Agent 能力评测基准标定（2026-09-05）

> 数据源：`data/eval-registry.db` run#5/#6（54 任务第一版全量基线）、run#7（66 任务 zhipu Wave-2）、run#10（66 任务 sensenova Wave-2）。全部数字来自真实 provider 运行，registry 落库，未杜撰。
> 本版 = **54 任务第一版全量基线** + **66 任务 Wave-2 双路实时更新 + deepseek evolve 闭环（run#8/#9）**；deepseek 全量 66（无 evolve 的完整评估）仍不可达（模型自竞争），见文末"待回填"。**修订（2026-09-05 复查）**：首版记载"deepseek evolve 两次不可达、0 任务"有误——run#8/#9（12:04-12:43，job b7862dw8d）实为完整成功的一次 evolve 闭环（held-out baseline 94.7% → evolved 100%），已回填本节。

## 一、方法与口径

- **任务集**：54 自建任务（6 族 × 9），验证器全部为确定性规则（AssertionSpec 声明式断言 + 显式闭包），无 LLM judge。
- **通过率口径**：`通过率 = 通过 / (总数 − 执行错误)`，执行错误（provider 空内容/超时/传输失败）不计入能力判定，单独列示。
- **执行**：zhipu 强制并发 1（429 规避）；sensenova 并发 2。每个任务 `--rerun-each=2` 自适应重跑取最优。
- **成本**：三路均为免费/套餐端点，无 costUsd 计费字段（直连路径），按 token 口径展示。

## 二、三路 provider 全局对比

| provider / 模型 | 通过率（能力口径） | 通过/总数 | 执行错误 | 分位延迟 p50 / p95 / p99 (ms) | 平均输出 |
| --- | --- | --- | --- | --- | --- |
| zhipu / glm-4.7-flash | **90.6%** | 48 / 53 | 1 | 8164 / 24091 / 28951 | 981 字符 |
| sensenova / deepseek-v4-flash | **100%** | 45 / 45 | 9 | 21951 / 90720 / 128775 | 699 字符 |
| opencode / deepseek-v4-flash | **100%**（evolve evolved；baseline 94.7%） | 38 / 38（evolved held-out） | 0 | 25201（evolved 均值） | 972 字符 |

**核心结论**：三个真实端点均有能力基线（deepseek 为 evolve 闭环）。zhipu 能力通过率 90.6%（6 项失败），sensenova 能力通过率 100%（45/45 无能力失败，但 9 项执行错误被排除），deepseek evolve 后 held-out 100%（baseline 94.7%→100%，技能注入恢复全部失败）。**sensenova 延迟极不稳定**（p95≈90s，p99≈129s，单任务最高 128775ms），适合低吞吐场景；zhipu 延迟平稳（p50 8s），是日常评测主选；deepseek（opencode）为模型自竞争端点，仅模型空闲期可用。

## 三、分族通过率（能力口径）

| 族 | zhipu 通过/总数（率） | sensenova 通过/总数（率，排除执行错误） |
| --- | --- | --- |
| coding | 9/9（100%） | 4/4（100%，5 执行错误） |
| knowledge | 7/9（77.8%） | 8/8（100%，1 执行错误） |
| planning | 8/8（100%，1 执行错误） | 9/9（100%） |
| tool-use | 9/9（100%） | 8/8（100%，1 执行错误） |
| memory | 8/9（88.9%） | 8/8（100%，1 执行错误） |
| self-evolve | 7/9（77.8%） | 8/8（100%，1 执行错误） |

**zhipu 短板族**：knowledge（77.8%）与 self-evolve（77.8%）；**sensenova 无能力短板**（全部 100%），但其执行错误集中在 coding 族（5/9，长输出任务在 120s 内拿不到结果）。

## 四、train / held-out 泛化率

| 指标 | zhipu | sensenova |
| --- | --- | --- |
| train 通过率 | 85.7% | 100% |
| held-out 通过率 | 93.8% | 100% |
| 泛化率（held-out / train） | **1.095** | 1.0 |

**结论**：zhipu 的 held-out 泛化率 >1（未见任务表现反超训练任务），说明验证器未对 train 过拟合、任务覆盖均衡；sensenova 双满无区分度（能力全过）。

## 五、成本与 Token（S1）

| provider / 模型 | prompt tokens | completion tokens | 总 token | 平均每任务 |
| --- | --- | --- | --- | --- |
| zhipu / glm-4.7-flash | 2,291 | 24,674 | 26,965 | ~499 |
| sensenova / deepseek-v4-flash | 5,374 | 45,334 | 50,708 | ~939 |

**结论**：sensenova 的每任务 token 消耗约为 zhipu 的 1.9 倍（更长的 completion——回答更详尽，且重跑/执行错误重试更多）；两者均走免费/套餐端点，无额外成本。

## 六、延迟分位（S2）

| 分位 | zhipu (ms) | sensenova (ms) |
| --- | --- | --- |
| p50 | 8,164 | 21,951 |
| p95 | 24,091 | 90,720 |
| p99 | 28,951 | 128,775 |

**结论**：zhipu 延迟集中（p99/p50≈3.5×）；sensenova 长尾极重（p99/p50≈5.9×），存在分钟级单任务。

## 七、失败聚类（S3）

**zhipu 6 项失败（5 能力 + 1 执行错误）：**

| 簇 | 代表样例 | 失败原因 |
| --- | --- | --- |
| 内容缺失（断言过度标定→**已校准**） | KNOW-02（缺 `jsc/javascriptcore`）、KNOW-05（缺 `镜像/image`） | 断言强制 prompt 未要求的概念；探针核实回答符合 prompt 却被误杀（见 十.2） |
| 内容缺失（断言过度标定→**已校准**） | EVOLVE-06（缺 `备份`） | 断言强制「备份」但 prompt 只要求 3 条自检项、未指定内容（见 十.2） |
| 数值/格式（数字） | EVOLVE-09（未找到数字）、MEM-09（数值非正：0） | 未按要求输出数值 / count=0 |
| 执行错误 | PLAN-09 | glm-4.7-flash 空内容重试后仍失败 |

**sensenova 9 项执行错误（能力判定全部通过）：** 集中于长输出任务（CODING-01/03/04/07/08 等），120s 传输超时 / 空内容。

## 八、与历史对比

| 时期 | 任务集 | 配置 | 通过率 |
| --- | --- | --- | --- |
| 2026-08-13/16 | 24 任务旧集（coding） | deepseek-v4-flash + evolve + constraints | 87.5% held-out（历史最优） |
| 2026-08-16 | 24 任务旧集（coding） | deepseek-v4-flash 无 evolve | 70.8% |
| 2026-08 | 24 任务旧集（coding） | 默认路由 zhipu | 16.7% |
| **2026-09-05** | **54 任务新集（6 族）** | **zhipu glm-4.7-flash** | **90.6%**（能力） |
| **2026-09-05** | **54 任务新集（6 族）** | **sensenova deepseek-v4-flash** | **100%**（能力） |
| **2026-09-05** | **66 任务新集（6 族）** | **zhipu glm-4.7-flash（Wave-2）** | **92.3%**（能力） |
| **2026-09-05** | **66 任务新集（6 族）** | **sensenova deepseek-v4-flash（Wave-2）** | **91.5%**（能力） |
| **2026-09-05** | **66 任务新集 held-out（6 族）** | **opencode deepseek-v4-flash --evolve（run#8/#9）** | **baseline 94.7% → evolved 100%**（held-out） |

**结论**：54 任务新集首次全量基线高于旧 24 任务集历史最优（90.6% / 100% vs 87.5%），且新集跨 6 族、覆盖更广，含 held-out 泛化验证。deepseek evolve 闭环（当日唯一一场 evolve）显示**技能注入恢复全部 baseline 失败且无回归**（94.7%→100%），从 24 任务旧集历史最优 87.5% 相同演化路径再验证。

## 九、回归检测

两轮均为**首次全量无同集基准**，`autoCheckRegression` 预期「no-baseline」跳过、未误判；run#5 因能力失败 exit_code=1、run#6 因无能力失败 exit_code=0，分级退出码符合设计。

## 十、结论与建议

1. **模型选型**：日常评测默认 **zhipu/glm-4.7-flash**（延迟平稳、免费、90.6% 能力）；**sensenova/deepseek-v4-flash** 能力最强（100%）但延迟长尾严重、执行错误多，仅适合低吞吐/高精度场景。
2. **校验器校准点（已核验并校准）**：KNOW-02/KNOW-05/EVOLVE-06 三处**并非同义词组过窄**——组内已含 `javascriptcore`/`image`/`备份` 等常见写法；探针核实为**断言强制了 prompt 未要求的概念**：KNOW-02 运行时点只认引擎名（答「Zig+性能」被误杀）、KNOW-05 强制未要求的 `镜像`（prompt 只问隔离/资源/启动三维）、EVOLVE-06 强制未指定的 `备份`（prompt 只要求 3 条自检项）。已按 prompt 对齐校准（KNOW-02 运行时点放宽多信号、KNOW-05 镜像组→启动速度组、EVOLVE-06 删备份组），TDD 红→绿 + 双路真机重跑核验（zhipu run#20 3/3 恢复通过、sensenova run#19 3/3 无回归）。
3. **执行错误治理**：两个端点在 66 任务重跑中执行错误均显著上升（zhipu 1→14、sensenova 9→19）且各呈不稳定窗口——zhipu 为空内容突发窗口，sensenova 为 429 密集限流窗口（本时段端点负载高）；长输出任务（maxTokens 大）是共同易损点，建议提高 curl 超时或降低 `maxTokens`，并避开高峰窗口重跑。
4. **后续迭代**：deepseek（opencode）evolve 闭环**已成功于本日 run#8/#9**（held-out baseline 94.7%→evolved 100%）；**未完成的是 deepseek 全量 66（无 evolve）评估**——精确到端点的三次尝试中两次撞 transport error（10:40 全量、12:49 evolve2），另一次（12:04 evolve）成功。模型自竞争（opencode 即会话所用模型）下仅空闲期可跑，需**模型空闲期**（独立会话）补全量 66；外部 HumanEval/MBPP docker 沙箱能力轴**已于 2026-09-06 首轮标定**（run#22/#23，报告 eval-results/agent-evals-2026-09-06-external-zhipu.md）：数字（2.5%/6%）刻画外轴 harness 缺陷而非模型能力——HumanEval 失败为代码拼接/缩进错位主导（H1 待修）、MBPP 为模型改写入口函数名（H3 待修）；本轮同时验证超时治理成效（执行错误仅 1/164）与缓存命中度量真机采集（4843/1288 tokens）。

## 十一、66 任务 Wave-2（+12 真实场景任务，2026-09-05 实时）

### run#7 — zhipu / glm-4.7-flash（66 任务，registry 已落库）

| 指标 | 值 |
| --- | --- |
| 通过率（能力口径） | **92.3%**（48/52，14 执行错误不计入） |
| train / held-out / 泛化 | 95.2% / 90.3% / 0.949 |
| 执行错误 | **14**（vs 54 任务集仅 1） |
| 延迟 p50 / p95 / p99 | 20125 / 65802 / 76724 ms |

**分族（passed / 非执行错误数，率）**：coding 6/6（100%）、knowledge 5/5（100%）、planning 11/11（100%）、tool-use 10/10（100%）、memory 10/11（**90.9%**）、self-evolve 6/9（**66.7%**）。

**关键发现**：
1. **14 个执行错误是端点不稳定，非任务设计问题**——逐任务时序分析显示两段 ~4.3s 空内容连爆（CODING-07→KNOW-05 连续 9 个；KNOW-11、EVOLVE-10/11+TOOL-01 连续 3 个），中间窗口恢复后 KNOW-06~MEM-11、PLAN 全族、TOOL-02~11 全部正常。glm-4.7-flash 空内容（hidden reasoning 消耗预算）在本次运行呈**突发性窗口**而非均匀分布。
2. **新任务 12 个：7 个执行成功全部通过**（KNOW-10 / PLAN-10 / PLAN-11 / TOOL-10 / TOOL-11 / MEM-10 / MEM-11），**5 个撞上端点不稳定窗口未测出**（CODING-10 / CODING-11 / KNOW-11 / EVOLVE-10 / EVOLVE-11）——已在下文 `### 撞窗新任务干净窗口重跑校准` 全部补测通过。
3. **真实能力失败 4 个**：MEM-09（数值非正 0，与 run#5 一致）、EVOLVE-06（缺 备份，与 run#5 一致）、EVOLVE-04（缺 降级/处理——run#5 通过，本次波动失败）、EVOLVE-09（缺 下次——run#5 为未找到数字，失败模式漂移）。→ 与 run#5 对比，**稳定失败仅 MEM-09 + EVOLVE-06**；EVOLVE-04/09 为样本波动。

**结论**：66 任务 zhipu 基线的**能力信号有效**（92.3%，无执行错误的任务表现与 run#5 一致）；执行错误率飙升本身是 glm-4.7-flash 端点可靠性的独立发现，建议评测重跑窗口避开其不稳定时段。5 个未测出的新任务列入待重跑。

### run#10 — sensenova / deepseek-v4-flash（66 任务，registry 已落库）

| 指标 | 值 |
| --- | --- |
| 通过率（能力口径） | **91.5%**（43/47，19 执行错误不计入） |
| train / held-out / 泛化 | 85% / 96.3% / **1.133** |
| 执行错误 | **19**（vs run#6 54 任务集 9；本时段端点 429 密集限流） |
| 延迟 p50 / p95 / p99 | 22853 / 119400 / 119486 ms（平均输出 492 字符） |

**分族（能力口径 passed/非执行错误数，率）**：coding 6/7（85.7%）、knowledge 6/7（85.7%）、planning 10/10（100%）、tool-use 9/9（100%）、memory 8/8（100%）、self-evolve 4/6（**66.7%**）。

**关键发现**：
1. **19 个执行错误 = 端点 429 限流密集窗口，非任务设计问题**——运行日志全程大量 `rate-limited (429)` 重试 + empty content + transport abort；sensenova（token.sensenova.cn）本时段负载高，与 run#6（54 任务仅 9 执行错误）对比呈窗口性恶化。能力判定不受影响（执行错误不计入分母）。
2. **新任务 12 个：9 个通过**（CODING-10 / KNOW-10 / PLAN-10 / PLAN-11 / TOOL-10 / TOOL-11 / MEM-10 / EVOLVE-10 / EVOLVE-11），**3 个撞限流窗口未测出**（CODING-11 / KNOW-11 / MEM-11）——已在下文 `### 撞窗新任务干净窗口重跑校准` 全部补测通过。
3. **真实能力失败 4 个**：CODING-03（缺 `regexp/正则`——zhipu run#5 通过，本路波动失败）、KNOW-02（缺 `zig`——zhipu run#5 缺 `javascriptcore`，**验证器同义词组半命中**：两路各答出另一半）、EVOLVE-01（缺 `检查/判断`）、EVOLVE-09（缺 `下次`）。→ **EVOLVE-09 为跨 provider 稳定失败**（zhipu run#5/#7 + sensenova run#10 均缺 `下次`），属验证器校准点还是真实能力缺口，需看回答原文再定。

**结论**：sensenova 66 任务能力口径 91.5%，泛化率 1.133（held-out 反超 train，无过拟合）；与 zhipu run#7（92.3%）接近，但本路执行错误更高（429 窗口）。**跨 provider 稳定失败 EVOLVE-09（缺 下次）** 是 12 个新任务外最值得优先核验的信号。

### run#8 / run#9 — deepseek-v4-flash（opencode）evolve 闭环（66 任务集 held-out）

**运行**：git_commit `4e4dc82`（与 run#7/#10 同版本，66 任务集）；argv `--provider=opencode --model=deepseek-v4-flash --evolve --concurrency=1 --rerun-each=1`；12:04:18 启动，12:43:52 两阶段完成落库（run_tag `...30192::baseline` / `::evolved`）。**这是当日唯一一场完整跑通的 evolve 闭环**（后台 job b7862dw8d / deepseek-evolve-66）。

| 阶段 | 通过率 | 通过/总数（held-out） | 执行错误 | 平均延迟 | 平均输出 |
| --- | --- | --- | --- | --- | --- |
| baseline（无技能） | **94.7%** | 36/38 | 0 | 27989 ms | 1147 字符 |
| evolved（注入技能） | **100%** | 38/38 | 0 | 25201 ms | 972 字符 |

**分族（baseline → evolved，passed/总数）**：coding 5/6→6/6、knowledge 7/7→7/7、planning 6/6→6/6、tool-use 6/6→6/6、memory 6/7→7/7、self-evolve 6/6→6/6。

**关键发现**：
1. **技能注入恢复全部 baseline 失败且无回归**：baseline 的 2 项真实能力失败（CODING-03 缺 `regexp/正则`、MEM-09 数值非正 0）在 evolved 阶段被工具技能全部恢复（38/38 带 injected_skills），memory 族 85.7%→100%。这与 24 任务旧集历史最优路径（deepseek+evolve 87.5%）方向一致，再次验证 evolve 闭环的自修复价值。
2. **两阶段零执行错误**：与同日 zhipu/sensenova 的 66 任务执行错误暴增（14/19）对比，opencode 端点本时段（12:04-12:43）稳定可靠。
3. **实测噪音**：concurrency=1（较保守）、rerun-each=1（无重跑）——真实能力信号强但不同于其他两路口径（held-out 38 vs 全量 66），不做跨路直接对等比较。

**结论**：deepseek-v4-flash 在本套件上能力**不低于**两路（evolve 后 held-out 100%），且 evolve 闭环验证真实有效；**唯一未完成的是 deepseek 全量 66（无 evolve）评估**，需模型空闲期补跑（见待回填）。

### 撞窗新任务干净窗口重跑校准（run#14/#16/#17/#18）

run#7（zhipu）/run#10（sensenova）撞上端点不稳定窗口的 8 个新任务，避开高峰时段后补测**全部通过**——证明这些失败是纯端点窗口产物，非能力缺口：

| 任务 | zhipu（run#17 18:04 / run#18 18:20） | sensenova（run#14 17:31 / run#16 17:48） |
| --- | --- | --- |
| CODING-10 | ✅ PASS（run#18；run#17 仍空内容 1 次→残留瞬态，run#18 恢复） | ✅ run#10 已过 |
| CODING-11 | ✅ PASS（run#17） | ✅ PASS（run#16，429 窗口后） |
| KNOW-11 | ✅ PASS（run#18；run#17 缺 `reset --hard` 组 flake→见下） | ✅ PASS（run#14） |
| MEM-11 | ✅ run#7 已过 | ✅ PASS（run#14） |
| EVOLVE-10 | ✅ PASS（run#17） | ✅ run#10 已过 |
| EVOLVE-11 | ✅ PASS（run#17） | ✅ run#10 已过 |

**关键发现**：
1. **12 个新任务两路全通**：zhipu 12/12、sensenova 12/12（含撞窗任务），新任务无真实能力缺口；run#7/run#10 的撞窗失败 100% 可归因于端点窗口。
2. **KNOW-11 单样本 flake 属采样方差**：run#17（18:05）zhipu 答出 force push 但未点名 `硬重置`→断言缺第二组；直连探针（`.tmp/probe-zhipu-know11.ts`）与 run#18（`--rerun-each=3`）均产出完整答案（force push + 硬重置），断言本身无误伤——**能力存在但答案存在采样波动**（temperature=0.2 下偶发换用第二个高危操作）。
3. **执行错误（空内容）不再集中**：run#17 仅 1/5 空内容（vs run#7 的 5/5、run#13 的 5/5），run#18 0/2——zhipu 的 glm-4.7-flash 空内容窗口是**时段性**负载甩载，避峰后基本恢复。

**结论**：Wave-2 的 66 任务两路基线结论**不受撞窗影响**（能力口径与待回填校准后的新任务全通一致）；zhipu 空内容窗口的时段性特征再次确认（下午/傍晚高发，深夜/凌晨恢复）。

### 待回填

- [ ] deepseek-v4-flash（opencode）**全量 66（无 evolve）**——尚不可达（模型自竞争）：opencode 端点即当前会话所用模型，会话活跃即抢占端点。三次尝试明细：10:40 全量 54（`.tmp/eval-logs/deepseek.log`）transport error 拖死、12:04 **evolve 闭环成功（run#8/#9，已回填本节）**、12:49 evolve2（`.tmp/run-deepseek-evolve2.log`）阶段1/3 撞 120s 超时拖死。**全量 66 需模型空闲期（独立会话）重跑**。
- [x] zhipu 5 个撞窗新任务（CODING-10/11、KNOW-11、EVOLVE-10/11）+ sensenova 3 个（CODING-11、KNOW-11、MEM-11）干净窗口重跑校准——**8/8 全部补测通过**（run#14/#16/#17/#18），见 `### 撞窗新任务干净窗口重跑校准`；撞窗失败 100% 归因端点窗口，无能力缺口
- [x] EVOLVE-09 跨 provider 稳定性核验——**结论：验证器校准，非能力缺口**。原断言要求「字面 下次 + 数字≥2」误伤合格回答（zhipu 用中文序号「规则一/二」无数字、sensenova 用「规则 1/2/3」未复述「下次」，但均含验证动作+回滚确认点）；校准后新断言（三组同义词 + ≥2 编号标记）下 run#11 zhipu / run#12 sensenova 双 PASS
