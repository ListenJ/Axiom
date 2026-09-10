# 外部 HumanEval / MBPP docker 沙箱能力轴首轮标定 — 2026-09-06

> **摘要**：基线文档结论 #4 点名悬置项的首轮真实标定。HumanEval 全量 164 题（run#22）通过 2.5%、MBPP 前 50 题（run#23）通过 6%——**该数字刻画的是「外部轴 harness 的当前缺陷」而非模型能力**：失败样本聚类显示 HumanEval 失败几乎全部为代码拼接/缩进错位（IndentationError / SyntaxError 'return' outside function），MBPP 失败集中于模型改写入口函数名（NameError + Did you mean）。本轮同时验证了两项本迭代新能力：超时治理后执行错误仅 1/164（旧限 90s/120s 下此类长尾任务会大量转为执行错误）、P0-A 缓存命中度量在真实外部跑首次采集成功（4843/1288 tokens）。后续修复项见 §4。

## 1. 运行口径

| 项 | HumanEval | MBPP |
| --- | --- | --- |
| registry run | run#22（`2026-09-06T16-50-24-329Z.83616`） | run#23（`2026-09-06T18-58-34-806Z.67296`） |
| 任务数 | 164（全量） | 50（`--limit=50`，首切片） |
| provider / model | zhipu / glm-4.7-flash（强制并发 1，rerun-each 默认 2 自适应） | 同左 |
| 沙箱 | docker `python:3.11-slim`（禁网/20s 超时，镜像注入能力为本迭代收口项 f78e50a） | 同左 |
| 通过 | 4（2.5%） | 3（6.0%） |
| 执行错误 | 1 | 0 |
| 延迟 | p50 6.6s / p95 190s / p99 228s | p50 11.5s / p95 51.7s / p99 217s |
| 缓存命中（P0-A） | 4843 tokens（avg 30/调用） | 1288 tokens（avg 26/调用） |
| exit_code | 2（**假回归**，见 §3） | 2（同左） |

## 2. 失败聚类（失败样本逐条目验）

- **HumanEval（160 失败）**：压倒性聚类 = 生成代码与 prompt 头拼接后缩进/结构错位：
  - `IndentationError: unindent does not match any outer indentation level`（如 HE/0、HE/1、HE/4）
  - `SyntaxError: 'return' outside function`（如 HE/2——函数体被置于顶层）
  - 特征：错误行号（13-17 行）落在模型补全段而非 prompt 段，指向**代码块提取/拼接路径**缺陷（H1）而非模型不会写函数。
- **MBPP（47 失败）**：主导聚类 = 模型重命名入口函数：`NameError: name 'similar_elements' is not defined. Did you mean: 'find_similar_elements'?`（MBPP-2/3/4 同型）——prompt 未强制「保留 canonical 函数名」（H3）。
- 少数真实通过（4+3）证明沙箱执行链路本身健康（写码 → 容器执行 → 断言回传全通）。

## 3. 口径注记

- **exit_code 2 为假回归**：首轮外部跑无同集基准，`checkRegression` 自动基准按 null-filter 同模型 scope 撞上内部 66 任务集 run#7（92.3%）——跨基准（不同任务集）对比不成立，判定无效。数据完好入库。改进候选项（下迭代评估）：回归 scope 应纳入任务集标识（external vs 内部 6 族），或外部跑默认 `--no-check-regression`。
- 缓存命中字段为 zhipu 隐式前缀缓存的真实返回，首轮数值偏低符合预期（各任务 prompt 前缀互不相同、无复用），**外部轴恰是前缀缓存优化的下一个收益面**（同题重试时前缀天然复用）。

## 4. 结论与后续（按优先级）

1. **H1 代码提取/拼接修复**（外轴数字有效的先决条件）：核查 external.ts 对 markdown 围栏代码块的提取与 HumanEval「prompt 头 + 补全」拼接语义；修复后重跑小样本（limit=20）验证失败簇消除，再全量重标定。
2. **H3 MBPP prompt 补强**：显式要求「保留 test_list 中的入口函数名，不得重命名」；与 H1 同批验证。
3. **回归 scope 隔离**（§3 假回归的根治）：任务集标识纳入 checkRegression 可比性判定。
4. 外部轴与内部 66 任务集定位区分：外轴为「真实执行断言」的硬验证轨（无断言过标定问题），修复 H1/H3 后才具备与外部公开数字（同级别模型 HumanEval 60-85%）可比性。
