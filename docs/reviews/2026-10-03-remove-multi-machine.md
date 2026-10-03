# 多机互联内容清理计划（T3）— 2026-10-03

> 背景：用户 2026-10-03 裁定 **n1/n2/w1 多机联动全部退役**；单机能力优先。本计划把仓库与工作区里**跨机互联**的内容归档并移除，保留并强化单机 Go 并发内核。
> 配套能力计划：`docs/superpowers/plans/2026-10-03-single-machine-go-concurrency.md`。

---

## 一、Keep / Remove 清单

### 保留（单机并发内核）

| 路径 | 理由 |
|---|---|
| `runtime-go/cmd/searchd/**` | 单机 searchd（去掉 cluster 模式后） |
| `runtime-go/cmd/pcdad/**` | 单机 PCDA HTTP 守护（去掉 `/tx/*` 2PC 端点后） |
| `runtime-go/cmd/loadgen/**` | 单机压测 CLI |
| `runtime-go/internal/search/{engine,index,query,httpapi,metrics,optimizer,stats,tokenizer,topk,bitmap,doc,lock,querybin}.go` | 单机搜索/索引/并发内核 |
| `runtime-go/internal/pcda/{engine,pool,ring,persist,scaler,types,errors,metrics}.go` | 单机 PCDA 并发/持久化 |
| `runtime-go/internal/modelclient/**` | 单机模型客户端（多端点轮询保留为单进程内多端点，不是多机） |
| `runtime-go/internal/netutil/{listen,reuseport_*}.go` | 单机多 acceptor（SO_REUSEPORT），是单机并发能力 |
| `runtime-go/internal/{dagfs,astopt,httpauth,observability}/**` | 单机基础设施 |
| `scripts/runtime-go/{bench-single,build-linux}.sh` | 单机压测/构建（build-linux 去掉 agentd） |
| `src/testing/{arch-stats,tool-count,tool-declarations}.ts` | 文档/工具计数单一事实源，必须保留 |
| `runtime-go/bin/{searchd-linux,loadgen-linux}` | 单机 Linux 二进制 |

### 移除（跨机互联）

| 路径 | 类别 |
|---|---|
| `runtime-go/internal/distrib/**` | 节点注册表/心跳/RPC |
| `runtime-go/internal/search/{cluster*.go,lock_redis.go}` | cluster fan-out + Redis 分布式锁 |
| `runtime-go/internal/agent/**` | agentd 多机 agent 池/RemoteAgent/failover/autoscaler |
| `runtime-go/cmd/agentd/**` | 分布式 agent 守护 |
| `runtime-go/internal/pcda/{remote,twopc,txhttp}*.go` | 跨机 2PC/participant |
| `scripts/runtime-go/{deploy,soak-72h}.sh` | 多机部署/浸泡 |
| `scripts/distributed-test-runner.ts` | 分布式测试入口 |
| `src/testing/cluster/**` | 分布式测试集群（节点/协调器/SSH） |
| `src/testing/scheduler/**` | 多节点 PCDA 调度器（依赖 cluster） |
| `src/testing/scenarios/**` | 分布式场景（依赖 cluster/scheduler） |
| `src/testing/metrics/**` | 分布式指标/报告 |
| `tests/distributed/**` | 分布式测试 |
| `runtime-go/bin/{loadgen.exe,searchd-bench.exe}` | Windows/w1 二进制 |
| 工作区 `runtime-go/bin/{agentd,pcdad}` | 多机本地产物 |
| `~/.axiom/axiom-secrets/runtime-go-topology.md` | 多机拓扑笔记（改为 `.retired-20261003`，不入库） |

### 保留但需改（Batch B/C）

- `runtime-go/cmd/searchd/main.go`：去 `SEARCHD_NODES`/`SEARCHD_REDIS_ADDR`/`distrib`，只保留单机 `MemLock` + `SEARCHD_LISTENERS`。
- `runtime-go/internal/search/engine.go`：去 `cluster` 字段/`WithCluster`/`clusterUpdate`/`clusterSearch`；保留 worker pool/scratch。
- `runtime-go/internal/search/httpapi.go`：`/cluster` 返回 `mode:single`，去 `distrib` 依赖。
- `runtime-go/cmd/pcdad/main.go`：去 `/tx/*` 与 `NewTxHandler`。
- `scripts/runtime-go/build-linux.sh`：只构建 `searchd/pcdad/loadgen`。
- `src/testing/index.ts`：只导出单机工具（arch-stats/tool-count/tool-declarations）。
- `runtime-go/README.md`：移除多机章节，保留单机构建/运行/性能/模型/鉴权。
- 新增 `docs/decisions/ADR-011-single-machine-runtime-go.md` 记录退役决策。

---

## 二、归档策略（规则 4）

1. 建 `codex/archive-2026-10-03-multimachine` 归档分支；
2. 把移除文件整目录复制到 `archive/multimachine-2026-10-03/<原相对路径>`（`archive/` 为 gitignored，用 `git add -f`）；追加 `archive/ARCHIVE-LOG.md` 记录；
3. 归档分支提交并推送；
4. 工作分支用 `git rm` 移除；禁止 `rm -rf` 直接删未归档内容。

---

## 三、批次

- **Batch A（本批）**：TS 分布式框架 + 分布式测试 + runner + Windows 二进制 + 工作区 agentd/pcdad + 拓扑笔记退役；`tsc` + doc-contract + docs-consistency 验证。
- **Batch B**：Go 多机代码移除 + `cmd/searchd`/`internal/search`/`cmd/pcdad`/`internal/pcda` 单机化；`go build ./cmd/searchd ./cmd/pcdad ./cmd/loadgen` + `go test ./...` + `go vet` 验证。
- **Batch C**：`runtime-go/README.md` 单机化 + ADR-011 + `LIMITATIONS`/README 中当前时态的多机描述清理；doc-contract + docs-consistency 验证。

---

## 四、验收

- 仓库内 `grep` 不再有当前时态的多机地址/节点/SSH 隧道/docker bridge 引用（历史 ops log/reviews/ADR 例外，只读证据不改）；
- `go build ./cmd/searchd ./cmd/pcdad ./cmd/loadgen` 干净；`go test ./...` 全绿；`go vet ./...` 干净；
- `bunx tsc --noEmit` rc=0；`bun test --timeout 15000 ./tests` 0 fail（移除的 distributed 测试不计）；
- 归档分支可追溯；工作区无多机未跟踪产物。
