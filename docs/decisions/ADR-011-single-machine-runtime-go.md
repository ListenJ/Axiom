# ADR-011：runtime-go 单机化（多机联动退役）

- 日期：2026-10-03 ｜ 状态：**Accepted** ｜ 决策人：用户
- 取代：`ADR-006-node22-decommission-n2-swap.md` 的多机拓扑部分（ADR-006 保留为历史决策记录）
- 相关计划：`docs/superpowers/plans/2026-10-03-single-machine-go-concurrency.md`（单机并发能力强化，T3）
- 相关清理：`docs/reviews/2026-10-03-remove-multi-machine.md`（Batch A/B/C keep-remove 清单）

## 背景

runtime-go 原设计为多机分布式搜索/执行拓扑：n1/n2 两个 Linux 节点 + w1 Windows 节点，searchd 按 shard 分片、agentd 做多机 agent 池与 RemoteAgent、pcdad 提供跨机 2PC participant、Redis 分布式锁串行化索引更新，配套 `scripts/runtime-go/deploy.sh`/`soak-72h.sh` 与 TS 分布式测试框架（cluster/scheduler/scenarios/metrics + SSH executor）。

用户 2026-10-03 裁定：**n1/n2/w1 多机联动全部退役**，不再需要多机能力；单机能力优先。Go 的 goroutine/channel/worker pool/`sync.Pool`/`atomic` 用于强化单机并发，是一个值得固化的能力。

## 决定

1. **移除多机互联**：
   - `runtime-go/internal/distrib/**`（节点注册/心跳/RPC）；
   - `runtime-go/internal/search/{cluster.go,cluster_test.go,lock_redis.go}`（cluster fan-out + Redis 分布式锁）；
   - `runtime-go/internal/agent/**` + `runtime-go/cmd/agentd/**`（多机 agent 池/RemoteAgent/failover/autoscaler）；
   - `runtime-go/internal/pcda/{remote.go,remote_test.go,txhttp.go}`（跨机 2PC participant）；
   - `scripts/runtime-go/{deploy.sh,soak-72h.sh}`；
   - TS 分布式测试框架与多机 runner、Windows/w1 二进制（Batch A）。
2. **保留单机并发内核**：`internal/search`（worker pool/COW 索引/shard 并发构建）、`internal/pcda`（stage pool/本地 2PC/ring/persist）、`internal/modelclient`（多端点健康轮询）、`internal/netutil`（Linux SO_REUSEPORT 多 acceptor）、`cmd/{searchd,pcdad,loadgen}`。
3. **searchd 单机化**：只读 `SEARCHD_ADDR`/`SEARCHD_NUM_SHARDS`/`SEARCHD_LISTENERS`；`/cluster` 只返回 `mode:"single"`。
4. **pcdad 单机化**：移除 `/tx/*` 跨机 2PC 端点；保留 `/cycles`/`/healthz`/`/metrics`；本地阶段转换 2PC 保留。
5. **依赖收口**：`go mod tidy` 后移除 `github.com/redis/go-redis/v9`。
6. **归档**：所有被移除文件保存在归档分支 `codex/archive-2026-10-03-multimachine`（tip `c121682e`）的 `archive/multimachine-2026-10-03/` 下；历史 ops log/ADR/报告不改写。

## 证据

- Batch A 提交 `464df17a` / 配套 `2f50269e`；Batch B 提交 `20d8665f`；归档分支 `c121682e`。
- 门禁：`go build ./...` rc=0；`go test ./...` 全绿；`go vet ./...` rc=0；`go test -race ./...` 全绿；`bunx tsc --noEmit` rc=0；doc-contract 35/0；docs-consistency 10/0。
- 保留的 `/cluster` 端点实测返回 `mode:"single"`（代码路径 `internal/search/httpapi.go`）。

## 后果

- 不再支持跨机 shard 分片、跨机 2PC、Redis 分布式锁、agentd 多机池；单进程内并发不受影响。
- 单机并发性能基线以 `go test -bench=. -benchmem` 与 `cmd/loadgen`（单机 searchd）为准；后续优化按 ADR-011 配套计划走。
- 运维半径收敛为一台 Linux 主机；systemd 单实例即可。

## 替代方案

- **保留多机但默认关闭**：被否；用户明确不再需要多机能力，保留会继续维护跨机代码与依赖。
- **只删文档不删代码**：被否；用户要求清理仓库与工作区，代码面也必须收口。
- **保留 Redis 作单机锁**：被否；单机 `MemLock` 已足够，Redis 依赖移除。

## 回滚

被移除文件在归档分支 `codex/archive-2026-10-03-multimachine` 完整可追溯；如需回滚，从该分支按路径取回并 revert 对应清理提交。不要改写已发布历史。
