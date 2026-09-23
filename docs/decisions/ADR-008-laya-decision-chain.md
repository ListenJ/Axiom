# ADR-008：Laya 本地决策头接入执行链 —— 模型只能升级警觉，不能降低警觉

- 日期：2026-09-23 ｜ 状态：**已采纳并落地**（`src/decision/`，16 条单测 + 端到端实测） ｜ 决策人：项目经理（用户授权"按你的想法开始完成"）
- 背景：本机 WSL2/Arch 已部署 `convaiinnovations/laya`（421M ModernBERT **判别式** System-1 决策头，非自回归、不生成文本）。目标要求"用 Laya 与本项目完成决策-执行链条"。实测它有三项硬缺陷：不推理输入中的数值、不处理否定、措辞敏感（同一命题换写法在 `0.30 ↔ 0.83` 间翻面）；且 checkpoint 自带告警称 `temperature_by_options` 有越界值 ⇒ 其 `confidence` **不可当校准置信度引用**。

## 决定

1. 模型**只被允许提高警觉**。`src/decision/laya-triage.ts` 的闸门写在代码里、不受模型输出影响：
   登记表给出的**爆炸半径**属 `external_write`/`destructive` ⇒ ESCALATE，未登记半径 ⇒ 同样 ESCALATE（未知动作不自动执行）；`choice` 的 top1−top2 < 0.15 ⇒ ESCALATE。
   模型没有任何能把 ESCALATE 改成 AUTO 的路径；`noul` 只做交叉核对留痕，不参与裁定（理由见文末更正节）。
2. 失败方向一律**不是放行**：runner 抛错/超时/禁用 ⇒ `UNAVAILABLE`，`decideAndRun` 对 UNAVAILABLE 不执行任何动作；判为 AUTO 但没有注册动作 ⇒ 记 ESCALATE 而非静默丢弃。
3. 领域封杀先于调用：`numeric` / `engineering` 的决策**连模型都不问**，直接 ESCALATE。这条把实测缺陷变成结构约束。
4. 可自动执行的动作面**只有本地只读核验**（`verify:typecheck`、`verify:runtime-audit`）。不存在"删数据/推送/花额度"出口 —— 想让链条做这些，必须先在 `REVERSIBLE_ACTIONS` 注册，而注册即要求补测试。
5. 模型侧脚本入库为 `scripts/laya/laya_gate.py`，只负责如实输出原始概率，**裁决集中在被测试覆盖的 TS 层**（避免两处口径漂移）。

## 理由

- 深模块（规则 8）：判定内核一处（`laya-triage.ts`），runner 经依赖注入 —— 测试用 fake、生产用 WSL 真调，两个适配器都是真的。
- 实测过的失败模式比设计原则更有说服力：`isPathSafe` fail-open 那类"看起来安全实则静默"的坑，本仓库已有先例登记（§2.7.5），所以 UNAVAILABLE 必须与 AUTO 在类型上就是不同分支。

## 备选与否决理由

- **让 Laya 直接给动作打分并取最高分执行**：否决。它措辞敏感且不做数值推理，取 argmax 等于把工程结论交给一个已知会翻面的信号。
- **让模型置信度覆盖闸门阈值**：否决。等于把不可逆操作的最终裁量权交给被登记为"confidence 未校准"的字段。
- **裁决逻辑同时写在 Python 与 TS 两侧**：否决。两份口径必然漂移，本仓库刚为同类问题（命令危险判据两份清单）付出过 R3-B 的返工。

## 后果与验证

- (+) 决策-执行链条可用：`bun run decide:laya -- --check` 实测 `{laya_import:true, ckpt_exists:true, typed_decisions:true}`；`--spec` 实测两条只读核验判 AUTO、`engineering` 那条 ESCALATE；`--run` 实测 `EXECUTED verify:typecheck ok=true`、`EXECUTED verify:runtime-audit ok=true`、`ESCALATED release:tag-and-push`（未被执行）。
- (+) 链条的失败方向可测：`tests/unit/laya-triage.test.ts` **19 pass / 0 fail**，含"runner 抛错时被领域封杀的决策仍是 ESCALATE"。
- (-) 链条依赖 WSL + GPU + `/root/models/laya`；缺任何一环 ⇒ 全体 UNAVAILABLE（不会误放行，但也不会自动推进）。这是刻意的：宁可停下交人。
- (-) `questions` 必须是**以 key 索引的对象**，传字符串数组会被库内 `list.keys()` 打回（施工中真实踩到并修）；这层形状约束目前靠 TS 类型 + spec 样例，无运行时校验。
- 回退：`src/decision/`、`scripts/laya/`、`tests/unit/laya-triage.test.ts` 均为新增文件，整体 revert 不影响既有链路；默认无任何生产路径调用它（未接进 `defaultToolGuard`），因此对现有行为零影响。

## 更正（2026-09-24）：两条闸门建在被否证的信号上，已改写

本 ADR 初版的闸门 1 与 3 与同期落在技能库里的实测结论互相矛盾，属"文档说不、代码做是"。逐条：

1. **`irreversibleQuestions` 按问题登记 ⇒ 错**。它把"这道题里存在外写选项"当成"选中的动作是外写"，于是模型即便选中可逆性最低的那个选项，也会被连带判成外写动作。实测证据：造 10 个代码侧已知爆炸半径的场景量 noul 与 tier 的关系，得 Spearman(tier, noul)=+0.41（n=10）且 `min(tier3) < max(tier0)` —— 没有任何阈值能把"可逆本地"与"不可逆销毁"分开；具体反例是 `edit_submission`（真外写）0.126 低于"本地可逆改写、原件留在 git 历史"0.160。
   ⇒ 改为**按选项登记** `optionBlastRadius`，并对纯 noul/score 题补 `actionBlastRadius`；**未登记半径一律升级**（登记表是唯一依据，未知动作不得自动执行）。
2. **`noul > 0.5 ⇒ ESCALATE` ⇒ 撤下裁定权**。既然 noul 与爆炸半径不可分，把它当批准判据不是保守而是**常数**：闸门会对所有输入都 ESCALATE，"自动化"归零，而人并未因此多看到模型真正拿不准的地方。建立在被否证信号上的规则要换掉，不是调阈值。
   ⇒ noul 现在只做**交叉核对**：与登记表结论不一致时写进 `TriageResult.notes`（CLI 会打印），不改裁定。
3. 本文件与 `laya-triage.ts` 头注释都写过"与 `scripts/laya/laya_gate.py` 同口径"，实测该 Python 脚本里没有任何阈值或裁定（它只出原始概率）。措辞已改为"模型侧只出概率，裁定全部在 TS 层"。

**改动的保守性核对**：剥掉 noul 的升级权会降低警觉吗？不会 —— 可执行面从来不由模型决定：`decideAndRun` 只认 `REVERSIBLE_ACTIONS` 里注册的键（当前仅两条本地只读核验），且现在多了"半径未登记即升级"这条更严的默认。实测改后端到端结果与改前一致：`--check` 三项全 true；`--spec` 仍 2 AUTO + 1 ESCALATE；`--run` 仍 `EXECUTED verify:typecheck ok=true`、`EXECUTED verify:runtime-audit ok=true`、`ESCALATED release:tag-and-push`（未执行）。测试由 16 增至 **19**，新增的三条正是上述 1/2 的反例形状（含"同一题选中可逆选项不得升级"与"纯 noul 决策漏登记必须 ESCALATE"）。

**同轮连带修的一处回归**：上一轮提交把两条**本来是绿的**架构门改红了 —— `src/decision/*` 直接读 `process.env.LAYA_*`（该门要求统一走 `utils/env.ts`，硬零容忍）与 `laya-cli.ts` 的 6 处 `console.log`。前者已改为 `readString(...)`；后者按门内既有约定处理（CLI 入口的 console 输出即交付物，`cli.ts`/`eval-cli.ts` 等 8 个同形入口已在白名单里）。教训：改完 `src/` 只跑 doc-contract + `audit:runtime` 不够，必须连 `architecture-integrity` 一起跑，且看 offender 而不是只看红条数。
