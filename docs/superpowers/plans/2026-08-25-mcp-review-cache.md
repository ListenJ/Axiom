# MCP 风险复核判定缓存(P2-13)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 同一 `(kind, payload)` 的双层风险判定结果短期缓存复用,消除 agent 工具循环中重复负载的边缘初筛 LLM 调用;安全语义(升级审计、fail-closed、降级不缓存)完整保留。

**Architecture:** `risk-monitor.ts` 模块级 Map 缓存,TTL 默认 5min(`RISK_VERDICT_CACHE_TTL_MS`),上限 256 FIFO;仅缓存**确定性**终态——干净 low 放行与复核后结论;degraded 旁路/复核不可用 fail-open **不缓存**(依赖可用性状态);require-approval 缓存命中仍触发 escalate 保审计链。

**Tech Stack:** Bun / TypeScript ESM strict

## Global Constraints

- AGENTS.md 全规则适用(备份/TDD/独立提交/ops-log/禁 force push)。
- 不改变任何判定语义;缓存纯为性能层,可经 TTL=0 完全关闭。

### Task 1: 判定缓存

**Files:** Modify `src/agents/risk-monitor.ts`;Test `tests/agents/risk-verdict-cache.test.ts`(新建)

- [ ] Step 1 写 RED 测试(fake deps 计数):①同 payload 两次→screen 调 1 次、均 pass;②high+review=dangerous→二次不再调 screen/review、仍 require-approval 且不抛错;③degraded low **不缓存**(screen 计 2 次);④reset 后重新走 screen
- [ ] Step 2 确认 RED(resetRiskVerdictCache 不存在)
- [ ] Step 3 实现:模块级 `verdictCache` + key=`kind\0payload` + `getCachedVerdict/cacheVerdict/resetRiskVerdictCache` 导出;命中 approval 复调 escalate;三处终态写缓存(low-clean pass / cleared pass / dangerous|high-unavailable approval)
- [ ] Step 4 GREEN:`bun test tests/agents/risk-verdict-cache.test.ts` + 相关 risk 套件 + tsc
- [ ] Step 5 Commit + ops-log 回填
