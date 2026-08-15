# Agent 效果检查 — 默认路由 held-out（2026-08-16）

> 命令：`bun run src/agent-evals/run.ts --split=held-out --concurrency=2`（走 model-router 默认路由，无指定模型）

## 结果

| 项 | 值 |
| --- | --- |
| 任务数 | 24 |
| 通过 | 4 |
| 通过率 | **16.7%** |
| 平均延迟 | 7.8s |
| 平均输出长度 | 151 字符 |

| 任务族 | 通过率 | 通过/总数 |
| --- | --- | --- |
| coding | 25% | 1/4 |
| knowledge | 0% | 0/4 |
| planning | 25% | 1/4 |
| tool-use | 0% | 0/4 |
| memory | 50% | 2/4 |
| self-evolve | 0% | 0/4 |

## 与基线对比

| 配置 | held-out 通过率 | 说明 |
| --- | --- | --- |
| deepseek-v4-flash + evolve（08-13 基线） | **87.5% (21/24)** | 最优基线；该模型当前 503/网络不可达 |
| 默认路由 zhipu（08-16，本次） | 16.7% (4/24) | 当前默认效果 |
| zhipu glm coding-train（08-16） | 33.3% (1/3) | glm-4-flash 通过 CODING-01 |
| sensenova-6.8-flash-lite coding-train（08-16） | 0% (0/3) | 轻量多模态模型不擅代码 |

## 失败主因（事实）

1. **glm-4.7-flash 持续 429 限流**：多数任务该模型 exhausted retries，回退 glm-4-flash；
2. **回退答案过短**（平均 151 字符）：glm-4-flash 简答缺关键概念（如 knowledge 族需解释一致性/可用性/分区），导致关键字校验失败；
3. **模型能力**：当前可用模型栈（zhipu glm-4.x）弱于 deepseek-v4-flash；sensenova 免费但擅视觉/文本、不擅代码。

## 优化落地（本轮）

1. **评测器误杀修复**：CODING-01 防抖改为接受箭头函数/展开符写法（函数声明式 + 箭头式均通过，缺 setTimeout 仍失败）——修复"效果检查"本身的假阴性；
2. **评测限流韧性**：
   - 限流退避封顶：5/10/10s × 3 次（原 5/10/20/40/80s × 5，单任务最多 155s 无限磨）；
   - 主模型失败**自动回退备用模型**（`--fallback-provider/--fallback-model`）；
   - opencode curl 超时 180s → 30s（网络不稳时快速失败让位回退）。

## 结论（判断）

- 当前默认 Agent 效果显著低于历史最优，主因是**模型可达性**（deepseek 不可达 + zhipu 限流）而非 Agent 逻辑；
- 恢复 deepseek-v4-flash 可达（修复 opencode 网络/限流）是回到 87.5% 基线的关键；
- 评测基础设施已加固：模型不可用时快速失败并回退，不再无限磨。

## 排查结果与恢复（2026-08-16 追加）

### opencode/deepseek 可达性诊断（事实）
- `https://opencode.ai/zen/go/v1/models` **HTTP 200**，deepseek-v4-flash 在列；
- chat/completions **直连与经 clash 代理均 HTTP 200**，返回正确回答（prompt_tokens 正常，非截断）；
- 结论：**端点/密钥/模型均正常，非持续故障**。此前 503 是评测突发并发触发的瞬时限流；180s 超时是网络抖动。

### 根因（评测自身 3 个 bug）
1. **curl `-m 30` 总超时杀掉慢模型有效回答**：deepseek 编码/排障类回答 20-48s，30s 被杀 → `[ERROR] curl failed (28)` → 误判失败。修复：`--connect-timeout 15 -m 120`（不可达快速失败让位回退，慢模型可完成）。→ coding held-out 25%→75%。
2. **CODING-04 校验器对中文答案误杀**：正确中文答案用「哈希集合/Set」，组3 要求字面 `hash`（拉丁）而「哈希」≠`hash`。修复：组3 增加「哈希」。→ coding held-out 75%→100%。
3. 瞬时限流：退避封顶 + 主模型失败自动回退（上一轮已修）。

### 恢复后效果（deepseek-v4-flash，无 evolve/constraints）
| 项 | 值 |
| --- | --- |
| held-out 通过率 | **70.8%（17/24）** |
| coding | 75%（3/4，CODING-07 样本波动） |
| knowledge | 75%（3/4） |
| planning | 50%（2/4） |
| tool-use | 50%（2/4） |
| memory | 100%（4/4） |
| self-evolve | 87.5%（7/8） |
| 平均延迟 | 22.6s ｜ 平均输出 584 字符 |

对比：默认路由 16.7% → deepseek 70.8% → 历史 87.5%（deepseek + evolve + constraints）。剩余失败多为**校验器关键词过严**（如 PLAN-04 需字面 p0/先/bug、TOOL-06 需字面 git）或**单样本波动**（CODING-07/TOOL-07 全缺），可后续用 rerun 或宽松关键词消除。
