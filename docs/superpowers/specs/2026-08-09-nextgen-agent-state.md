# Axiom 下一代 Agent 开发状态（2026-08-09）

> 状态：方向已收敛，切片 1 已落地，进入外部组件 MVP 阶段
> 分支：codex/external-component-runtime
> 关联：external-component-runtime design / agent-cache-optimization / agent-external-component-landscape / agent-components-day0 design / AXIOM-ARCHITECTURE

## 1. 下一代 Agent 的定义

下一代 Axiom Agent = 原生认知运行时 + 可外挂能力面：

1. 内部 Native Agent 保留完整工具链，作为默认执行体。
2. 对外暴露 MCP-first 外挂组件：知识库、网络搜索、上下文压缩、Skills、Native 任务。
3. 以缓存纪律、可恢复上下文、工具面控制和会话谱系作为差异化内核。

不再做：
- 继续封装 OpenCode / Hermes / Kimi Code CLI 作为默认路径。
- 再自研一套 Agent 协议或重复实现已有 MCP/A2A 标准。

## 2. 已吸收的生态结论

- MCP 是外部接入标准；2025-11-25 规范已覆盖 resources / prompts / elicitation / sampling，Registry 与 Streamable HTTP 已进入生产面。
- A2A 是第二阶段 Agent-to-Agent 标准，v1.0 已支持签名 Agent Card。
- Skills（SKILL.md）是跨宿主能力分发格式，Codex / Claude / OpenCode / Pi 均可消费。
- Hermes 证明 stable/context/volatile 分层、双阈值压缩、session lineage 可落地。
- OpenCode 证明 MCP resources、V2 plugin API、LSP 低 token 语义读取的价值。
- Kimi 证明自动前缀缓存下，prompt 编排纪律比压缩算法更重要。
- Pi 证明 npm package + MCP bridge 生态可以被我们的组件复用。

## 3. 下一代 Agent 状态定义

### 3.1 能力状态

| 能力 | 内部 Native Agent | 外部 Agent 接入 |
|---|---|---|
| 知识库 | Vault / Blackboard / KG / CodeGraph 全量 | memory_search / memory_read / kal_query |
| 网络搜索 | searchAggregator / unifiedSearch / SerpAPI | web_search / search_engines_list |
| 上下文 | ContextAssembler / TokenBudget / RateDistortion | token_stats / context 压缩工具 |
| 工具链 | 完整 ToolRegistry | ToolSurface 受限外部面 |
| Skills | skill-loader / prompt-pool 全量 | skill_list 只读发现 |
| 任务执行 | native-general / native-code / native-research + PiEngine | 显式开启后可选 |

### 3.2 架构状态

```
内部前端 / CLI / 原生 Agent
        │
        ▼
Component Kernel + Runtime
  - Native Agent / PiEngine / ToolRegistry
  - ContextAssembler / TokenBudget / ReadOptimizer
  - Vault / Blackboard / KG / CodeGraph
        ▲
        │ 内部完整工具面
External MCP Server（--external）
  - ToolSurface exposure 过滤
  - ContextCacheDiscipline（待实施）
  - RecoverableToolOutput（待实施）
  - AdaptiveCompaction（待实施）
        ▲
        │ MCP stdio / Streamable HTTP + SKILL.md
OpenCode / Kimi Code / Codex / Claude / Pi / Hermes
```

## 4. 当前开发状态（2026-08-09 快照）

已完成：
- 评估 Hermes / OpenCode / Kimi Code 的模型输入输出、缓存、工具链优化。
- 调研 MCP / A2A / Skills / Registry / 记忆服务的最新路径。
- 建立下沉分支 codex/archive-2026-08-09-pre-external-component。
- 建立验证分支 codex/external-component-runtime。
- 设计 External Component Runtime。
- 切片 1：ToolExposure + filterByExposure + 外部 MCP 模式 + 测试。

已完成：
- 切片 2：server.json + SKILL.md + 安装命令。
- 切片 3：ContextCacheDiscipline 与缓存命中率采集。
- 切片 4：RecoverableToolOutput。
进行中：
- 切片 5：AdaptiveCompaction（模块与测试已落地，待运行时接入）。
- 切片 6：A2A Agent Card。

## 5. 下一代开发路径

### P0：证明外部价值

1. External MCP MVP：完整外部工具面、鉴权、server.json、SKILL.md。
2. 用 OpenCode / Kimi Code / Codex / Pi 真实接入并冒烟。
3. 建立缓存命中率与 token 节省基线。

### P1：形成差异化

4. ContextCacheDiscipline：稳定前缀、provider 缓存头、命中率上报。
5. RecoverableToolOutput：大工具结果外置、按需展开。
6. ToolSurface：稳定工具顺序、per-session 工具裁剪。
7. AdaptiveCompaction：50%/85% 双阈值、tool pair 原子化。

### P2：扩大生态位

8. Session lineage / session_search。
9. LSP + CodeGraph 混合语义读取。
10. A2A Agent Card。
11. MCP Registry 发布 + Docker + npm package。

## 6. 下一代 Agent 验证标准

- 外部接入：OpenCode、Kimi Code、Codex、Pi、Hermes 至少 3 个真实宿主成功调用。
- 上下文：缓存命中率达到我们的基线目标；p50 延迟不劣于直接调用；token 节省基于自有 benchmark 验证。
- 恢复性：压缩后的 tool result 可通过 read_tool_result 展开，不静默丢失。
- 安全：外部面默认只读，写操作显式开启；路径穿越 / SSRF / 高危工具回归测试通过。
- 性能：VPS 内存占用、并发吞吐、内存优化达到既有门禁。

## 7. 风险和决策点

- OpenCode remote MCP 的 Streamable HTTP 兼容性仍不稳定，需要 stdio + HTTP 双测。
- Provider 缓存语义差异大，先支持 1-2 个 provider 再扩展。
- 外部工具面一旦开放就是攻击面，默认只读、token 鉴权、不暴露内部路径。
- 写工具是否暴露给外部 Agent 需要产品决策。
- A2A 是否在第二阶段投入需要按验证结果决定。

## 8. 结论

下一代 Agent 的开发状态应是：已完成方向收敛，正在从“内部单体运行时”切换到“内部完整 + 外部受限”的双面运行时。下一个里程碑是外部组件 MVP 和真实宿主验证，而不是继续堆外部 CLI 适配器。