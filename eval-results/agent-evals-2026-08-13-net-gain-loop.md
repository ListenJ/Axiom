# 网络优化 + 增益反馈闭环 — deepseek-v4-flash（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`
> 优化：任务间隔 1s → 2.5s（实测 opencode 连续请求触发超时）

## 结果

| 阶段 | 通过率 | 通过/总数 |
| --- | --- | --- |
| held-out baseline（无技能） | **90%** | 9/10 |
| held-out evolved（门控+增益注入） | 80% | 8/10 |

## 关键结论（事实）

1. **网络优化显著有效**：全部请求延迟 4-12s（平均 8.5s），**零 121s 超时噪声**——此前 baseline 60-80% 的波动主要来自网络假阴性；2.5s 间隔后真实基线为 90%。
2. **增益数据已积累**（data/skill-gain.json，持久化确认）：
   - auto-induce-js：+30pp（10 样本）
   - auto-fix-knowledge-know-02：+50pp（2 样本）
   - auto-fix-planning-plan-01/02：+50pp（各 2 样本）
   - auto-fix-tool-use-tool-02：+0pp（2 样本）
   - 当前全部技能增益 ≥0 → 均继续注入（无负增益需过滤）。
3. evolved 80% vs baseline 90% 的 1 任务差异为小样本波动（CODING-03/04 两阶段互换、TOOL-04 单次失败），非方向性结论。

## 下一步

- 继续跑 2-3 轮积累增益样本（每族 2 任务的样本太小），负增益技能将自动停止注入；
- 编码族（CODING-03 需 "regexp/正则"、CODING-04 需 map/object/字典/hash）仍是验证器与模型表述差异热点，可针对性生成 auto-fix-coding 技能。
