# ADR-014：运行时可扩展能力（自进化）的分域与处理

- 状态：接受（2026-10-09）
- 背景任务：Runtime 需要"按场景与实际使用自己添加功能"（自进化），且**不依赖 MCP / skill**。要求在 ADR-012（契约面）/ ADR-013（内核↔外围分域）之上，给出**分配**与**处理**规则，并对**高危 / 未授权操作 fail-closed**。
- 关联：`docs/decisions/ADR-012-kernel-boundary-and-api-contract.md`、`docs/decisions/ADR-013-kernel-periphery-partition.md`；实现落点在 `src/dre/runtime/capability-registry.ts`。

## 1. 决策（一句话）

运行时的扩展**单位**是"**能力**"= `CapabilityContract`（稳定契约，扩展点）× `CapabilityProvider`（契约实现，可新增/替换），由运行时**既有能力注册表**承载；**MCP / skill 只是可有可无的 provider，不是扩展机制**。分域沿用 ADR-013：**外围 provider 可运行时热加；内核能力只能"提案"，不得自动落核**。

## 2. 分配（放内核还是外围）

| 新能力画像 | 归属 | 谁能"加" | 隔离 |
|---|---|---|---|
| 冷门/可选/IO/边缘（新检索源、新摘要器、场景专用算法） | **外围 Provider** | 运行时**自动注册**（热加） | worker/sandbox |
| 高频 × 大 N × 在线延迟敏感 × 确定性/共享状态 | **内核能力** | 运行时**只能提案**，由内核门禁裁决 | in-process（受门禁） |

**裁决依据**：ADR-013 三维判据（频率 × 规模 × 延迟）。**关键**：内核承载共享可变状态与热路径，热补丁带来性能回退与不确定性，故**不自动改**；外围 provider 天然可替换，出进程隔离后最多拖慢自身路径。

## 3. 处理（自进化生命周期）

`Observe → Gap → Propose → Validate → Register/Promote → Retire`

1. **Observe**：以 contract 为维度采集（`recordResult` + 用量库）：频率、p50/p99、成功率、fallback 率；
2. **Gap**：某 contract 无 provider / fallback 高 / 延迟超预算 ⇒ 能力缺口；
3. **Propose**：产出 provider 规格 `{ contract, 实现, 估 cost/latency, sideEffects, isolation }`；
4. **Validate**：过 `src/eval` + 安全（能力声明、沙箱、超时）——**不过不注册**；
5. **Register（外围）**：`registerDynamicProvider()`；**Promote（内核）**：只 `proposeCapability()`，由门禁决定；
6. **Retire**：长期未用/成功率低 ⇒ `unregisterProvider` 或降级；契约本身不删（ADR-012：MINOR 只增）。

## 4. 安全模型（fail-closed，最高优先）

`registerDynamicProvider(provider, { authorized })` 的强制规则：

1. **内核不得自动注册**：`placement==="kernel-proposal"` ⇒ **拒绝**（只能 `proposeCapability()`）；
2. **无声明即不可信**：未声明 `sideEffects` ⇒ **拒绝**；
3. **高危须授权**：命中 `HIGH_RISK_CAPABILITIES`（`proc.exec/fs.write/fs.delete/cfg.write/db.write/net.outbound/mcp.external`，词表见 `src/utils/permissions.ts`）且 `authorized!==true` ⇒ **拒绝**；
4. **高危须隔离**：含高危能力仍 `isolation==="in-process"` ⇒ **拒绝**（须 `worker`/`sandbox`）。

拒绝一律抛 `CapabilityRegistrationError`（不静默降级）。内核提案 `proposeCapability()` **只记录、不注册、不执行**。

## 5. 与既有代码的接点

| 环节 | 复用/新增 |
|---|---|
| 契约 + Provider | `src/dre/runtime/capability-registry.ts`（`CapabilityProvider` 增 `placement`/`isolation`/`sideEffects`/`source`） |
| 自扩展注册 | **新增** `registerDynamicProvider()`（严格守卫）/ `proposeCapability()` / `listKernelProposals()` |
| 高危词表 | `src/utils/permissions.ts` 的 `HIGH_RISK_CAPABILITIES`（与 `risk-monitor` 同源） |
| 观测/教训 | `src/self-evolve/`（think/store/retrieve） |
| 验证 | `src/eval`、`src/agent-evals` |
| 隔离 | `src/sandbox` / terminal 审批门 |

## 6. 强制与验证

- `tests/unit/capability-self-extension.test.ts`：7 条 fail-closed 断言（内核不自动注册、未声明拒绝、高危未授权/未隔离拒绝、外围可热加、提案不落核）。
- 依赖方向由 ADR-012（外围→内核只经契约）/ ADR-013（内核不得依赖外围）门禁守护。

## 7. 待办

1. ✅ **已完成（2026-10-09）**：`Observe→Gap` 接上真实用量——`search` 对「无 provider」的契约记 miss；`analyzeGaps()` 产出 `no-provider` / `low-success` 缺口（依据 `recordResult` 的 usageCount/successRate）。**只报告，不自动注册**；缺口可经既有 `proposeCapability()`（内核）或外围热加处理。
2. ✅ **已完成（2026-10-09）**：`src/dre/runtime/capability-isolation.ts` 的 `runIsolated()` + 注册处「可执行体须匹配 isolation」校验——**运行期强制隔离**（in-process `invoke` / worker 子进程 JSON 往返 / sandbox 经 `executeInSandbox`），声明了隔离却无可执行体即拒绝，**不退回进程内**；`invokeCapability()` 按声明执行并记录结果。
3. ✅ **已完成（2026-10-09）**：`GET /version` 的 `runtime.serviceableContracts` 暴露"有 ≥1 provider 可服务"的契约清单（`capabilityRegistry.listContracts()`，实况；当前无 provider → 空数组）；契约 MINOR 1.2.0→1.3.0。
4. ✅ **已完成（2026-10-09）Validate 接线**：内核侧 `capabilityRegistry.admitCapability(provider,{validator})`——**验证通过才注册**，缺验证器/未过/抛错一律 fail-closed 拒绝；内核只声明 `CapabilityValidator` 接口、**不 import `src/eval`**（避免内核→外围依赖）。外围层 `src/eval/capability-validator.ts` 的 `createEvalCapabilityValidator()` 把 `src/eval` 评测包装成验证器（评测不可用/无样例/抛错 → 拒绝）。
