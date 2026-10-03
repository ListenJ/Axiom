# runtime-go（单机并发运行时）

> **2026-10-03 多机退役**：n1/n2/w1 多机联动、cluster fan-out、distrib 节点注册、agentd 多机 agent 池、RemoteAgent/跨机 2PC、Redis 分布式锁、`deploy.sh`/`soak-72h.sh`、TS 分布式测试框架全部退役，归档到归档分支 `codex/archive-2026-10-03-multimachine`。本模块现在是**单机并发运行时**：用 Go 的 goroutine / channel / worker pool / `sync.Pool` / `atomic` 强化单进程吞吐。
> 单机并发能力计划见 `docs/superpowers/plans/2026-10-03-single-machine-go-concurrency.md`。

## 模块结构

```
runtime-go/
├── go.mod                      # module runtime-go（标准库 + prometheus/client_golang + golang.org/x/sys）
├── cmd/
│   ├── pcdad/                  # PCDA 单机执行系统守护进程（:9101）
│   ├── searchd/                # 单机知识库搜索服务守护进程（:9103）
│   └── loadgen/                # 单机压测 CLI（seed/search）
└── internal/
    ├── observability/          # ModuleMetrics、AppError、AlertRule/Alerter、RecoveryPolicy
    ├── modelclient/            # 模型服务适配：OpenAI 兼容 Chat、超时、指数退避、轮询 LB、健康检查+熔断
    ├── pcda/                   # PCDA 单机并发执行系统（含本地 2PC 阶段转换）
    │   ├── engine.go           #   Plan/Do/Check/Act 四阶段并行引擎（各阶段独立 worker pool）
    │   ├── twopc.go            #   本地阶段转换的 Coordinator + MemoryParticipant（不跨机）
    │   ├── persist.go          #   定时快照（tmp+rename 原子替换）+ WAL，Recover() 恢复最近一致状态
    │   └── ring.go / pool.go   #   MPMC 环形队列、sync.Pool 批处理内存池
    ├── search/                 # 单机并发搜索系统
    │   ├── index.go            #   分片倒排索引 + 并行构建；COW 更新（atomic.Pointer 切换，读无锁）
    │   ├── tokenizer.go        #   unicode 边界分词 + 中文 Han bigram
    │   ├── lock.go             #   MemLock 进程内锁
    │   ├── engine.go           #   查询 worker pool 扇出 + Top-K 堆归并
    │   └── optimizer.go        #   基于 DF 的代价估算：AND 子条件按选择性升序重排 + 短路
    ├── astopt/                 # AST 静态分析：循环内堆分配 / += 字符串拼接 / 循环内 Sprintf / 非缓冲 channel
    ├── dagfs/                  # 文件树 DAG（目录边 + Go import 依赖边）、Kahn 拓扑分层、分层并行 Prefetch
    ├── netutil/                # 单机多 acceptor（Linux SO_REUSEPORT；其他平台回退单 listener）
    └── httpauth/               # 写端点 token 中间件
```

## 构建与测试

```bash
go build ./...
go vet ./...
go test ./...
go test -race ./...
GOOS=linux GOARCH=amd64 go build ./...   # Linux 交叉编译检查
```

## 运行

```bash
go run ./cmd/pcdad     # PCDAD_ADDR（默认 :9101）、PCDAD_DATA_DIR（快照+WAL 目录）
go run ./cmd/searchd   # SEARCHD_ADDR（默认 :9103）、SEARCHD_NUM_SHARDS（默认 16）、SEARCHD_LISTENERS（可选，Linux SO_REUSEPORT）
go run ./cmd/loadgen   # 单机压测 CLI：-mode seed|search -addr -qps -duration -workers -mix -docs -batch
```

主要端点：

- **pcdad**：`POST /cycles`（提交循环任务，含 priority 与 payload）、`GET /cycles/{id}`、`GET /healthz`、`GET /metrics`。SIGINT/SIGTERM 优雅退出并落最终快照。
- **searchd**：`POST /documents`（文档数组 JSON）、`DELETE /documents/{id}`、`GET /search?q=...`（空格 AND、`OR`、`-` NOT、`field:value`、前缀 `foo*`）、`GET /stats`、`GET /healthz`、`GET /metrics`、`GET /cluster`（只返回 `mode:"single"` + 本地分片）。
- **loadgen**：客户端，无守护形态。

## 性能数据（本机单进程实测，`-benchmem`）

| 模块 | 指标 | 实测值 |
|---|---|---|
| pcda | 引擎端到端吞吐 | ≈161,000 cycles/sec（6.2µs/op，18 allocs/op） |
| pcda | 本地 2PC 阶段提交 | 64ns/op，0 alloc |
| pcda | MPMC 环出队 | 40ns/op，0 alloc |
| search | 索引构建（10k/20k/40k 文档） | 37.9ms / 68.3ms / 127.3ms ≈ 26–31 万 docs/sec |
| search | 简单查询（10 万文档） | 20.8µs/op 单 goroutine、11.2µs/op 并发（GOMAXPROCS=2） |
| search | 复杂组合查询（AND+OR+NOT+字段+前缀，10 万文档） | 528µs/op 单 goroutine、474µs/op 并发 |
| search | COW 更新可见延迟 | µs 级 |
| dagfs | 文件预取 | ≈16,700 files/sec |

说明：上表为本机单进程 in-process 实测；端到端 HTTP 压测用 `cmd/loadgen` 在单机 `searchd` 上复跑（见单机并发计划 Step 1/8）。崩溃恢复语义为 at-least-once（WAL 重放），阶段 handler 需幂等。

## AST 静态分析自体检结果

`astopt.Scan("internal")` 共 31 条命中（22 warn / 9 info），绝大多数在 `_test.go`。生产代码 warn 逐条经 benchmark 取证：本地 2PC 错误路径 happy path 已 0 alloc、search COW 的循环内分配是隔离正确性所必需、锁重试循环分配每调用最多一次——**无安全且有 bench 收益支撑的修复项，未做改动**；info 级（非缓冲 channel）均为刻意的 rendezvous 语义。

## 模型服务配置

模型服务为 OpenAI 兼容端点（llama.cpp 等）：

- 环境变量 `MODEL_SERVICE_URL`：单个或多个（逗号分隔）端点，如 `http://127.0.0.1:9001`。
- 行为：每次调用默认 30s 超时（`Config.Timeout` 可配）；指数退避重试（初始 100ms、倍率 2、上限 2s、最多 3 次），仅网络错误与 5xx 重试，4xx 不重试；多端点轮询负载均衡；后台每 10s（`Config.HealthInterval` 可配）探测 `/health`，不健康熔断、恢复后半开回归；全部不健康返回 `MODEL_ALL_ENDPOINTS_UNHEALTHY` 或走注入的 fallback。
- reasoning 模型注意：思考内容在 `reasoning_content` 字段，`max_tokens` 过小会被推理耗尽导致 `content` 为空（`finish_reason=length`），调用方应给足 token 预算。

## 平台说明

- 本 module 纯 Go 实现，Windows / Linux 均可构建运行。
- `searchd`/`pcdad` 在 Linux 上可通过 `SEARCHD_LISTENERS`/`PCDAD_LISTENERS` 启用多 acceptor（SO_REUSEPORT）；其他平台自动回退单 listener。
- 进程内并发由各模块自己的 worker pool / stage pool / `sync.Pool` 承载；**不做跨进程/跨机分布式**。

## 鉴权与调试

两个守护进程的**写端点**（非 GET/HEAD 请求）由 token 中间件保护：

| 服务 | 环境变量 |
|---|---|
| pcdad | `PCDAD_AUTH_TOKEN` |
| searchd | `SEARCHD_AUTH_TOKEN` |

- **未配置**该环境变量时：所有写请求返回 `403 {"error":"write endpoint disabled: set <环境变量名>"}`；读请求（GET/HEAD）不受影响。
- **已配置**时：写请求必须携带请求头 `X-Axiom-Token: <token 值>`（常量时间比较），不匹配或缺失返回 403。
- **DEBUG_PPROF**：searchd 的 `/debug/pprof/*` 性能分析端点默认关闭，仅当以 `DEBUG_PPROF=1` 启动时挂载（只读端点）。
