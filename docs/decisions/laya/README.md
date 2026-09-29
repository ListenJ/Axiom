# Laya 分诊输入（spec）

给 `bun run decide:laya` 用的决策输入。判定口径与三条写死的闸门见
`src/decision/laya-triage.ts`；模型侧只出概率、不做裁决。

```
bun run decide:laya -- --check                     # 探落点：LAYA_DECISION_URL 已配置探 HTTP /health/live，否则探 WSL + venv + 权重
bun run decide:laya -- --spec docs/decisions/laya/verification-triage.json
bun run decide:laya -- --spec ... --run            # 只执行 AUTO 且已注册为可逆的动作
```

## state 的写法：只放可复算的事实

放命令退出码、条数、哈希、实测吞吐；**不放形容词**。理由不是风格：
实测该模型不推理输入里的数值（state 写明 `gain=0.000002`、`threshold=0.0025`，
问"增益是否高于最小可读数"它答 `noul=0.900`）。所以这些数字是给人核对的锚点，
不能指望它做算术。

## 标定与漂移套件（confidence 不可当正确率用）

Laya 的 `confidence` 是分布置信度（checkpoint 自带 temperature 告警），阈值必须按业务标注标定：

```
bun run calibrate:laya -- --cases docs/decisions/laya/calibration-cases.template.json
#   人工填满 expected 后运行 → 按域输出命中率/margin 分布/门槛建议（命中率<0.9 ⇒ null＝人工域）
bun run calibrate:laya -- --drift docs/decisions/laya/drift-suite.json [--strict]
#   label-free 措辞稳定性探针 → choice 一致性 + margin 极差（稳定性带 0.15）
```

2026-09-28 漂移基线（`drift-suite.drift-report.json`）：6 命题中 4 个不稳定——
可逆修复题在措辞变体下翻面、阈值比较题在 above/below 间翻面。**结论：numeric/engineering
域走闸 4（不问模型），自动化裁定对不稳定命题走人工或固定措辞模板。**

## 字段

| 字段 | 含义 |
|---|---|
| `decisions[].id` | 必须与 `REVERSIBLE_ACTIONS` 的键一致，否则判为 AUTO 也无处执行 ⇒ 记 ESCALATE |
| `decisions[].domain` | `triage`/`escalation` 可问模型；`numeric`/`engineering` **连模型都不问**，直接升级 |
| `decisions[].optionBlastRadius` | **选项 → 爆炸半径**。按选项判、不按问题判：一道题里有外写选项，不等于模型选中的那个是外写 |
| `decisions[].actionBlastRadius` | 纯 `noul`/`score` 题没有选项可登记，于是登记**该决策闸住的动作本身**的半径 |
| `decisions[].forbiddenAuto` | 即使 margin 够大也不得自动执行的**选项** |

半径取值：`local_reversible` / `preauthorized_spend` / `external_write` / `destructive`，
后两档一律升级。**未登记即升级** —— 登记表是判定的唯一依据，半径未知的动作不允许自动执行。

> 口径变更（2026-09-24）：原来的 `irreversibleQuestions` 按**问题**登记，会把模型选中的
> 最低不可逆选项连带判成外写；`noul > 0.5` 也不再作为升级条件 —— 实测 noul 与爆炸半径
> 分不开（Spearman +0.41、`min(tier3) < max(tier0)`），拿它裁定等于给闸门加常数
> （一切都升级、自动化归零）。现在 noul 只做**交叉核对**：与登记表不一致时在
> `notes` 里留痕，不改裁定。

`docs/decisions/laya/verification-triage.json` 里保留了两个本地只读核验
（`verify:typecheck`、`verify:runtime-audit`，半径均为 `local_reversible`）和一条**故意放进来证明护栏有效**的
`release:tag-and-push`（`engineering` 领域 + `external_write` 半径）：无论模型输出什么都必须
ESCALATE —— 这条的作用是"证明自动链不会去碰 git 推送"，不是待办。
