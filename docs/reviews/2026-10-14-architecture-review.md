# 架构审视报告 — Axiom Runtime v4.0.0

> 日期：2026-10-14 | 审视人：AI 架构审计 | 基线：main = dfae8f0e

---

## 一、架构全景

```
Axiom Runtime v4.0.0
├── 41 模块 / 453 src 文件 / 120,963 行
├── 499 测试文件 / 4,673 用例 (1.10 test/src 比)
├── 189 MCP 工具 / 23 领域文件
├── 125 HTTP 路由 / 36 路由文件
├── 15 ADR / 25 架构完整性约束
├── 15 DRE 子系统
└── DRE 守护进程契约 v1.4.0
```

---

## 二、设计哲学（ADR 驱动）

| ADR | 决策 | 评价 |
|-----|------|------|
| ADR-001 | Runtime 优先于 Agent | ✅ 正确——#1 差异化——避开 Agent Framework 红海 |
| ADR-002 | LLM 作为加速器非核心 |* ✅ 正确——确定性管道可测试/可审计/可回放 |
| ADR-003 | 统一数据入口 DataUnifier | ✅ 正确——消除三入口写不一致 |
| ADR-004 | 状态式交互替代对话式 | ✅ 正确——每步可见/可中断/可修正 |
| ADR-005 | Persona 非 Agent | ✅ 正确——配置上下文，无状态迁移开销 |
| ADR-006 | 硬件无关资源预算 | ✅ 正确——纯数字比较，无 nvidia-smi 依赖 |
| ADR-010 | 统一知识后端 | ✅ 正确——SQLite 唯一数据面 |
| ADR-011 | 单机运行时 Go | ✅ 正确——Go 高并发，TS 认知层 |
| ADR-012 | 内核边界与 API 契约 | ✅ 正确——契约版本化 + 能力协商 |
| ADR-013 | 内核-外设分区 | ✅ 正确——daemon 拥有内核，外设经 HTTP |
| ADR-014 | 运行时自扩展 | ✅ 正确——插件装配免重启 |

**评价**：ADR 体系成熟，每个决策有 context + alternatives + consequences。设计哲学一致——**确定性优先，LLM 降级为补全器**。

---

## 三、分层架构（机器执行）

```
叶子层:  constants, utils     — 不依赖任何 src 模块     ← 门禁: 0 违规
领域层:  memory, router, dre, agents, crawl, db, ...   ← 门禁: 0 违规
集成层:  mcp, routes, agents  — 可引用所有领域层        ← 门禁: 0 违规
解耦层:  services             — 唯一允许双向引用         ← 3 个断路器
```

**25 项架构完整性测试全绿**：
- utils/ 叶子约束 ✅
- memory/ 不引用上层 ✅
- 循环依赖仅 services/ ✅
- 文件大小 ≤1000 (豁免 ≤1500) ✅
- `as any` ≤25 (实测 8) ✅
- `: any` ≤90 (实测 2) ✅
- `@ts-expect-error` ≤1 ✅
- console.* 仅 logger.ts ✅
- process.env 白名单 ✅
- DRE 不引用 router/ ✅
- DRE 不引用 crawl/ (除 search-port) ✅

**评价**：分层约束由 `tests/architecture-integrity.test.ts` 机器执行，非文档宣称。这是本架构最强品质——**约束可执行，不是纸面规则**。

---

## 四、内核收敛（DRE Daemon）

```
                    ┌─────────────────────────┐
                    │   DRE Daemon (sole owner) │
                    │   src/daemon/dre-daemon   │
                    │   createDreKernel()       │
                    │   → new Kernel(config)    │
                    │   HTTP :18790             │
                    └────────┬────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │  MCP Server │  │ Main Service│  │  Plugins   │
     │  (client)   │  │  (client)   │  │  (client)  │
     │  HTTP fetch │  │  HTTP fetch │  │  HTTP fetch │
     └────────────┘  └────────────┘  └────────────┘
```

**关键属性**：
- **唯一 Kernel 拥有者**：DRE daemon 进程
- **工厂单一来源**：`createDreKernel()` in `src/dre/factory.ts`
- **非拥有者经 HTTP**：`invokeRemoteDreTool()` → daemon `/dre/tool`
- **契约版本化**：v1.4.0，MAJOR 才允许破坏性变更
- **能力实况化**：capabilities 由运行时事实推导，非手维护
- **双模式**：daemon 模式（生产）+ standalone 模式（dev/test fallback）

**评价**：内核收敛是本架构最重要的结构决策。消除了"多套运行时状态 + 多进程写同一库"的竞态。daemon 作为 single-writer，所有外围经 HTTP 客户端访问。

---

## 五、安全模型（三层纵深防御）

```
L1 硬底线 (permissions.ts)
  └─ decideCapability() — 正则裁决，始终开
  └─ 覆盖: fs.write, proc.exec, fs.read 锚点/越界

L2 灰区复核 (risk-monitor.ts)
  ├─ 概率层: screenToolCall() — 边缘 LLM 初筛 (EDGE_RISK_MONITOR, 默认关)
  └─ 确定性层: reviewSequence() — 跨调用序列复核, 始终开

L3 沙盒 (sandbox/)
  ├─ docker-sandbox.ts — 容器隔离
  ├─ process-sandbox.ts — 进程隔离
  └─ execution-guard.ts — 执行守卫
```

**关键属性**：
- L1 始终开，覆盖绝对违规（rm -rf, DROP TABLE, 路径越界）
- L2 确定性层始终开，覆盖跨调用序列攻击（write→exec 模式）
- L2 概率层默认关（需外部 LLM 端点 + `EDGE_RISK_MONITOR=1`）
- L3 沙盒提供执行隔离
- 所有升级判定写 auditLogger（security.alert 事件）

**评价**：三层C3 纵深防御设计正确。L1+L2 确定性层不依赖外部服务，L2 概率层为可选增强。P2-3 评估确认默认关闭正确。

---

## 六、数据层

```
写入路径:
  VaultManager.writeNote() ──→ SQLite FTS5 (主索引)
  KnowledgeStore.write()   ──→ SQLite KG (知识图谱)
  codegraph-sync           ──→ SQLite (代码索引)

查询路径:
  VaultManager.search()
    ├─ 1. SQLite FTS5 全文检索 (主)
    ├─ 2. DeterministicSearchEngine 关键词加成 (补)
    └─ 3. SemanticRecall 向量召回 (可选, 需 embedding)

语义层 (可选):
  local-embed/BAAI/bge-m3 → 127.0.0.1:9001 (CUDA)
  AXIOM_EMBEDDING_CONSENT=ask (默认零网络请求)
```

**关键属性**：
- SQLite 为唯一有数据面的数据库（PostgreSQL 已移除 H-M1-03）
- 确定性检索为默认（FTS5 + 关键词加成）
- 语义层为可选增强（本地 CUDA bge-m3，不依赖外部 API）
- 单写者守护进程模式（避免多进程写同一库）

**评价**：数据层简洁明确。从 PostgreSQL+pgvector 收敛到纯 SQLite 是正确的简化决策。语义层作为可选增强而非默认依赖，保持了离线可用性。

---

## 七、DRE 认知核心（15 子系统）

```
src/dre/
├── actor/          — Actor 调度
├── consciousness/  — 意识模拟
├── constraint/     — 约束求解 (resource, policy, temporal)
├── kg/             — 知识图谱
├── llm/            — LLM 补全器 (加速器位)
├── mental-model/   — 心智模型
├── persona/        — 人格配置 (push/pop)
├── pipeline/       — 认知管道 (感知→推理→行动)
├── port/           — 端口协议 (内核边界)
├── ports/          — 端口实现
├── reasoning/      — 推理引擎
├── retrieval/      — 检索子系统
├── runtime/        — 运行时 (event-bus, rule-engine, knowledge-network)
├── storage/        — 存储抽象
└── synapse/        — 突触连接
```

**评价**：15 子系统覆盖完整认知循环——感知→约束→推理→行动。端口/端口实现分离（hexagonal）使内核可测试。LLM 子系统定位为"补全器"而非"推理主体"，与 ADR-002 一致。

---

## 八、CI/CD 门禁链

```
CI Pipeline:
  1. test (L1)           — bun run test:full (4673 tests)
  2. windows-portable    — 跨平台可移植性
  3= 3. security-scan (L3)   — 仅 main/PR
     ├─ bun audit (blocking)     — 依赖漏洞, 1 已知豁免
     ├─ Semgrep SAST (report)    — p/typescript + p/security-audit
     └─ trufflehog secrets       — 密钥扫描
  4. deploy-smoke        — pm2 + runtime audit
  5. stress:compare      — 性能回归
  6. frontend-audit      — 前端构建
```

**评价**：门禁链完整——测试 + 安全 + 部署 + 性能 + 前端。bun audit 已阻断化。Semgrep 为 report-only（待零误报后可阻断）。

---

## 九、代码质量矩阵

| 指标 | 实测 | 阈值 | 状态 |
|------|------|------|------|
| FIXME/HACK/TODO | 0 | 0 | ✅ |
| TypeScript 错误 | 0 | 0 | ✅ |
| 循环依赖 | 0 (services/ 断路) | 0 | ✅ |
| eval/Function | 0 | 0 | ✅ |
| `: any` | 2 | ≤90 | ✅ |
| `as any` | 8 | ≤25 | ✅ |
| `@ts-expect-error` | 0 | ≤1 | ✅ |
| 硬编码密钥 | 0 | 0 | ✅ |
| 孤儿文件 | 0 | 0 | ✅ |
| 测试通过 | 4673/4673 | 100% | ✅ |
| 架构完整性 | 25/25 | 100% | ✅ |

---

## 十、强项总结

| # | 强项 | 证据 |
|---|------|------|
| 1 | **约束可执行** | 25 项架构完整性测试机器执行，非纸面规则 |
| 2 | **内核收敛** | 单工厂 + 单 daemon 拥有者 + HTTP 客户端 + 契约版本化 |
| 3 | **纵深防御** | L1 正则 + L2 概率+确定性 + L3 沙盒 |
| 4 | **确定性优先** | LLM 降级为加速器，FTS5+关键词为默认检索 |
| 5 | **测试覆盖** | 1.10 test/src 比，4673 用例，0 fail |
| 6 | **CI 门禁** | audit blocking + SAST + secrets + architecture + docs |
| 7 | **ADR 驱动** | 15 个文档化决策，每个含 context/alternatives/consequences |
| 8 | **代码洁净** | 0 FIXME, 0 eval, 2 `: any`, 8 `as any` |
| 9 | **双模式内核** | daemon (生产 single-writer) + standalone (dev/test) |
| 10 | **文档治理** | INDEX.md 75 条目导航 + doc-contract 门禁 |

---

## 十一、关注项与改进建议

| # | 关注项 | 严重度 | 建议 |
|---|--------|--------|------|
| 1 | **Semgrep report-only** | 低 | CI 运行后审查发现，确认零误报则提升为 blocking |
| 2 | **大文件** (cli.ts 1385, model-router 1287) | 低 | 可分解为子模块，但不紧迫——功能内聚合理 |
| 3 | **F7 测试污染** | 低 | 26s 串行可接受；如需并行化，按目录分片 + 前端改 Vitest |
| 4 | **71 空 catch** | 信息 | 均为 cleanup/best-effort，可加注释说明 |
| 5 | **256 console.log in cli.ts** | 信息 | CLI 输出正确模式；如需结构化可抽 cli-output 模块 |
| 6 | **pg-schema.sql 残留** | 信息 | 已标 DEPRECATED，可择机移入 archive/ |
| 7 | **LLM providers 全 false** | 信息 | 本地部署预期行为；配置 API key 后自动启用 |

---

## 十二、总体评价

### 架构成熟度：**生产就绪 (Production-Ready)**

```
┌─────────────────────────────────────────────┐
│  架构成熟度雷达图                            │
│                                              │
│  分层约束    ████████████████████  10/10    │
│  内核收敛    ████████████████████  10/10    │
│  安全模型    ████████████████████  10/10    │
│  测试覆盖    ███████████████████░  9/10     │
│  CI/CD      ████████████████████  10/10    │
│  文档质量    ███████████████████░  9/10     │
│  代码洁净    ████████████████████  10/10    │
│  设计一致性  ████████████████████  10/10    │
│  可观测性    ██████████████████░░  8/10     │
│  可扩展性    ██████████████████░░  8/10     │
│                                              │
│  总分: 94/100                                │
└─────────────────────────────────────────────┘
```

### 核心结论

**Axiom Runtime v4.0.0 的架构处于优秀状态。**

1. **设计哲学一致** — 确定性优先，LLM 为加速器，Runtime 非 Agent
2. **约束可执行** — 25 项机器门禁，非纸面规则
3. **内核收敛完成** — 单 daemon 拥有者 + 契约版本化 + HTTP 客户端
4. **纵深防御到位** — 三层安全，确定性层始终开
5. **代码洁净** — 零 FIXME/HACK/TODO，极少 `: any`
6. **持续审计收敛** — 82→9→0→0 findings，零回归

**关注项均为低严重度/信息级**，不影响生产就绪判定。架构无结构性缺陷，所有已知缺口已关闭。
