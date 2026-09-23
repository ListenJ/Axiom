# Laya 分诊输入（spec）

给 `bun run decide:laya` 用的决策输入。判定口径与三条写死的闸门见
`src/decision/laya-triage.ts`；模型侧只出概率、不做裁决。

```
bun run decide:laya -- --check                     # 探 WSL + venv + 权重是否可用
bun run decide:laya -- --spec docs/decisions/laya/verification-triage.json
bun run decide:laya -- --spec ... --run            # 只执行 AUTO 且已注册为可逆的动作
```

## state 的写法：只放可复算的事实

放命令退出码、条数、哈希、实测吞吐；**不放形容词**。理由不是风格：
实测该模型不推理输入里的数值（state 写明 `gain=0.000002`、`threshold=0.0025`，
问"增益是否高于最小可读数"它答 `noul=0.900`）。所以这些数字是给人核对的锚点，
不能指望它做算术。

## 字段

| 字段 | 含义 |
|---|---|
| `decisions[].id` | 必须与 `REVERSIBLE_ACTIONS` 的键一致，否则判为 AUTO 也无处执行 ⇒ 记 ESCALATE |
| `decisions[].domain` | `triage`/`escalation` 可问模型；`numeric`/`engineering` **连模型都不问**，直接升级 |
| `decisions[].irreversibleQuestions` | 选中的动作属不可逆/外写 ⇒ 无条件升级 |
| `decisions[].forbiddenAuto` | 即使 margin 够大也不得自动执行 |

`docs/decisions/laya/verification-triage.json` 里保留了两个本地只读核验
（`verify:typecheck`、`verify:runtime-audit`）和一条**故意放进来证明护栏有效**的
`release:tag-and-push`：它同时被标为 `engineering` 领域与不可逆，因此无论模型输出什么都必须
ESCALATE —— 这条的作用是"证明自动链不会去碰 git 推送"，不是待办。
