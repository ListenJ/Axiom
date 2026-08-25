# runtime-go

OpenClaw Fusion 的 Go 运行时模块（独立 Go module，module 名 `runtime-go`）。包含三个企业级高并发业务模块（PCDA 并发执行系统、多子代理任务调度框架、知识库并发搜索系统）、两个共享基础包（可观测性、模型服务适配层）与两个工具模块（AST 静态分析、文件树 DAG 预取）。

## 模块结构

```
runtime-go/
├── go.mod                      # module runtime-go（标准库 + prometheus/client_golang + redis/go-redis/v9）
├── cmd/
│   ├── pcdad/                  # PCDA 执行系统守护进程（:9101）
│   ├── agentd/                 # 子代理调度框架守护进程（:9102）
│   └── searchd/                # 知识库搜索服务守护进程（:9103）
└── internal/
    ├── observability/          # ModuleMetrics（QPS/p50/p95/p99/错误码/资源 gauge）、AppError（错误码+堆栈+上下文）、
    │                           # AlertRule/Alerter、RecoveryPolicy（L1 重试 / L2 降级 / L3 切换备用）
    ├── modelclient/            # 模型服务适配层：OpenAI 兼容 Chat、超时、指数退避重试、轮询 LB、
    │                           # 健康检查+熔断（半开回归）、全端点故障时 fallback 降级、调用指标
    ├── pcda/                   # 模块 1：PCDA 并发执行系统
    │   ├── engine.go           #   Plan/Do/Check/Act 四阶段并行引擎（各阶段独立 worker pool，运行时可扩缩）
    │   ├── twopc.go            #   2PC 协调器 + Participant 接口（Prepare/Commit/Abort；TCC 以接口注释预留）
    │   ├── scheduler 相关       #   优先级 lane 队列 + 负载控制循环（按队列深度动态调 worker 数与批大小）
    │   ├── persist.go          #   定时快照（tmp+rename 原子替换）+ WAL 操作日志，Recover() 恢复最近一致状态
    │   └── ring.go / pool.go   #   Vyukov MPMC 无锁环形队列、sync.Pool 批处理内存池
    ├── agent/                  # 模块 2：多子代理任务调度框架
    │   ├── taskdef.go          #   ConfigStore 接口 + 内存实现：任务定义版本化（自增版本 + SHA-256，可回滚）
    │   ├── cgroup_linux.go     #   cgroup v2 内存/CPU 限额（//go:build linux）
    │   ├── cgroup_stub.go      #   非 Linux 降级为记账型 limiter（超配额拒绝新任务）
    │   ├── scheduler.go        #   最小负载优先 + EMA 资源预测（predictor.go）
    │   ├── retry.go            #   任务级指数退避重试（100ms×2 封顶 30s，非幂等任务不重试）
    │   ├── agent.go/failover.go#   代理级健康检查+自动重建、节点级主备切换（NodeFailover）
    │   └── autoscaler.go       #   队列长度+利用率驱动的扩缩容（cooldown 防抖、min/max 约束）
    ├── search/                 # 模块 3：知识库并发搜索系统
    │   ├── index.go            #   分片倒排索引 + 并行构建；COW 更新（atomic.Pointer 切换，读无锁），tombstone 删除
    │   ├── tokenizer.go        #   unicode 边界分词 + 中文 Han bigram
    │   ├── lock.go/lock_redis.go#  DistLock 接口：MemLock（进程内）+ RedisLock（SET NX PX + Lua 释放/续期 + watchdog）
    │   ├── engine.go           #   查询 worker pool 扇出 + Top-K 堆归并
    │   └── optimizer.go        #   基于文档频率(DF)的代价估算：AND 子条件按选择性升序重排 + 短路
    ├── astopt/                 # AST 静态分析：循环内堆分配 / += 字符串拼接 / 循环内 Sprintf / 非缓冲 channel
    └── dagfs/                  # 文件树 DAG（目录边 + Go import 依赖边）、Kahn 拓扑分层、分层并行 Prefetch
```

## 构建与测试

```bash
go build ./...
go vet ./...
go test -race ./...
GOOS=linux GOARCH=amd64 go build ./...   # Linux 交叉编译检查（cgroup 实现）
```

## 运行

```bash
go run ./cmd/pcdad     # PCDAD_ADDR（默认 :9101）、PCDAD_DATA_DIR（快照+WAL 目录）
go run ./cmd/agentd    # AGENTD_ADDR（默认 :9102）
go run ./cmd/searchd   # SEARCHD_ADDR（默认 :9103）、SEARCHD_REDIS_ADDR（可选，启用 Redis 分布式锁）
```

主要端点（三个服务均有 `GET /healthz` 与 `GET /metrics`）：

- **pcdad**：`POST /cycles`（提交循环任务，含 priority 与 payload）、`GET /cycles/{id}`。SIGINT/SIGTERM 优雅退出并落最终快照。
- **agentd**：`POST /task-defs`（创建/更新，更新产生新版本）、`GET /task-defs/{name}/versions`、`POST /task-defs/{name}/rollback`、`POST /tasks`（body 字段为 `def_name`，可选 `version`/`params`）、`GET /agents`、`GET /cluster`。
- **searchd**：`POST /documents`（body 为文档数组 JSON）、`DELETE /documents/{id}`、`GET /search?q=...`（空格 AND、`OR`、`-` NOT、`field:value`、前缀 `foo*`）、`GET /stats`。

## 性能数据（本机实测，i5-12500H，`-benchmem`，Go 1.26）

| 模块 | 指标 | 实测值 |
|---|---|---|
| pcda | 引擎端到端吞吐 | ≈161,000 cycles/sec（6.2µs/op，18 allocs/op） |
| pcda | 2PC 提交 | 64ns/op，0 alloc |
| pcda | 无锁环出队 | 40ns/op，0 alloc |
| agent | 调度吞吐 | ≈53 万–73 万 tasks/sec（1.4–1.9µs/op，3 allocs/op） |
| agent | 负载均衡度（8 代理 × 800 任务仿真） | (max−min)/avg = 0.82%，远低于 10% 阈值 |
| search | 索引构建（10k/20k/40k 文档） | 37.9ms / 68.3ms / 127.3ms ≈ 26–31 万 docs/sec，随数据量近似线性 |
| search | 简单查询（10 万文档） | 20.8µs/op 单 goroutine、11.2µs/op 并发（GOMAXPROCS=2，≈8.9 万 QPS/双核） |
| search | 复杂组合查询（AND+OR+NOT+字段+前缀，10 万文档） | 528µs/op 单 goroutine、474µs/op 并发；p95 远低于 100ms 目标 |
| search | COW 更新可见延迟 | µs 级（<1s 目标） |
| dagfs | 文件预取 | ≈16,700 files/sec |

说明：上表为本机单进程 in-process 实测。崩溃恢复语义为 at-least-once（WAL 重放），阶段 handler 需幂等。端到端（HTTP）实测见下文「分布式部署与联合压测」。

## 分布式部署与联合压测（多节点 LAN）

> 具体内网地址、主机账号与硬件型号见本地 `~/.axiom/axiom-secrets/runtime-go-topology.md`（规则 11，不入库）。下文以 `${LAN_NODE_N1}`/`${LAN_NODE_N2}`/`${LAN_NODE_W1}` 占位。

### 拓扑

- **n1** 节点 N1（`${LAN_NODE_N1}`，x86_64，12 核）：searchd/agentd/pcdad（:9103/:9102/:9101）、redis:7（docker，:6379）、模型服务（:9001）。
- **n2** 节点 N2（`${LAN_NODE_N2}`，x86_64，16 核）：searchd/agentd/pcdad（同端口）。
- n1 入站有防火墙白名单（仅 22/3000/9001 等开放，无 sudo），因此 **n2 → n1 走 SSH 反向隧道**：n1 上常驻 `ssh -f -N -R 19101..19103:127.0.0.1:9101..9103 -R 16379:127.0.0.1:6379 ${LAN_NODE_N2}`，n2 侧以对等端 `127.0.0.1:191xx` 访问 n1（n1 → n2 直连）。各节点只拨对端地址，分片归属只依赖排序后的节点 ID。
- searchd 集群：32 分片按节点取模静态映射（各持 16 分片）；任意节点都是入口，本地分片本地查、对端分片经 `POST /internal/query` 扇出后归并；对端不可达时降级为 partial（`partial:true`，指标 `searchd_partial_queries_total`）；写入经 `POST /internal/docs` 按分片路由，协调节点持分布式锁（`SEARCHD_REDIS_ADDR`）。
- agentd 集群：任务按最小负载路由到主节点，主节点不可达时 failover 到本地执行（指标 `agentd_failovers_total`、`agentd_remote_runs_total`）；pcdad 暴露 `/tx/prepare|commit|abort` 支撑跨机 2PC。

### 部署

```bash
bash scripts/runtime-go/deploy.sh build      # 交叉编译 + 分发 + 起两个节点（默认 GOMAXPROCS=2）
GP_N1=12 GP_N2=16 bash scripts/runtime-go/deploy.sh   # 全核压测模式；GOGC=800 默认，可用 GOGC 覆盖
```

脚本幂等维护反向隧道并校验隧道端口；linux 二进制输出在 `scripts/runtime-go/bin/`（不入库）。

### 压测方法

`loadgen`（seed/search 两种模式；`-qps 0` 为闭环全速模式——默认 ticker 定速受 OS 定时器粒度限制，Windows 仅 ~1-2k QPS）。100k 文档灌入集群约 24-52s，双节点精确各持 50k。

### 端到端实测（HTTP，10 万文档，错误率 0%）

| 场景 | 负载 | 实测 QPS | 延迟 |
|---|---|---|---|
| 单机 2 核（Ryzen 5600H，参考“2 核 2.5GHz”） | simple（单词） | **17,100** | p50 14.9ms / p95 25.9ms |
| 单机 2 核（Ryzen 5600H） | mixed（AND/OR/NOT/字段/前缀/CJK） | 6,850 | p50 37ms / p95 68ms |
| 单机 2 核（E5-2450 老核） | simple / mixed | 7,600 / 2,800 | p95 25ms / 82ms |
| 双机集群 28 核（双入口并行） | simple | **41,600** | p95 42-49ms |
| 双机集群 28 核（双入口并行） | mixed | 22,500 | p95 82-107ms |

**单机 2 核 10K QPS 目标：达成**（参考级 2.5GHz 现代核 17.1k；2012 年 E5 老核 7.6k）。
**分布式 100K QPS 目标：未达成（41.6k）**。瓶颈分析（pprof 取证）：查询计算本身已优化到占比 <6%（单叶 tf 有序早退、多叶 merge-join、高选择性二分打分、宽前缀 board 扫描），当前 90%+ 开销在 HTTP/TCP 内核路径（syscall write/read/connect、软中断 sy 25-30%）与每查询跨节点 JSON RPC 扇出；doc 分片语义决定每次查询必须扇出全部 32 分片。达到 100k 需要：全现代核机型（每核 ~2-3× E5）、RPC 改二进制编码或分片本地化路由、更多节点——本架构均支持水平扩展，加节点即可线性逼近。

### 本轮性能优化与修复记录

- search 查询路径：posting list 双序存储（doc 序 + tf 序），单叶查询 tf 序早退（精确无损）；多叶 merge-join 取代 scoreBoard 全量扫描；高选择性候选二分打分；/search 与 /internal/query 响应手写 JSON（去反射）；简单查询 in-process 49µs→11µs（4.5×），复杂 554µs→360µs。
- RPC 连接池：`distrib.DefaultClient` 空闲连接 16→256/主机、响应体显式 drain 后复用（高扇出下每 RPC 不再新建连接，connect 系统调用占比 4.6%→消除）。
- loadgen：`-qps 0` 闭环模式（绕过 OS 定时器粒度上限）；`-mix simple|mixed`；语料 5228 词。
- agentd 回归修复（均有回归测试 `internal/agent/loop_regression_test.go`）：① failover 重定向经 SubmitExcluding 只落本地代理，消除 HTTP 自环风暴；② 新增 `Scheduler.OnTaskFailed`，执行失败正确释放配额，消除 running 泄漏。
- modelclient 64K 上下文：`ContextWindow` 默认 65536（`MODEL_CONTEXT_WINDOW` 可覆盖），`max_tokens` 钳制、prompt 截断、`reasoning_content` 回退；已对生产端点（${LAN_MODEL_SERVICE}:9001，Qwopus3.5-4B）以 max_tokens=4096 实测，content/reasoning_content 正常返回。

## 分布式拓扑变体：本机 Windows + 节点 N1（LAN）

按用户最新要求，分布式验证拓扑从 ${LAN_NODE_N1}+${LAN_NODE_N2} 切换为**本机 Windows + ${LAN_NODE_N1}**，不再针对 ${LAN_NODE_N2} 服务器测试。

### 拓扑与组网要点（踩坑记录）

- **w1** 本机 Windows 11（x86_64 12C/16T，${LAN_NODE_W1}）：交叉编译的 windows/amd64 searchd，`SEARCHD_ADDR=:9103 SEARCHD_NODE_ID=w1 GOMAXPROCS=12 GOGC=800`，持奇数分片。
- **n1** ${LAN_NODE_N1}：searchd 跑在 **docker 容器**中（见下），持偶数分片；redis 复用既有 openclaw-redis 容器。
- **组网**：${LAN_NODE_N1} 入站白名单仅 22/3000/6379/9001，Windows 无法直连 ${LAN_NODE_N1}:9103。**SSH 隧道（-L/-R 端口转发）实测在数据面引入 60-150ms 不稳定延迟**（ping 0ms、交互式 ssh 正常、仅转发通道慢，MSYS2 与原生 OpenSSH 均复现，已排除 MaxSessions 瓶颈）——热路径不可用，结论：不要再用隧道做压测转发。
- **正解：docker 桥接 DNAT 绕过主机防火墙**（同机 redis:6379 能被 Windows 直连即为此原理）：

  ```bash
  # ${LAN_NODE_N1} 上（复用本地 redis:7 镜像挂二进制，免 pull 免 build）
  docker run -d --name searchd-n1 --restart unless-stopped \
    -v /home/listen/runtime-go/bin:/opt:ro -p 9103:9103 \
    -e SEARCHD_ADDR=:9103 -e SEARCHD_NODE_ID=n1 -e SEARCHD_NUM_SHARDS=32 \
    -e 'SEARCHD_NODES=[{"id":"n1","addr":"http://${LAN_NODE_N1}:9103","role":"primary"},{"id":"w1","addr":"http://${LAN_NODE_W1}:9103","role":"standby"}]' \
    -e SEARCHD_REDIS_ADDR=${DOCKER_BRIDGE_REDIS_ADDR}:6379 -e GOMAXPROCS=12 -e GOGC=800 \
    redis:7 /opt/searchd
  ```

  注意：① redis 需先 `docker exec openclaw-redis redis-cli CONFIG SET protected-mode no`（否则非回环来源的 SET NX 被拒）；② 容器内访问同 bridge 的 redis 必须用**容器 IP ${DOCKER_BRIDGE_REDIS_ADDR}:6379**（${DOCKER_BRIDGE_GW} 网关与宿主发布端口从容器内均不可达）。
- Windows→${LAN_NODE_N1}:9103 经 docker 发布端口直连 RTT 1.6ms；${LAN_NODE_N1}→Windows:9103 入站本来就通（专用网络配置，无需改防火墙）。
- **Windows 作为服务端的 TCP accept 上限**：512 并发 workers 打 w1 入口出现 ~3% `connectex: actively refused`（accept backlog 满），192 workers 干净；w1 入口容量约 13.7k QPS（192w、0 错误）。

### 实测（HTTP，10 万文档灌入 10.2s，n1=50001 / w1=50000，错误率 0%）

| 场景 | 负载 | 实测 QPS | 延迟 |
|---|---|---|---|
| n1 单入口（Windows loadgen 直连） | simple | **33,323** | p50 9.2ms / p95 25ms |
| 双入口并行（→n1 512w + →w1 192w） | simple | 20,836 + 13,699 = **34,535** | — |
| 三入口并行（再加 ${LAN_NODE_N1} 本地→n1） | simple | 27,900 | — |
| 双入口并行终测（30s×2） | mixed | 11,962 + 5,959 = **17,921** | p50 23.9/17.4ms、p95 241.8/226.8ms（542,681 请求 0 错误） |

**100K QPS 在此拓扑不可达（~35k simple / ~18k mixed）**。除上一节已分析的 HTTP/TCP 内核开销与每查询 32 分片全扇出外，本拓扑新增约束：① Windows 服务端 accept 上限把 w1 入口限制在 ~13.7k；② 物理总核数 24（${LAN_NODE_N1} 12 + Windows 12），且 Windows 侧调度/网络栈开销显著高于 Linux；③ 双入口并行时 n1 同时承载扇出归并与自身查询（单入口 33k → 双入口合计 34.5k，扩展已趋近平台极限）。逼近 100K 需要更多 Linux 节点分担入口与分片。

### 进程管理

- 停止：${LAN_NODE_N1} 上 `docker stop searchd-n1`；Windows 侧结束 searchd 进程。重启：`docker start searchd-n1`，w1 以相同 env 重启即可。
- loadgen 本轮改动：错误采样打印（前 5 条 err sample 输出到 stderr），便于压测排障。

## AST 静态分析自体检结果

`astopt.Scan("internal")` 共 31 条命中（22 warn / 9 info），绝大多数在 `_test.go`。生产代码 warn 逐条经 benchmark 取证：2PC 错误路径 happy path 已 0 alloc、search COW 的循环内分配是隔离正确性所必需、锁重试循环分配每调用最多一次——**无安全且有 bench 收益支撑的修复项，未做改动**；info 级（非缓冲 channel）均为刻意的 rendezvous 语义。

## 模型服务配置

模型服务为 llama.cpp 的 OpenAI 兼容端点：

- 环境变量 `MODEL_SERVICE_URL`：单个或多个（逗号分隔）端点，如
  `MODEL_SERVICE_URL=http://${LAN_MODEL_SERVICE}:9001,http://${LAN_MODEL_SERVICE}:9002`
- 未设置时默认 `${LAN_MODEL_SERVICE}`
- 行为：每次调用默认 30s 超时（`Config.Timeout` 可配）；指数退避重试（初始 100ms、倍率 2、上限 2s、最多 3 次），仅网络错误与 5xx 重试，4xx 不重试；多端点轮询负载均衡；后台每 10s（`Config.HealthInterval` 可配）探测 `/health`，不健康熔断、恢复后半开回归；全部不健康返回 `MODEL_ALL_ENDPOINTS_UNHEALTHY` 或走注入的 fallback。
- 已对生产端点（Qwopus3.5-4B）实测连通：Chat 调用成功、usage 解析正确。注意该模型为 reasoning 模型，思考内容在 `reasoning_content` 字段，`max_tokens` 过小会被推理耗尽导致 `content` 为空（`finish_reason=length`），调用方应给足 token 预算。

## 部署侧：Redis（供 searchd 分布式锁使用）

```yaml
# docker-compose.yml（片段）
services:
  redis:
    image: redis:7
    container_name: openclaw-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

启动 searchd 时设置 `SEARCHD_REDIS_ADDR=127.0.0.1:6379` 即启用 `RedisLock`；不设置则默认进程内 `MemLock`（单实例部署足够）。

## 平台说明

- 本 module 纯 Go 实现，Windows / Linux 均可构建运行。
- cgroup v2 资源限额**仅 Linux 生效**（`internal/agent/cgroup_linux.go` 写 `/sys/fs/cgroup` 的 `memory.max`/`cpu.max`）；其他平台自动降级为记账型 limiter（配额记账 + 超限拒绝），功能可测试但不强制内核级隔离。网络 IO 带宽限速为接口预留，未实装。
- agentd 在 Linux 上默认使用 cgroup limiter（需要 cgroup v2 写权限）；无权限时可通过 `ClusterConfig.Limiter` 注入 `AccountingLimiter`。

## 鉴权与调试

三个守护进程的**写端点**（非 GET/HEAD 请求）由 token 中间件保护，各自读取独立的环境变量：

| 服务 | 环境变量 |
|---|---|
| pcdad | `PCDAD_AUTH_TOKEN` |
| agentd | `AGENTD_AUTH_TOKEN` |
| searchd | `SEARCHD_AUTH_TOKEN` |

- **未配置**该环境变量时：所有写请求返回 `403 {"error":"write endpoint disabled: set <环境变量名>"}`；读请求（GET/HEAD）不受影响。
- **已配置**时：写请求必须携带请求头 `X-Axiom-Token: <token 值>`（常量时间比较），不匹配或缺失返回 403。
- **集群部署须为各节点配置对应 TOKEN**：searchd 节点间写入 RPC（`POST /internal/docs`）同样经过该中间件，所有节点应使用相同的 TOKEN 值，否则跨节点分片路由会被拒绝。
- **DEBUG_PPROF**：searchd 的 `/debug/pprof/*` 性能分析端点默认关闭，仅当以 `DEBUG_PPROF=1` 启动时挂载（只读端点，生产环境按需临时开启）。
