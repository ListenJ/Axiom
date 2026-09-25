# 计划：MCP 真懒加载 + 执行沙箱统一层（2026-09-18）

- **分级**：T3（接口变更 + 安全边界重构）。按总则 0.3 需书面计划 + 回滚方案 + 影响面清单。
- **分支**：`codex/knowledge-unify-2026-09-17`（延续当前工作分支）。

## 任务契约

```
任务:
  1) MCP 真懒加载：tools/list 在懒加载模式下只返回固定小工具面，
     其余工具定义在未被显式请求前不进入客户端上下文。
  2) 执行沙箱统一层：把散落在各模块的路径/命令/URL 校验收敛为单一收口点，
     所有 MCP 工具执行前必经该收口点。

验收标准:
  T1-1 AXIOM_MCP_LAZY_TOOLS=1 时，真实 MCP 握手后 tools/list 返回工具数 ≤ 5。
  T1-2 懒加载模式 tools/list 序列化字节数相对全量模式下降 ≥ 95%（实测，非估算）。
  T1-3 tool_search 可按关键词检索到全量工具（含非暴露工具不返回）。
  T1-4 tool_describe 返回目标工具的完整 inputSchema（与全量模式逐字段一致）。
  T1-5 tool_invoke 真实执行目标工具，且仍经过同一安全守卫（守卫生效性以用例证明）。
  T1-6 默认（未设 env）行为不变：tools/list 与改动前逐字节一致（工具数 188）。
  T2-1 存在唯一收口函数，MCP 工具执行前必经；未经过直接执行会被拒绝。
  T2-2 已知缺口 workspace-snapshot 的裸 fs 写入被收口覆盖（红→绿用例）。
  T2-3 收口语义与既有 utils/path-safety + utils/permissions 一致（不引入第二套语义）。
  T2-4 全量测试基线不回归（4049 pass / 0 fail）。

改动清单（文件级）:
  src/mcp/tool-registry.ts        — 懒加载模式 + meta 工具（tool_search/describe/invoke）
  src/mcp/server.ts               — 从 env 读取懒加载开关并注入 registry
  src/sandbox/execution-guard.ts  — 新增：唯一执行收口点（路径/命令/URL）
  src/sandbox/index.ts            — 导出收口点
  src/mcp/tool-registry.ts        — 守卫改为委托收口点（单点收口）
  src/mcp/tools/workspace-snapshot.ts — 补收口校验（T2-2 缺口）
  tests/mcp-lazy-tools.test.ts    — 新增：T1-1..T1-6
  tests/execution-guard.test.ts   — 新增：T2-1..T2-3
  docs/operations-log.md          — 规则 5 留痕

不做项:
  - 不改任何既有工具的业务实现（除 workspace-snapshot 补校验）。
  - 不做 notifications/tools/list_changed 动态注册（客户端支持不一致，收益不确定）。
  - 不改 HTTP 路由层 /sandbox/execute 语义（不在本次验收范围）。
  - 不引入新依赖。
  - 不改 AGENTS.md 与既有 ADR。

验证命令:
  bun test tests/mcp-lazy-tools.test.ts tests/execution-guard.test.ts
  bun test tests/mcp-server.test.ts tests/tool-registry-dedup.test.ts tests/unit/docs-consistency.test.ts
  bun test --parallel=8 --timeout 15000 ./tests

风险/回滚:
  风险1 懒加载默认开启会改变既有客户端可见工具面 → 缓解：默认关闭，需显式 AXIOM_MCP_LAZY_TOOLS=1。
  风险2 tool_invoke 成为新的通用执行入口，可能绕过按工具名的审计/统计 → 缓解：invoke 内部调用同一 handler 链（守卫包装在 handler 上），并记录目标工具名。
  风险3 收口点收紧可能误拒既有合法调用 → 缓解：只做「与现状同语义」的收敛 + 补缺口，不新增拒绝规则；全量测试作为回归门禁。
  回滚：单分支内 revert 对应提交即可；未触碰数据/存储格式，无迁移。
```

## 影响面清单

| 面 | 影响 |
| --- | --- |
| MCP 协议面 | 新增 3 个 meta 工具（仅懒加载模式）；默认模式协议面不变 |
| stdio / HTTP 传输 | 共用 `ToolRegistry.registerWithMcp`，两侧同时生效 |
| 安全守卫 | `defaultToolGuard` 改为委托 `execution-guard`，语义保持 |
| 工具总数 | 不变（`src/testing/tool-count.ts` 仍为 188，meta 工具不计入既有统计口径） |
| 依赖 | 无新增 |

---

## 执行后偏差记录（复查用，按规则 12 回 Plan）

计划冻结后执行时出现的偏移，逐条记录原因与影响：

1. **T2-2 的"红→绿用例"改为代码审查 + 既有套件背书**
   计划要求为 workspace-snapshot 缺口写一条红→绿用例。执行时确认：`revertSnapshot` 的写入位置来自
   快照仓库的 `git ls-tree` 输出，而 **git tree 路径在结构上不可能包含 `..` 组件**，因此无法构造出
   一个"删除围栏后确实变绿"的可复现用例——硬造用例会变成同义反复（正是规则 13 批评的模式）。
   实际做法：把 restore 写入接进唯一收口点（`{ cwdFenced: true }`）作为**纵深防御**，
   并以既有 `tests/unit/workspace-snapshot-guard.test.ts`（二进制保真 + 部分失败聚合）作为回归门禁。
   该检查**未经红→绿证明**，如实登记为"防御性改动，非已证漏洞修复"。

2. **新增 `tool_describe` 的 schema 获取方式（计划外实现细节）**
   计划未规定 schema 来源。实现时评估了三方案：①手写 zod→JSON Schema 转换（会与 SDK 版本漂移，违反规则 8 的"两个适配器才叫真接缝"）；②深路径 import SDK 内部 `toJsonSchemaCompat`（不在包的 `exports` map 内，会随 SDK 升级断裂）；③**探针 McpServer + 公开 `tools/list`**（选用）。
   选③的理由：只用公开 API、与全量模式 schema 逐字段一致（实测返回含 `additionalProperties`/`$schema` 等 SDK 产出字段）。**未新增依赖**。

3. **收口点最初改写了错误消息，导致 5 个既有用例失败**
   首版把消息从 `[HardFloor] <reason> (tool=.., field=..)` 改为 `[<code>] <reason> (tool=..)`，
   全量回归出现 5 fail（`tests/unit/risk-monitor-degraded.test.ts`、`tests/unit/tool-mode-gate.test.ts`
   按 `/HardFloor/` 断言）。判定为**消息契约回归**而非测试过时，改回 `[HardFloor]` 前缀并保留 `code=` 结构化字段，5 个用例恢复。

4. **"不回显参数值"的意图未真正达成（自查发现，如实登记）**
   `ExecutionDeniedError` 自身不再拼接参数值，但其 `reason` 来自 `utils/permissions.ts`，
   而该模块的文本本身含路径（`Sensitive path: /etc/shadow requires manual confirmation`）。
   实测真实服务端响应确实回显了 `/etc/shadow`。**这是改动前既有行为，本轮未改**；
   收窄它需连同 `permissions.ts` 的消息格式一起评审，已列入后续项，未在代码注释中宣称已解决。

5. **端到端探针首版无效（方法与结论纠正）**
   首个 stdio 探针用 `scene_list` + 嵌套敏感参数，结果**未被拒**。排查确认不是守卫失效，而是
   **MCP SDK 按工具声明的 `inputSchema` 先校验并剥离未声明字段**，`scene_list` 的 schema 不接受该参数，
   参数根本到不了 handler。改用参数封套（`tool_invoke` 的 `arguments`）后，嵌套拒绝与合法放行均按预期。
   该 SDK 行为是本收口点的**固有边界**（只能检查 schema 允许进入的参数），已写入架构文档的局限段。

## 覆盖率与残留

- 计划内验收项：T1-1..T1-6 全部已验证（见 ops log 对应条目）；T2-1 / T2-3 / T2-4 已验证；
  **T2-2 降级为"防御性改动"，未获红→绿证明**（见偏差 1）。
- 计划**未覆盖**的同类分散点（本轮未动，如实登记）：`src/computer-use/browser-launch.ts` 自有
  `assertSafeHttpUrl`、`src/knowledge/document-ingest.ts` 自有 `assertReadableFile`、
  `src/mcp/tools/code-analysis.ts` 的 linter spawn 参数、`src/sandbox/docker-sandbox.ts` 的挂载路径校验。
  这些仍各自实现，**统一层尚未做到"唯一"**；把它们并入需单独立项。
