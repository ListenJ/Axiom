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
