# 技能深化闭环实验 — auto-fix 方法论技能注入（2026-08-13）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`
> 技能深化：失败任务 → 自检清单 + 溯源铁律 + 任务路径规划 + 破执三层/二阶段审查方法论（skill-craft，确定性无 LLM）

## 结果（本次实验，含门控改进前）

| 阶段 | 通过率 | 通过/总数 |
| --- | --- | --- |
| held-out baseline（无技能） | **80%** | 8/10 |
| held-out evolved（无门控全量注入） | **60%** | 6/10 |

## 归因（诚实标注）

1. **无门控全量注入有害**：所有 auto-* 技能完整模板注入 → 干扰模型措辞：
   - KNOW-04（baseline ✅ → evolved ❌，缺"预写日志"）
   - PLAN-03（baseline ✅ → evolved ❌，缺"索引"）
   - PLAN-04（两阶段 ❌，缺"先"）
2. **部分任务有增益**：CODING-04（baseline ❌ → evolved ✅）——方法论引导模型给出更完整实现；
3. **网络噪声**：MEM-02 evolved 121s（curl 超时）为假阴性，非技能影响；
4. 本次 train 阶段仅 PLAN-02 失败 → 生成 1 个方法论技能 `auto-fix-planning-plan-02`（验证器放宽后 train 大部分通过）。

## 改进（已实施）

- **门控注入**：`auto-fix-<family>-*` 只注入给同任务族（避免跨族误导）；`auto-induce-*` 仅取一句话描述（降低上下文噪声）。

## 结论

- 技能深化机制（自检+溯源+路径规划→skill）**完整跑通**：失败任务 → 方法论技能注册 → 注入 → 影响评测；
- 无门控注入**可能有害**（与 RSEA/PACE 文献结论一致：无 held-out 门控的上下文演化有风险）；
- 下一步：注入技能后仍需**质量门控**（只保留有增益的技能），而非全部注入。
