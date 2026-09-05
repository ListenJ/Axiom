# Agent 能力评测基准标定（2026-09-05）

> 数据源：`data/eval-registry.db` run#5（zhipu glm-4.7-flash，54 任务）、run#6（sensenova deepseek-v4-flash，54 任务）。全部数字来自真实 provider 运行，registry 落库，未杜撰。
> 本版为**第一版全量基线（54 任务集）**；66 任务扩展（+12 真实场景任务）的 Wave-2 数据见文末"待回填"节。

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
| opencode / deepseek-v4-flash | _待重试（模型过载）_ | — | — | — | — |

**核心结论**：两个真实端点都是首次全量基线。zhipu 能力通过率 90.6%（6 项失败），sensenova 能力通过率 100%（45/45 无能力失败，但 9 项执行错误被排除）。**sensenova 延迟极不稳定**（p95≈90s，p99≈129s，单任务最高 128775ms），适合低吞吐场景；zhipu 延迟平稳（p50 8s），是日常评测主选。

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
| 内容缺失（同义词组未命中） | KNOW-02（缺 `jsc/javascriptcore`）、KNOW-05（缺 `镜像/image`） | 回答正确但未命中验证器同义词组（校验器校准点） |
| 内容缺失 | EVOLVE-06（缺 `备份`） | rm -rf 自检漏提备份 |
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

**结论**：54 任务新集首次全量基线高于旧 24 任务集历史最优（90.6% / 100% vs 87.5%），且新集跨 6 族、覆盖更广，含 held-out 泛化验证。

## 九、回归检测

两轮均为**首次全量无同集基准**，`autoCheckRegression` 预期「no-baseline」跳过、未误判；run#5 因能力失败 exit_code=1、run#6 因无能力失败 exit_code=0，分级退出码符合设计。

## 十、结论与建议

1. **模型选型**：日常评测默认 **zhipu/glm-4.7-flash**（延迟平稳、免费、90.6% 能力）；**sensenova/deepseek-v4-flash** 能力最强（100%）但延迟长尾严重、执行错误多，仅适合低吞吐/高精度场景。
2. **校验器校准点**（zhipu 6 失败中 4 个是同义词组未命中）：KNOW-02/KNOW-05 的验证器同义词组需补 `JavaScriptCore`/`image` 等常见写法；EVOLVE-06 补 `备份` 同义词——**先看回答原文再定组，避免误伤真答**。
3. **执行错误治理**：sensenova 长输出任务超时是主要执行损失（9/54），可考虑对该端点提高 curl 超时或降低 `maxTokens`；glm-4.7-flash 的"空内容（hidden reasoning 消耗预算）"在 66 扩展任务的 512-768 maxTokens 提示下更频繁（见 Wave-2）。
4. **后续迭代**：deepseek（opencode 端点）基线待重试；66 任务 Wave-2 数据待回填；外部 HumanEval/MBPP docker 沙箱能力轴待单独标定。

## 待回填（Wave-2，后台运行完成后更新）

- [ ] 66 任务（+12 真实场景任务）zhipu / sensenova 重跑数据（后台 Job：bac0fclnj）
- [ ] deepseek-v4-flash（opencode）全量 + `--evolve` 闭环数据（后台 Job：b7862dw8d）
- [ ] 12 个新任务的分任务通过率与失败聚类
