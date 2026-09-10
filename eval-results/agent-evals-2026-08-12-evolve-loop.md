# 评测→进化闭环实验 — deepseek-v4-flash（2026-08-12）

> 命令：`bun run src/agent-evals/run.ts --provider=opencode --model=deepseek-v4-flash --evolve`
> 流程：train(10) → held-out baseline(10) → selfInduce+promote → held-out evolved(10, 注入技能)

## 结果

| 阶段 | 通过率 | 通过/总数 |
| --- | --- | --- |
| baseline（无技能） | **80%** | 8/10 |
| evolved（注入技能） | **80%** | 8/10 |

**结论：闭环机制跑通，held-out 保持不退化（安全），但无净增益。**

## 分族（两阶段一致）

- knowledge / planning / tool-use / memory / self-evolve：100% 通过
- coding：0/2（CODING-03 网络慢 121s 噪声；CODING-04 模型未给出含 map/Set 的实现）

## 注册技能（质量瓶颈根因）

selfInduce（术语共现归纳）只注册了 1 个技能：

```json
{
  "id": "auto-induce-js",
  "description": "Pattern \"js\" appeared in 2 traces with 100% success; prefer it for similar tasks."
}
```

- 归纳出的是**高频词**（"js"），不是可操作的任务模式 → 注入后对评测任务无指导价值；
- 机制链路（轨迹→归纳→注册→注入→held-out）全部正常，瓶颈在**技能生成质量**（术语共现 vs 失败教训/验证器反馈）。

## 归因（诚实标注）

1. **无增益主因**：selfInduce 的术语共现归纳不适合多样评测任务（共同词少且泛）；
2. CODING-03 的 baseline 失败为网络噪声（121s），evolved 阶段通过（16.7s）——单次差异，不代表技能提升；
3. CODING-04 两阶段均失败：验证器仍要求 map/object/字典/hash 之一，模型回答未命中（真实内容缺失或表述差异）。

## 下一步（供参考）

- 技能生成升级：把**失败教训**（verify 失败原因）或**验证器反馈**纳入归纳，而非纯术语共现；
- 增加训练轨迹数量（当前 train 仅 10 任务），或按任务族分别归纳；
- 参考 SEAGym/RSEA 结论：无 artifact 普适赢家，进化目标应是"安全不退化 + 特定任务族增益"而非全局提升。
