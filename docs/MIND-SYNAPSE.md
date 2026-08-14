# 神经突触心智模块（Synapse Mind Module）

> 日期：2026-08-15 ｜ 状态：已实现并测试 ｜ 位置：`src/dre/synapse/` ｜ MCP 工具：`mind_synapse_*`

## 摘要

心智模块以**神经突触网络**模拟大脑联想机制：节点（概念/技能/记忆/场景/目标）之间用带权突触连接；
激活时 Hebbian 式增强、全局轻微衰减（遗忘）；支持**扩散激活**（沿突触 BFS、强度随跳数衰减）——
即需求 2 中"扩散和独立思考"的确定性实现；对"场景 + 目标"给出可追溯的**下一步建议**。

核心约束：**全部写操作追加链式哈希验证链**（每条记录带 `prevHash`，篡改即失配），
因此数据"有可以校验的路径、可以追溯实现效果"（`mind_synapse_verify` / `mind_synapse_trace`）。
本地模型仅作**可选**增强（注入 `localModelAssist`），不配置时模块 100% 确定性、零网络依赖。

## 为什么叫"神经突触"

- **突触 = 边**：`Synapse` 连接两个节点（`sourceId → targetId`），带权重 `weight`（基础强度）、
  `activationCount`（激活次数）、`lastActivatedAt`（新鲜度）。
- **激活 = 使用即增强**：调用 `activate(sourceId)` 时，sourceId 的出边权重上调（Hebbian），
  其它突触轻微衰减（遗忘曲线）。
- **扩散 = 联想**：`spreadActivation(seedIds)` 从种子出发沿出边扩散，激活量 = `父激活 × spreadDecay^hop`，
  模拟"想到 A 就联想到 A 相关的能力"。
- **建议 = 决策**：`suggestNextSteps(scene, goal)` 对候选（场景/目标 token 命中 + 技能型常驻候选）
  按 `weight + 激活次数奖励 + 新鲜度奖励` 确定性排序，返回带 `via` 路径与理由的建议。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/dre/synapse/types.ts` | Synapse / SynapseTrace / SynapseSuggestion / SpreadResult 类型 |
| `src/dre/synapse/store.ts` | SQLite 持久化（WAL+busy_timeout）+ `verifyHash` 可校验 + 链式验证记录 |
| `src/dre/synapse/engine.ts` | SynapseEngine：创建/激活/扩散/建议/校验/追溯；可选本地模型增强 |
| `src/dre/synapse/index.ts` | 公共入口 |
| `src/mcp/server/mind-tools.ts` | MCP 工具 `mind_synapse_create/activate/spread/suggest/verify/trace` |

## 操作与效果

| 操作 | MCP 工具 | 效果 |
|------|----------|------|
| 创建突触 | `mind_synapse_create` | 建立 source→target 加权关联，返回 `verifyHash` |
| 激活 | `mind_synapse_activate` | source 出边权重上调、激活次数 +1、其余衰减 |
| 扩散 | `mind_synapse_spread` | 沿突触 BFS 联想，返回各目标激活量与跳数 |
| 建议 | `mind_synapse_suggest` | 按场景+目标给出 top-K 下一步建议（含理由与路径） |
| 校验 | `mind_synapse_verify` | 重算哈希比对 + 验证链完整性，返回 valid/reason |
| 追溯 | `mind_synapse_trace` | 返回该突触全部验证链记录（create/activate/spread/decay/suggest） |

## 配置

```bash
# .env.example
# 神经突触心智模块数据库（默认 ./data/synapse.db）
# AXIOM_SYNAPSE_DB=./data/synapse.db
```

本地模型增强（可选）：`createLocalModelAssist({ baseUrl, apiKey, model })` 返回一个
`localModelAssist` 函数，注入 `SynapseEngine` 后会在确定性建议基础上做重排/裁剪；
使用 OpenAI 兼容 `POST {baseUrl}/chat/completions`，`temperature=0` + 强约束 system 提示
（只允许重排/裁剪、不得新增事实）。不注入则完全确定性。

## 验证与测试

- `tests/dre-synapse.test.ts`（8 用例）：确定性 id、篡改暴露（可校验路径）、激活/衰减、
  扩散跳数衰减、建议排序、本地模型注入、WAL 持久化重开。
- 运行：`bun test tests/dre-synapse.test.ts`

## 追溯示例

```
mind_synapse_trace(synapseId) →
[
  { op: "create",  activation: 0.60, event: "createSynapse",            seq: 1 },
  { op: "activate", activation: 0.15, event: "user selected code scene", seq: 2 },
  { op: "decay",    activation: -0.01, event: "global decay (n synapses)", seq: 3 },
  { op: "suggest",  activation: 0.93, event: "scene=... goal=...",        seq: 4 },
]
```
每条记录 `hash = sha256(synapseId|seq|op|activation|event|timestamp|prevHash)`，全链可验。
