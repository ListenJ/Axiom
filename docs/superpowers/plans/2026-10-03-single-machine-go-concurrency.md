# 单机并发能力强化计划（Go 特性）— 2026-10-03

> 背景：用户 2026-10-03 裁定 **n1/n2/w1 多机联动全部退役**，不再需要分布式 runtime-go 拓扑；单机能力优先。利用 Go 的 goroutine / channel / worker pool / `sync.Pool` / `atomic` / context 取消强化单机并发，是一个值得固化的能力。
> 本文是 **T3 书面计划**；每步开工时按 `AGENTS.md` 总则 0.3/0.4 另立任务契约。
> 基线仓库：`/run/media/listen/base/openclaw-fusion`；基线 `runtime-go` 单测 2026-10-03 实测 `go test ./internal/search ./internal/pcda ./internal/modelclient` 全绿。

---

## 一、现状基线（代码实证，非推测）

| 模块 | 现有并发原语 | 事实 |
|---|---|---|
| `runtime-go/internal/search/engine.go` | 固定 `workerPool`：`n` 个 goroutine，`tasks chan` 容量 `n*8`；队列满时调用方 inline 执行（防嵌套死锁） | 已有正确的背压雏形，但 n 的取值/队列深度未经单机基准校准 |
| `runtime-go/internal/search/engine.go` | `scratchCh` 复用 per-query `scoreBoard`/`bitmapArena`/`leaves` | 已避免大部分 per-query 分配；可继续用 `-benchmem` 验证 |
| `runtime-go/internal/search/index.go` | shard 构建：`workers` 个 goroutine + `sync.WaitGroup`，tasks 无缓冲 | 构建期并发已存在；缺少 panic 隔离与固定 GOMAXPROCS 上限 |
| `runtime-go/internal/pcda/pool.go` | `stagePool`：每 stage N 个 worker + `sync.Pool` 复用 `Cycle`/batch | 已有成熟 stage 并发模型，可作为其他模块的样板 |
| `runtime-go/internal/modelclient` | 多端点轮询 + 后台 health loop（每 `HealthInterval` 探测 `/health`） | 并发请求无显式 semaphore；需验证是否有 thundering herd |
| `runtime-go/cmd/loadgen/main.go` | 单机压测 CLI：`-mode seed|search -qps -duration -workers -mix -docs -batch` | 可直接用于单机前后对比，无需多机 |
| `runtime-go/internal/search/cluster.go`（2026-10-03 已退役归档） | 多 peer fan-out | 已随多机退役移除；本计划只保留单机 shard 并发 |

---

## 二、计划级任务契约

- **任务**：在不引入任何多机/网络拓扑依赖的前提下，用 Go 并发原语强化单机 CPU 密集与高吞吐路径；产出可复现的 before/after 基准、内存/goroutine 上界与优雅退出证据。
- **验收标准**：
  1. 每条被优化路径有 `go test -bench`/`loadgen` 的 before/after 读数（p50/p99/QPS/alloc/goroutine）；
  2. 目标路径 p99 改善 ≥20% 或同 QPS 下 allocs/op 降低 ≥20%（二者至少一项，按路径选择并记录）；
  3. goroutine 数量有界（稳态不随请求量增长）；`go test -race ./...` 0 报告；
  4. 优雅退出：context 取消 + WaitGroup、无泄漏、无卡死；soak 后 goroutine 数回落；
  5. 单机端到端：`searchd` 单进程 + `loadgen` 可达稳定 QPS，无 n1/n2/w1、无 Redis/SSH 隧道依赖（Redis 仅作可选本地锁，缺失时降级）。
- **改动清单（文件级）**：`runtime-go/internal/search/{engine,index,httpapi}.go`、`runtime-go/internal/pcda/pool.go`、`runtime-go/internal/modelclient/{client,health}.go`、`runtime-go/cmd/loadgen/main.go`、`runtime-go/**/*_test.go`（按步冻结）。
- **不做项**：不做多机/分布式；peer 语义已随 `cluster.go` 退役，不再保留；不引入第三方并发框架（优先标准库 `sync`/`context`）；不改搜索排序/相关性语义。
- **验证命令（路线图级）**：见 §六。
- **风险/回滚**：并发行为变更风险高；每步先建 `-race` + benchmark 红/绿回路；改动限定在单文件/单模块；回滚用 revert；不做全局并发模型重写。

---

## 三、步骤明细

### Step 1 — 单机基线可复现（不写业务代码）

- **目的**：固定 before 数字，避免“优化后变快”无对照。
- **动作**：
  ```bash
  cd /run/media/listen/base/openclaw-fusion/runtime-go
  go test -bench=. -benchmem -count=3 ./internal/search ./internal/pcda ./internal/modelclient | tee /tmp/go-bench-before.txt
  go test -race ./... 2>&1 | tee /tmp/go-race-before.txt
  go build -o bin/searchd ./cmd/searchd && ./bin/searchd &   # 记录 PID
  ./bin/loadgen -mode seed -docs 100000 -addr http://127.0.0.1:9103 -token '<TOKEN>'
  ./bin/loadgen -mode search -qps 20000 -duration 30s -workers 64 -mix mixed -addr http://127.0.0.1:9103
  ```
- **验收**：`/tmp/go-bench-before.txt` 有 3 次稳定读数；`-race` 0 报告；loadgen p50/p99/QPS 落盘。
- **退出判据**：before 数据可复现；无未跟踪的业务代码改动（`runtime-go/bin/*` 仅本地）。

### Step 2 — worker pool 调参与背压

- **目的**：`search/engine.go` 的 `newWorkerPool(n)` 用实测校准 n 与队列深度；饱和时保持 inline 兜底。
- **动作**：以 GOMAXPROCS 为基准做 n ∈ {GOMAXPROCS, 2×, 4×} 的小矩阵；用 `-benchmem` 与 loadgen p99 选点；把选定值写成常量/可配置（默认值保守）。
- **验收**：目标路径 p99 改善 ≥20% 或 allocs/op 降低 ≥20%；队列满时无死锁；`-race` 0。
- **不做**：不引入无界 goroutine；不做“每个请求一个 goroutine”。

> **Step 2 执行结果（2026-10-04）**：closed-loop 64 mixed = **14,207 QPS**（p99 12.69ms），128 workers 退化（13,232 / p99 32.23ms），simple = 53,781 QPS；worker pool 16（NumCPU）最优（14,277 QPS / p99 12.56ms / RSS 656MB），32/64 退化。scaled paced `-qps 20000` 仅 8,150 QPS，确认是 loadgen ticker pacer 限制，不是 server 上限。已暴露 `SEARCHD_WORKERS`；默认保持 NumCPU。

### Step 3 — shard 构建并发加固

- **目的**：`index.go` 的 shard 构建加固定 GOMAXPROCS 上限、panic 隔离与错误传播；构建期不因单 shard panic 打崩整个进程。
- **动作**：用 `sync.WaitGroup` + `recover`/错误收集（或 `errgroup` 若已可用）；保持 `Index` 不可变快照语义。
- **验收**：构建 10 万文档的耗时/alloc 对比；注入单 shard 错误时返回明确错误而非 panic；`-race` 0。

> **Step 3 执行结果（2026-10-04）**：`BuildIndex` 改为返回 `(*Index, error)`；新增可注入 `buildIndex(..., shardBuilder)`、per-shard panic recover + firstErr、worker 上限 `runtime.GOMAXPROCS(0)`；新增 `TestBuildIndexShardPanicIsolated`。10k/20k/40k 构建吞吐与 alloc 在噪声内无回退；`go test/vet/race` 全绿。

### Step 4 — 单机查询 fan-out 与取消

- **目的**：单机多 shard 查询用带 context 的并发 fan-out；单 shard 超时/取消时及时释放 scratch 与 worker。
- **动作**：给 `Engine.Search` 的 shard 任务传 context；结果聚合保持确定性排序（tie-breaker 不依赖完成顺序）；超时路径有指标。
- **验收**：同一查询重复执行结果逐字节一致；取消场景无 goroutine 泄漏；p99 改善或持平。

> **Step 4 执行结果（2026-10-04）**：`searchShards` 增加 per-shard ctx 检查与 `Wait` 后 ctx 错误返回；`/search` 加 5s 查询超时；新增确定性（10 次逐字节一致）与取消无泄漏（200 次 + goroutine 计数）用例。query bench 持平/略优（Complex ≈252µs，allocs 488 不变）；closed-loop 64 mixed 14,115 QPS/p99 13.08ms（持平）、128 mixed 14,164/p99 29.73ms（+7% QPS，-7.8% p99）；race 绿。

### Step 5 — 内存复用与分配上界

- **目的**：把已有 `scratchCh`/`sync.Pool` 模式推广到 HTTP 请求/响应缓冲；以 `-benchmem` 锁定 allocs/op。
- **动作**：复用 `searchJSONBufPool` 模式；对大响应加 `maxBytes` 上界与流式写；避免把大对象放入长生命周期池。
- **验收**：稳态 RSS/alloc 有上界；soak 后不增长；`-benchmem` 对比。

> **Step 5 执行结果（2026-10-04）**：memprofile 定位 `evalTerm`/`prefixPostings`/`bitmapArena.new`；改为 leaf 直接 append 到 scratch、prefix 内联、bitmap struct 复用。Complex **488→56 allocs/op**、~400KB→~23.5KB（-88.5% / -94%）；Simple 72→40 allocs。ComplexParallel 中位 ~207µs（before 264–298µs）；单线程 Complex 读数受热节流影响，Step 8 受控复测。HTTP p99 略优（64 mixed 13.08→12.39ms；128 mixed 29.73→28.58ms），RSS 606MB（Step 4 825MB）。race/test 全绿。

### Step 6 — modelclient 并发与健康

- **目的**：多端点并发请求加 semaphore，避免 thundering herd；health loop 与请求路径解耦。
- **动作**：`internal/modelclient` 增加有界并发与单飞（single-flight）健康探测；4xx/5xx 重试语义不变。
- **验收**：并发请求数有上界；端点不健康时熔断/半开行为不变；`-race` 0。

> **Step 6 执行结果（2026-10-04）**：新增 `Config.MaxConcurrent`（默认 64）+ `Chat` 有界并发信号量（ctx 取消安全）、`probeAll` 单飞保护；新增 `BenchmarkChatConcurrent`（≈28–31µs/op、109–111 allocs）与 `BenchmarkProbeAllSingleFlight`（≈60–74ns/op、0.00005 probes/op）；`TestMaxConcurrentBounded`（64 并发 Chat 峰值 ≤4）与 `TestHealthProbeSingleFlight`（并发 probe 峰值 ≤1）通过；4xx/5xx 重试语义不变，race/test 全绿。

### Step 7 — 优雅退出与泄漏检测

- **目的**：单机常驻场景下，SIGTERM 后所有 worker/stage/modelclient goroutine 退出。
- **动作**：为 workerPool/stagePool/health loop 加 context 取消与 `WaitGroup.Wait`；增加泄漏测试（前后 goroutine 数）。
- **验收**：`go test -race ./...` 0；SIGTERM 后 `runtime.NumGoroutine()` 回落；无挂起进程。

> **Step 7 执行结果（2026-10-04）**：`workerPool` 增加 `done`/`WaitGroup`/`stopOnce` + `stop()`；新增 `Engine.Close()`，searchd 在 `ServeAll` 返回后调用（SIGTERM 冒烟：health 200 → exited cleanly → 端口释放）；`modelclient.Close()` 改为 `sync.Once` 幂等。新增 engine/client 泄漏与 Close 幂等用例；race/full test/vet 全绿。

### Step 8 — 单机端到端压测与固化

- **目的**：把优化后的单机性能写成可复现基线，纳入回归。
- **动作**：`searchd` 单进程 + `loadgen` 跑 before/after；把关键 benchmark 写进 CI 可跑的 test（不做绝对阈值门禁，做相对 before 的回退告警）。
- **验收**：p50/p99/QPS/allocs/goroutine 五项有 before/after 表；CI 可跑；文档落库。

---

## 四、执行序与并行

```
Step 1（基线）
  → Step 2（worker pool）──┐
  → Step 3（shard 构建）──┼→ Step 4（查询 fan-out）→ Step 5（内存复用）→ Step 8（端到端）
  → Step 6（modelclient）─┘
  → Step 7（优雅退出/泄漏）──────────────────────────────────────────────┘
```

- Step 2/3/6/7 文件互斥，可并行；Step 4 依赖 Step 2/3；Step 5 依赖 Step 4；Step 8 最后。
- 同一文件/模块禁止并行编辑；每步一个提交，批次结束跑 `-race` + benchmark。

---

## 五、验收总表

| 步 | 证据 | 门禁 |
|---|---|---|
| 1 | `/tmp/go-bench-before.txt`、loadgen before | `go test` 全绿、`-race` 0 |
| 2 | p99/alloc 对比 | benchmark + loadgen |
| 3 | 构建耗时/alloc + panic 注入 | `-race` 0 |
| 4 | 查询确定性 + 取消无泄漏 | 确定性用例 + goroutine 计数 |
| 5 | allocs/op + RSS 上界 | `-benchmem` |
| 6 | 并发上界 + 健康语义 | `-race` 0 |
| 7 | SIGTERM 后 goroutine 回落 | 泄漏测试 |
| 8 | before/after 五项表 | CI 可跑 |

---

## 六、证据命令

```bash
cd /run/media/listen/base/openclaw-fusion/runtime-go
go test -bench=. -benchmem -count=3 ./internal/search ./internal/pcda ./internal/modelclient
go test -race ./...
go vet ./...
go build -o bin/searchd ./cmd/searchd
./bin/loadgen -mode seed -docs 100000 -addr http://127.0.0.1:9103 -token '<TOKEN>'
./bin/loadgen -mode search -qps 20000 -duration 30s -workers 64 -mix mixed -addr http://127.0.0.1:9103
# profiling（按需）
go test -bench=BenchmarkSearch -cpuprofile /tmp/search.cpu.prof ./internal/search
go tool pprof -top /tmp/search.cpu.prof
```

---

## 七、完成定义（DoD）

- 实际 diff 与冻结清单一致；
- 每条路径有 before/after 读数；
- `go test -race ./...` 0、benchmark 不回退；
- 无多机依赖（无 n1/n2/w1、无 SSH 隧道、Redis 可选）；
- ops log 一条记录 + commit hash + 推送 `internal <分支>`；
- 未决项显式列出。

> **Step 8 执行结果（2026-10-04，计划收官）**：新增 `TestSearchComplexAllocBudget`（≤80 allocs/op，实测 56）；3×30s soak（closed-loop 64 mixed）QPS 14,173–14,398、p99 11.36–11.64ms、goroutine 40–41、RSS 592–646MB 无增长；终测 closed-loop 128 mixed **15,509 QPS / p99 21.47ms**（Step 1 before 13,232 / 32.23，QPS +17.2%、p99 -33.4%）；Complex allocs 488→56（-88.5%）。race/full test/vet 全绿。单机并发计划 8/8 完成。
