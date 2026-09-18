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
