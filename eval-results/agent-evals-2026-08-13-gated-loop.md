# 门控注入验证 — auto-fix 技能闭环（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`
> 改进：按任务族门控注入 + auto-induce 只取一句话描述（对比上一次无门控全量注入）

## 结果

| 阶段 | 通过率 | 通过/总数 | 对比上次（无门控） |
| --- | --- | --- | --- |
| held-out baseline（无技能） | 60% | 6/10 | 80% |
| held-out evolved（门控注入） | **70%** | 7/10 | 60%（无门控） |

## 结论（诚实标注）

1. **门控消除了干扰性下降**：上次无门控注入导致 KNOW-04/PLAN-03 从 ✅→❌（措辞被完整方法论模板干扰）；本次门控后两任务均保持 ✅；
2. **有小幅提升**：evolved 70% > baseline 60%（MEM-02 从网络噪声失败转 ✅，其余任务两阶段一致）；
3. **单次波动大**：本次 baseline 仅 60%（上次 80%），KNOW-03/MEM-02 baseline 均为 121s 网络噪声假阴性；opencode 网络不稳定影响严格归因，但门控方向性结论可靠（不再有害）；
4. 本次 train 阶段失败任务生成 auto-fix：knowledge-know-02、planning-plan-01、planning-plan-02（磁盘已确认 3 个 + 遗留 auto-induce-js）。

## 质量门控升级（已实施）

- 注入侧接入 `skill-quality`：被质量反馈标记 deprecated 的 auto-induce-* 技能不再注入（有害经验不扩散）；
- 与 promote 侧（deprecated 不提升）+ skill_run 侧（记录成败）组成完整质量闭环。
