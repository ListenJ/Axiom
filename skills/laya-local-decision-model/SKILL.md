---
name: laya-local-decision-model
description: 本仓库 Laya（421M ModernBERT 判别式 System-1 决策头，convaiinnovations 开源，同 Jev/TypeSafe AI 一类）的调用、Linux/WSL/HTTP 三种落点、爆炸半径登记、升级门槛，以及它不能用于何处与全自动审计链（bun run audit:chain）的用法。当需要给任务做分诊、决定某步骤是否自动执行、或跑全自动审计链时使用。数值推理、否定组合、跨措辞稳定性均不适合交给它。**Laya 只服务开发流程（分诊/审计/批量核查），严禁进入项目运行时（src/ 不得 import，守卫 tests/architecture-runtime-isolation.test.ts 锁死）。**
---

# Laya 本地决策模型（System-1 分诊 + 全自动审计链）

> 配套权威：`docs/decisions/ADR-008-laya-decision-chain.md`（含 2026-09-24 更正节，改判定前必读）
> 强制约束：AGENTS.md 规则 1/2/3；模型只能提高警觉、永远不能降低警觉

## 1. 它是什么（以及和 Jev 的关系）

`convaiinnovations/laya` 不是 LLM。它是 421M 的 ModernBERT-large **判别式** System-1 决策头，
非自回归、永不生成文本，输出 RLCD 训出的概率。Apache-2.0。

TypeSafe AI 于 2026-09-15 发布的 Jev 是同类闭源 "System One Model"（state + typed questions
→ typed decisions + calibrated confidence，代码里组合多个决策、用阈值划自治/升级线）。
本仓库把两者的通用用法收敛为同一套纪律：**state 只放可复算事实、问题按 key 索引、
阈值写死在代码、爆炸半径由登记表唯一决定** —— Laya 实测出的缺陷（见 §5）是 Jev 指南
"confidence 未校准时不得当置信度引用"的具体例证。调研底稿见
`docs/research/system-one-decision-model-skills-2026-09-25.md`。

## 2. 两种落点（按宿主选 runner，代码里已平台自适应）

| 宿主 | 模型侧 | runner |
| --- | --- | --- |
| Windows（本仓库开发机） | WSL2/Arch：venv `/root/.venvs/laya`，权重 `/root/models/laya`，CUDA | `createWslLayaRunner`（`wsl.exe -d Arch`） |
| Linux 原生 | 同版本 venv + 权重路径（`LAYA_PYTHON`/`LAYA_CKPT` 可覆盖） | `createLocalLayaRunner`（直调 python，不经 wsl.exe） |

`src/decision/laya-triage.ts` 的 `createPlatformLayaRunner()` 按 `process.platform` 选择；
换机只换 runner，裁定层不变。模型不可用 ⇒ 全体 UNAVAILABLE、零执行（宁可停下交人）。

## 3. 仓库内正式链路

- 模型侧：`scripts/laya/laya_gate.py` —— **只出概率，不做裁决**（改判定前先读 ADR-008 更正节）
- 裁定内核：`src/decision/laya-triage.ts`（三条闸门写死在代码，不受模型输出影响）
- CLI：`bun run decide:laya -- --check | --spec <json> [--run]`
- **全自动审计链**：`bun run audit:chain`（spec：`docs/decisions/laya/audit-chain-triage.json`）
  - 五个只读 stage：`audit:inventory`（文件清单/覆盖率分母）、`audit:vector-scan`（向量痕迹双通道）、
    `audit:claims`（声明提取）、`audit:determinism-scan`（扫描复跑比对）、`audit:laya-determinism`
    （同 spec 跨进程 N≥5 概率逐字节比对）
  - 只有判为 AUTO 且已登记的动作被执行；`release:tag-and-push` 故意登记为
    `engineering`+`external_write`，作用是**证明自动链不会去碰 git 推送**，不是待办
  - `--stages-only` 是人直接跑只读扫描的入口（不过模型闸）；自动化路径默认必须过闸
- 新增可自动执行动作必须同时补测试（ADR-008：注册即要求补测试）

## 4. 默认用 bf16

包内没有 dtype 开关（`amp_dtype: bf16` 是训练期配置），`laya_gate.py` 装载后转精度：
实测 `749 → 132 ms（5.65x）`，概率漂移 ≤ 0.0069，argmax 不变。

## 5. 能力边界（实测，不是猜测）

- **不推理输入里的数值**。state 写明 `gain=0.000002`、`threshold=0.0025`，问"增益是否高于
  最小可读数"它答 `noul=0.900`（正确应答否）。
- **不处理否定**。同一判断四种措辞得 `0.307 / 0.298 / 0.366 / 0.148`，反义问法与同义问法同向。
- **措辞敏感**。同一命题换个 state 写法可在 `0.30 ↔ 0.83` 之间翻面。
- **读不进嵌套 dict**。作为标注者用时要把 payload 序列化成自然语言状态。
- checkpoint 自带告警：`temperature_by_options` 含越界值 ⇒ `confidence` **不可当校准置信度引用**
  （与 Jev 指南的 confidence 警示同源）。

## 6. noul（需批准）头已被否证——不要用它做批准判据

10 个代码侧已知爆炸半径场景实测：`Spearman(tier, noul)=+0.41`、`min(tier3) < max(tier0)`，
**没有任何阈值能把"本地可逆"与"不可逆销毁"分开**。以 `noul>0.5` 升级不是保守，是常数——
闸门对所有输入一律 ESCALATE、自动化归零。现行设计：noul 只做**交叉核对留痕**，不改裁定
（`laya-triage.ts` 的 notes 字段）。

## 7. 升级门槛（可执行，不靠感觉）

爆炸半径由代码侧登记表决定，**按选项粒度、不按问题粒度**：
1. 选中**选项**登记为 `external_write` / `destructive` ⇒ ESCALATE，不看概率；
2. 未登记半径 ⇒ 同样 ESCALATE（登记表是唯一依据，未知动作不自动执行）；
3. `choice` top1−top2 < 0.15 ⇒ ESCALATE（模型自己拿不定，0.042—0.411 区间有区分度）；
4. 领域 `numeric` / `engineering` ⇒ **连模型都不问**，直接 ESCALATE。

半径取值：`local_reversible` / `preauthorized_spend` / `external_write` / `destructive`。

## 8. 不要拿它当审计标注者（第三 substrate 实测）

`chia-repo-audit/scripts/substrate_probe.py` 隐藏审计集实测：fact36 **1/36 = 0.0278**，
与两个生成式 LLM 的 κ = 0.138 / −0.500 / −0.057。它在模拟器逃逸用例上判对但
top1−top2 = 0.010，理由无验证器可识别。**换 substrate 买不到独立性：独立性是证据通道的
属性，不是模型族的属性。**

## 9. 网络（权重获取）

`huggingface.co` 直连超时时走宿主网关代理；权重可用 ModelScope `resolve/master/<path>`
直链（实测 ~100 MB/s）。WSL 为 NAT 模式，代理 IP 用 `ip route | awk '/default/{print $3}'` 取。

## 来源

- Laya：huggingface.co/convaiinnovations/laya（Apache-2.0，421M ModernBERT-large，typed decisions）
- Jev：TypeSafe AI 博客《Introducing System One Models & Jev》（2026-09-15）；
  LangChain / Hugging Face / dev.to / Fly.io 的 Jev 使用指南（2026-09）
- 本仓库实测：ADR-008 及其 2026-09-24 更正节；`docs/research/system-one-decision-model-skills-2026-09-25.md`

## 10. HTTP 落点与运行时隔离（2026-09-28 方向修正）

内网 Laya 决策服务（multilingual，契约唯一来源 `~/.axiom/axiom-secrets/laya-service.contract.md`）：
- **客户端**：`scripts/laya/laya-http.ts`（开发流程工具区）——单条/批量（≤500/批、结果保序、
  5xx/超时类失败项一次补跑）/健康探测/并发硬顶 8（>8 吞吐反降）/指数退避仅 429·5xx·网络（4xx 不重试）。
  基址 `LAYA_DECISION_URL` env（按规则 11 不入仓库）。
- **运行时隔离（硬边界）**：`src/` **不得** import 任何 Laya 模块——守卫
  `tests/architecture-runtime-isolation.test.ts` 锁死（R1 源码面 import 禁令 / R2 文件落点 /
  R3 生命周期脚本禁挂）。Laya 不进 per-message 热路径：4–5 QPS CPU 容量 + confidence 未校准，
  两条都使运行时接入既无容量纪律也无语义依据。运行时灰区初筛/显著性/意图分类由
  `src/local-llm` 边缘层（默认全关，显式授权）与确定性规则路径承担。
- **开发流程用法**：开发期批量判定/分诊/审计链 stage 用 `LAYA_DECISION_URL=… bun run decide:laya -- --spec <json> --run`；
  或直连 `bun run scripts/laya/laya-http.ts` 内的 API（import 自 `./laya-http.js`）。
  在线并发 1–2，批处理 4–8；`choice` 概率差 <0.15 视为拿不定（§7 升级门槛同样适用于 HTTP 落点）。
- **confidence 阈值标定**：闸 3 门槛（0.15）不再只靠 ADR-008 实测区间，用
  `bun run calibrate:laya -- --cases docs/decisions/laya/calibration-cases.template.json`
  （先人工填满 expected；域限 triage/review/batch，numeric/engineering 不标定不适用）
  产出 `calibration-cases.report.json`（命中率/margin 分布/门槛建议）；人工复核后
  才落回 `laya-triage.ts` 闸 3 常量。命中率 <0.9 的域建议为 null＝不可自动标定，维持人工。
