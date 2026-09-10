# 已知局限与审计结论（Limitations & Audit Summary）

> 本文件与 `README.md`「审计与整改状态」双向同步，记录本轮（2026-08-25）三阶段安全/正确性整改的结论与已知局限。
> 操作留痕详见 `docs/operations-log.md`；任务计划见 `docs/superpowers/plans/2026-08-24-audit-remediation-plan.md`。

## 整改完成情况

- **Phase R2（P0 安全线）**：10/10 任务全绿（git 注入白名单、kb 守卫路径、沙箱密钥剥离、SSRF/URL 守卫、密钥 env 隔离等）。
- **Phase R3（功能死路 / 数据正确性）**：8/8 任务完成（搜索结果钳制、stats 真实数据、kg-writer 内容寻址 edgeId + CJK 节点归一化、pdf-worker 摄取终态、kb 同库单一解析源、curlFetch 异步化、maxTokens 预算钳制、kal_references KG 出入边 UNION）。
- **Phase R4（文档与声明收口）**：6/6 任务完成（工具数单一事实源、行数快照治理、测试口径统一、检索注释更正、内网信息脱敏、本摘要同步）。

## 已知局限

1. **wiki-link 跨存储引用未闭环**：`kal_references` 仅覆盖知识图谱出入边 UNION。Vault wiki-link 图由 `DeterministicSearchEngine` 在内存中从 Markdown 构建，本仓库 SQLite 未持久化 `wiki_links` 表，跨存储引用需后续引入持久化表或注入 vault 引擎。
2. **内网信息已脱敏**：真实内网地址/主机账号/硬件仅存于本地非仓库凭据目录 `~/.axiom/axiom-secrets/`，仓库内一律以 `${LAN_NODE_N1}`/`${LAN_NODE_N2}`/`${LAN_NODE_W1}` 等占位符表示（AGENTS.md 规则 11）。`runtime-go/modelclient` 默认端点为 `${LAN_MODEL_SERVICE}`，须由 `MODEL_SERVICE_URL` 显式配置。
3. **工具总数单一事实源**：以 `src/testing/tool-count.ts` 为准，当前 **188**；CI 与文档均引用此值，不再硬编码静态数字。

## 不在本轮整改范围（明确排除）

- `AGENTS.md` 的 git remote（推送工作流必需）、`docs/operations-log.md`（审计留痕不可篡改）、`scripts/runtime-go/deploy.sh`（真实部署脚本须拨真实主机）保留内网地址；其真实值已在本地凭据目录归档。
- 测试夹具（`tests/security-fixes.test.ts`、`tests/unit/cdp-url-guard.test.ts`、`runtime-go/internal/distrib/node_test.go`）以 `192.168.0.150` 作 SSRF/解析负例，改动将破坏安全测试语义，保留。
