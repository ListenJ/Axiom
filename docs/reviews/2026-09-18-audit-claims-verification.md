# 审计结论复核：Runtime /「意识层」相关 7 条引用结论的逐条核验（2026-09-18）

> **摘要**：对上一轮审计摘要中被引用的 7 条运行时/意识层结论做**独立复核**。
> 结论：**3 条成立**（其中 1 条 High 未修）、**2 条不成立**（对象已不存在 / "静默"描述与实现不符）、
> **2 条部分成立**（相关修复已落地，但引用时的状态已过期）。**不存在**"整体还不错"这类判断——
> 每条均附 `文件:行号` 与关键代码。
> **方法**：静态代码追踪 + 现存测试实测 + 交叉引用 `docs/LIMITATIONS.md` §5。凡无法定位到代码的，标"未验证"。

---

## 0. 核验范围与口径

- **被核验对象**：上一轮审计摘要中列出的、据称存在于本项目的运行时/共识/状态层缺陷。
- **口径**：本复核对**当前 HEAD**（`89ea295`，分支 `codex/knowledge-unify-2026-09-17`）负责。
  历史分支（`feature/cognitive-runtime` 等）上的代码**不计入**本判定——本报告只回答"现在的仓库里是不是这样"。
- **裁定级别**：成立 / 部分成立 / 不成立 / 无法验证。

---

## 1. 逐条核验总表

| # | 引用的审计结论 | 裁定 | 一句话依据 |
| --- | --- | --- | --- |
| C1 | `ConsensusEngine` 共享可变状态、无锁 | **不成立**（对象已不存在） | `src/main.ts:242-243` 明示 ConsensusEngine 属"已移除"的休眠组件；全仓无实现 |
| C2 | 异常投票**静默**转弃权 | **不成立** | `src/agents/cross-validator.ts:182-188` 分发异常有 `logger.warn` 且票面 fail-closed |
| C3 | `CognitivePipeline` 的锁**没有超时会永久卡死** | **成立 → 已于 2026-09-19 修复（方案A）** | 原判据 `cognitive-pipeline.ts:72,96-106`（布尔锁 + 无 deadline 轮询）；修复见 §2 的 C3 条目 |
| C4 | 节点 ID 用 `Math.random()` | **成立**（知识写入路径已修） | `docs/LIMITATIONS.md` §5.3⑤ 清单；已修处见 §5.3⑧ |
| C5 | `WorldState` 用固定 key 覆盖历史 | **部分成立**（核心已修） | `src/dre/runtime/world-state.ts:179-203` 已加 revision + 历史；通用 `set()` 与固定 key 仍覆盖（部分属设计） |
| C6 | 无稳定 tie-breaker | **部分成立**（已收敛） | 6 处排序点已带次级键；本轮补修 `src/dre/retrieval/hybrid-fusion.ts:181` |
| C7 | 约束校验漏字段 | **不成立** | `src/dre/runtime/world-state.ts:56-70,180-182,233-242` 已逐字段校验；`cognitive-pipeline.ts:124-130` 有配套修复 |

---

## 2. 逐条证据

### C1 — `ConsensusEngine` 共享可变状态无锁 → **不成立**

`src/main.ts:240-243`：

```ts
// P2-S2 幽灵裁剪：仅保留已接线组件——thompsonRouter（S4 学习回路）与
// hallucinationDetector（S5 启动自动校准的消费者，见下方 calibrateFromStored）；
// 休眠的 VIBCompressor/ConformalRetriever/MathEnhancedMemory/ConsensusEngine 与
// 重复 RateDistortionCompressor 实例已移除（生效实例在 components/token-budget.ts）。
```

全仓检索 `ConsensusEngine` 仅命中该**注释**（另有 `docs/` 历史文本），无类/函数实现。
**判定**：该结论对**当前仓库**不成立——它描述的是一个**已被删除**的组件。
**风险提示**：若该结论来自 `feature/cognitive-runtime` 等历史分支（见 §4），则"当前代码有该缺陷"的说法**不可引用**。

### C2 — 异常投票**静默**转弃权 → **不成立**

`src/agents/cross-validator.ts:182-188`：

```ts
} catch (e) {
  // S5 告警铁律（对齐 S-A8 切片 7）：分发异常不得静默，票面降级 abstain 同时留 warn
  logger.warn(
    `[CrossValidator] dispatch threw for role ${role} (fail-closed abstain): ${e instanceof Error ? e.message : String(e)}`,
  );
  votes.push({ model: `role:${role}`, verdict: "abstain" });
}
```

且弃权票**不会**静默放行——`aggregateVotes` 对有效票不足走 fail-closed（`:66-70`）：

```ts
if (valid < MIN_VALID_VOTES) {
  return { ...base, outcome: "insufficient", finalVerdict: null, needsArbitration: true };
}
if (agree === disagree) {
  return { ...base, outcome: "tie", finalVerdict: null, needsArbitration: true };
}
```

**判定**："异常→abstain"这一**机制**存在，但"**静默**"不成立：有 warn 日志、且后果是 `finalVerdict=null` 交仲裁（fail-closed），不是"静默丢失"。

### C3 — `CognitivePipeline` 锁无超时会永久卡死 → **成立（High）→ 已于 2026-09-19 修复（方案A）**

`src/dre/pipeline/cognitive-pipeline.ts:72`：`private pipelineLock = false`（布尔，非信号量/互斥量）

`src/dre/pipeline/cognitive-pipeline.ts:96-106`：

```ts
if (this.pipelineLock) {
  logger.warn("[CognitivePipeline] Concurrent run detected, queueing")
  await new Promise<void>((resolve) => {
    const check = () => {
      if (!this.pipelineLock) resolve()
      else setTimeout(check, 100)
    }
    check()
  })
}
this.pipelineLock = true
```

**两个独立缺陷**：
1. **无 deadline**：等待循环不设上限。若持锁那次 `run()` 的内部 await **永不 settle**（如下游工具/网络挂死），
   则**所有后续 `run()` 永久阻塞**（100ms 轮询、无超时、无降级），且**不可取消**。
2. **互斥不成立（check-then-act 丢失唤醒）**：多个等待者各自 100ms 轮询，锁释放那一刻可能有**多个**
   waiter 在 `:100` 同时观察到 `!pipelineLock` 而 `resolve()`，其后各自在 `:106` 置 `true` 并**并发执行**。
   即该"锁"在竞争下退化为"乐观并发"，而它本意是串行化。

**影响**：一条挂死的流水线可让整个认知层失去响应；竞争下共享的 `worldState` / `reasonBus` 写入可能交叠。
**是否已有缓解**：**无**。`:268`/`:274` 在成功与 catch 两路释放，但**不覆盖**"内部 await 永不返回"的情形。

**修复（2026-09-19，方案A —— 原子式 FIFO 票据链 + 有界等待 + 单点释放）**：

替换为按下标排队、**无轮询**的票据链（`cognitive-pipeline.ts` 的 `acquireGate()` / `lockChain`）：

```ts
const prev = this.lockChain
// ↓ 以下两条语句之间无 await：在事件循环内不可被打断 ⇒ 原子入队（FIFO）
this.lockChain = prev.then(() => ticket)
...
const acquired = await Promise.race([prev.then(() => true as const), timedOut])
if (!acquired) { void prev.then(() => release()); return null }   // 超时也要归还票据
```

- **互斥**：入队是同步原子的（读/写 `lockChain` 之间无 `await`），不存在两个调用者同时自认第一的窗口 ⇒ 实测**最大并发 = 1**。
- **有界等待**：超时（默认 30s，可经 `AXIOM_COGNITIVE_LOCK_TIMEOUT_MS` 或构造参数 `lockTimeoutMs` 覆盖）→
  `fail-closed` 降级返回 + `logger.warn`（不再永久阻塞、可取消）。
- **不泄漏队列**：超时者**仍在自己轮到时归还票据** —— 否则链尾被永久堵死（TDD 用例 3 专测这一点）。
- **单点释放**：解锁移入 `finally`，覆盖正常返回 / 异常 / 未来新增的提前 `return`（旧实现把解锁散落两处）。
- **可观测**：新增 `getGateStats()`（在闸门区调用数 / 累计超时 / 当前上限），由用例断言。

**TDD 证据**：新增 3 个用例，修复前 `tests/cognitive-pipeline.test.ts` = **20 pass / 1 fail**
（失败项为"持锁者永不 settle 时等待者必须在超时内返回"，实测 `Received: "timeout"` 等待 2s 未返回），
修复后 **21 pass / 0 fail**；全量 **4097 pass / 36 skip / 0 fail**。
**未覆盖**：跨进程/多实例并发（本闸门是**进程内**语义）；分布式锁不在本轮范围。

### C4 — 节点 ID 用 `Math.random()` → **成立**

见 `docs/LIMITATIONS.md` §5.3⑤ 的逐文件清单（该清单由 `tests/unit/determinism-disclosure.test.ts` 持续校验不漂移），
例如 `src/dre/reasoning/graph.ts:104,120,148,176,319`、`src/dre/runtime/scheduler.ts:118`、
`src/dre/runtime/knowledge-network.ts:164,338,368,397,605` 等约 18 处仍为 `Date.now()`+`Math.random()` 组合。
**已修**：知识写入路径 `src/dre/port/knowledge-port.ts:261`（内容寻址 `deriveNodeId()`，§5.3⑧）。
**判定**：成立；"是否需要全部改"取决于各 ID 是否进入确定性输出——**§5.5 第 1 条已声明这尚未逐点判定**。

### C5 — `WorldState` 用固定 key 覆盖历史 → **部分成立**

**已修部分**：`src/dre/runtime/world-state.ts:179-203`（`setBelief`）引入 `revision` 递增 + 追加式 `BeliefTransition` 历史（有界 `BELIEF_HISTORY_MAX=500`），
文件头注释明确此为"审计修复"。且有 12 个用例把守：`tests/unit/world-state-consistency.test.ts`（本地实测 12 pass / 0 fail）。

**仍成立部分**：
- 通用 `set(path, value)`（`:90-110`）本质是 KV 覆盖语义——**设计如此**（版本号 `version` 递增可观测），非缺陷。
- `src/dre/pipeline/cognitive-pipeline.ts:254`（`cognitive.pipeline.result`）与 `:262`（`setGoal("current", …)`）
  仍用**固定 key**，注释写明"固定 key 避免无限增长"——属于**有意的取舍**（牺牲历史换有界）。

**判定**：引用时"会静默覆盖、下游无法区分稳态与翻转"的描述**已过期**（belief 路径已修）；
但"固定 key 覆盖历史"作为**设计取舍**在 pipeline 层仍存在，应记为 Info 而非缺陷。

### C6 — 无稳定 tie-breaker → **部分成立**

- 6 处排序点已带次级键，例如 `src/dre/runtime/world-state.ts:224`：
  `.sort((a, b) => b.confidence - a.confidence || a.beliefId.localeCompare(b.beliefId))`
- 本轮补修 `src/dre/retrieval/hybrid-fusion.ts:181`（详见 `docs/LIMITATIONS.md` §5.3③）。
- **限制**：所有 tie-breaker 均为 `localeCompare`，其确定性仅在**同 locale / 同 ICU 版本**内成立（§5.3②）。

### C7 — 约束校验漏字段 → **不成立**

`src/dre/runtime/world-state.ts:56-70` 定义 `assertConfidence`（有限数 + [0,1]）与 `assertNonEmpty`；
`:179-182`（setBelief 三字段）、`:150-158`（setGoal）、`:233-242`（setHypothesis）逐字段调用。
配套修复见 `src/dre/pipeline/cognitive-pipeline.ts:124-130`（空输入不再写入空目标，注释记录"实测 trace 长度从 6 掉到 1"的回归）。

---

## 3. 需要行动的项目

| 级别 | 项 | 位置 | 为什么现在就要处理 |
| --- | --- | --- | --- |
| ~~High~~ | ~~C3 认知管道锁无超时 + 互斥不成立~~ | `src/dre/pipeline/cognitive-pipeline.ts`（原 :72,96-106） | **已于 2026-09-19 修复（方案A）**，见本节 C3 修复记录 |
| Medium | C4 其余 ~18 处 `Math.random()` ID 未判定是否进入输出 | `docs/LIMITATIONS.md` §5.5① | 不判定就无法给出"确定性"的完整结论 |
| Info | C5 pipeline 层固定 key | `cognitive-pipeline.ts:254,262` | 设计取舍，需在文档登记而非当作缺陷 |

---

## 4. 未验证 / 无法验证项（如实登记）

1. **历史分支上的同名缺陷未核验**：`gitea/feature/cognitive-runtime`(+56)、`feature/runtime-integration`(+42)、
   `feature/runtime-kernel`(+27) 三条分支相对 HEAD 落后 1422 个提交，**未逐文件核验**其内容。
   若上述 C1/C2 结论出自这些分支，需**单独**对该分支出具报告，不能与本报告的"当前仓库"判定混用。
2. ~~**C3 未做挂死复现**~~ → **已补**：2026-09-19 用"`consciousnessStep` 首次调用返回永不 settle 的 Promise"
   作为最小复现（`tests/cognitive-pipeline.test.ts` 并发闸门用例 2），修复前实测等待 2s 仍未返回（红），
   修复后 60ms 内 fail-closed 返回（绿）。原"触发条件是推断"的保留意见**已消除**。
3. **C4 的"是否进入输出"未逐点判定**（同 `docs/LIMITATIONS.md` §5.5 第 1 条）。
4. 本报告**未覆盖** `src/` 中与运行时无关的目录；判定范围严格限于上述 7 条引用结论。
