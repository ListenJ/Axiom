# 单机 Go 并发基线（2026-10-04）

> 计划：`docs/superpowers/plans/2026-10-03-single-machine-go-concurrency.md` Step 1。
> 目的：在多机退役、单机化收口后固定 before 数字，作为 Step 2–8 的对照基线。
> 环境：Linux x86_64，i5-12500H（16 逻辑核），Go 1.25，runtime-go 单机化后（HEAD `0ff0a5c8`）。
> 原始文件：`/tmp/go-bench-before.txt`、`/tmp/go-race-before.txt`、`/tmp/loadgen-seed-before.txt`、`/tmp/loadgen-search-before.txt`、`/tmp/searchd-stats-before.json`、`/tmp/searchd-cluster-before.json`。

---

## 一、Go benchmark（`go test -bench=. -benchmem -count=3`，rc=0）

### search（`internal/search`，74.236s）

| Benchmark | 3 次读数（ns/op 或 docs/sec） | 内存/op | allocs/op |
|---|---|---|---|
| BuildIndex/10000 | 24.49ms / 24.08ms / 23.98ms；408k / 415k / 417k docs/sec | ~101.2MB | ~972,670 |
| BuildIndex/20000 | 42.31ms / 42.67ms / 44.00ms；473k / 469k / 455k docs/sec | ~177.7MB | ~1,816,656 |
| BuildIndex/40000 | 84.74ms / 85.53ms / 87.82ms；472k / 468k / 455k docs/sec | ~328.6MB | ~3,367,632 |
| SearchSimple | 29.66µs / 30.55µs / 29.88µs | 8,347 B | 72 |
| SearchComplex | 270.7µs / 261.7µs / 268.9µs | ~400KB | 488 |
| SearchSimpleParallel | 11.11µs / 11.30µs / 11.51µs | 8,346 B | 72 |
| SearchComplexParallel | 279.4µs / 298.5µs / 295.6µs | ~408KB | 488 |
| HTTPSearchSimple | 22.30µs / 21.48µs / 21.67µs | ~24KB | ~179 |
| QueryBinVsJSON/json | 720.7µs / 717.6µs / 701.4µs | ~209KB | 2,016 |
| QueryBinVsJSON/bin | 173.9µs / 172.2µs / 174.2µs | ~272KB | 5,025 |

**观察**：二进制查询协议比 JSON 快约 **4.1×**（174µs vs 714µs），但 allocs/op 反而更高（5,025 vs 2,016）——Step 5 内存复用可优先看这里。

### pcda（`internal/pcda`，18.834s）

| Benchmark | 3 次读数 | 内存/op | allocs/op |
|---|---|---|---|
| EngineThroughput | 3,316 / 3,389 / 3,436 ns/op；**291k–302k cycles/sec** | ~1.6KB | 18 |
| RingMPMC | 2,587 / 2,969 / 2,458 ns/op | 0 | 0 |
| LaneQueueDequeue | 22.77 / 22.67 / 22.76 ns/op | 0 | 0 |
| TwoPC | 37.84 / 37.81 / 37.84 ns/op | 0 | 0 |

### modelclient（`internal/modelclient`，3.188s）

该包当前**没有 `Benchmark*` 函数**（只有单元测试；`-bench=.` 输出为空，测试通过）。Step 6 若要量化 modelclient 并发，需要先补 benchmark。

### race（`go test -race ./...`，rc=0）

所有包通过；`internal/search`、`internal/pcda`、`internal/modelclient`、`internal/netutil`、`internal/observability`、`internal/dagfs`、`internal/astopt`、`internal/httpauth` 均绿。

---

## 二、单机 HTTP 基线（searchd，单进程）

启动参数（临时 token 不入库）：

```
SEARCHD_ADDR=127.0.0.1:9103
SEARCHD_NUM_SHARDS=32
SEARCHD_AUTH_TOKEN=<bench-token-20261004>
SEARCHD_LISTENERS=<未设置，单 listener>
```

### seed（10 万文档）

```
./bin/loadgen -mode seed -docs 100000 -batch 500 -addr http://127.0.0.1:9103 -token <token>
seed done: 100000 docs in 8.601s
```

≈ **11,627 docs/sec**；searchd RSS 在压测后 **575,220 KB（≈575MB）**。

### search（20k QPS 目标 × 30s × 64 workers mixed）

```
./bin/loadgen -mode search -qps 20000 -duration 30s -workers 64 -mix mixed -addr http://127.0.0.1:9103
duration:      30s
issued:        236293 (target 20000 qps)
ok:            236293
errors:        0 (0.00%)
achieved qps:  7876
latency ms:    p50=0.21 p95=1.22 p99=2.53 max=18.44
```

### `/stats` 与 `/cluster`

```json
{"documents":100000,"shards":32,"queries_total":236293,"avg_latency_ms":0.2622,"cow_swaps_total":200,"last_build_ms":0,"active_queries":0}
{"mode":"single","num_shards":32,"owned_shards":[0..31]}
```

---

## 三、Step 1 结论与待查项

1. **基线已固定**：Go bench、race、seed、HTTP search 四类读数全部落盘，可复现。
2. **20k QPS 目标未达**：实收 7,876 QPS（0 错误），但 p50 仅 0.21ms、p99 2.53ms；64 worker 下理论吞吐远高于 7,876。Step 2/4 需要区分：
   - 是 **loadgen 的 pacing 实现**限制（target 20k 但实际只发 7.9k/秒），还是
   - **searchd 单机吞吐上限**（worker pool / shard fan-out / HTTP 序列化）。
   建议 Step 2 先做“closed-loop 不设 qps 上限”的对照，再决定优化点。
3. **search Simple 30µs / Complex 267µs**：Complex 比 Simple 慢约 9×、allocs 488 vs 72；Step 4 的查询 fan-out/取消与 Step 5 的内存复用应优先 Complex 路径。
4. **QueryBinVsJSON bin 路径 allocs 更高**：Step 5 可评估 buffer 复用或合并小分配。
5. **modelclient 无 benchmark**：Step 6 先补并发/健康探测 benchmark，再谈优化。
6. **RSS 575MB @ 100k docs / 32 shards**：作为 Step 5 的内存上界基线；Step 8 复测必须不超过该量级。

---

## 四、复现命令

```bash
cd /run/media/listen/base/openclaw-fusion/runtime-go
go test -bench=. -benchmem -count=3 ./internal/search ./internal/pcda ./internal/modelclient | tee /tmp/go-bench-before.txt
go test -race ./... | tee /tmp/go-race-before.txt
go build -o bin/searchd ./cmd/searchd && go build -o bin/loadgen ./cmd/loadgen
SEARCHD_ADDR=127.0.0.1:9103 SEARCHD_NUM_SHARDS=32 SEARCHD_AUTH_TOKEN=<token> ./bin/searchd &
./bin/loadgen -mode seed -docs 100000 -batch 500 -addr http://127.0.0.1:9103 -token <token>
./bin/loadgen -mode search -qps 20000 -duration 30s -workers 64 -mix mixed -addr http://127.0.0.1:9103
curl -sS http://127.0.0.1:9103/stats
curl -sS http://127.0.0.1:9103/cluster
```

---

# 五、Step 2：closed-loop 诊断 + worker pool 矩阵（2026-10-04）

## 5.1 closed-loop 诊断（不设 qps 上限）

同一 searchd 实例（32 shards、100k docs、默认 NumCPU pool）跑 4 个场景：

| 场景 | QPS | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| closed-loop 64 workers mixed | **14,207** | 4.18ms | 8.92ms | 12.69ms | 42.89ms |
| closed-loop 128 workers mixed | 13,232 | 8.72ms | 20.69ms | 32.23ms | 119.29ms |
| closed-loop 64 workers simple | **53,781** | 1.11ms | 2.22ms | 3.17ms | 27.39ms |
| qps=20000 paced 64 workers mixed | 8,150 | 0.20ms | 1.00ms | 1.89ms | 8.36ms |

**结论**：paced 模式 8k QPS 是 **loadgen ticker pacer 粒度限制**（`time.NewTicker(time.Second/qps)` 在 Linux 上亚毫秒间隔不稳定），不是 searchd 上限；server 实际 closed-loop 吞吐为 **14.2k mixed / 53.8k simple**。128 workers 反而更差（p99 32ms），说明 64 loadgen worker 已过订阅。

## 5.2 worker pool n 矩阵（`SEARCHD_WORKERS`）

给 searchd 加 `SEARCHD_WORKERS`（默认 NumCPU=16），每档重启 + seed 100k + closed-loop 64 mixed ×30s：

| SEARCHD_WORKERS | QPS | p50 | p95 | p99 | RSS |
|---|---|---|---|---|---|
| **16（NumCPU，默认）** | **14,277** | 4.17ms | 8.94ms | **12.56ms** | 656MB |
| 32 | 12,137 | 4.98ms | 10.05ms | 14.30ms | 695MB |
| 64 | 11,694 | 5.06ms | 10.88ms | 15.44ms | 758MB |

**结论**：单机 32 shards / 100k docs / 64 loadgen worker 下，**默认 NumCPU=16 最优**；增加 server worker pool 只会加剧 CPU 竞争、降低 QPS 并抬高 RSS。`SEARCHD_WORKERS` 作为可调项保留，但生产默认保持 NumCPU；队列深度 `n*8` 未构成瓶颈，本步不改。

## 5.3 Step 2 决策

- 不改 searchd 默认 worker pool 大小（NumCPU），只新增 `SEARCHD_WORKERS` 供实验/调优。
- **不使用 paced `-qps` 模式评价 server 吞吐**；Step 4/8 统一用 closed-loop（`-qps 0`）对照。
- 下一步 Step 4/5 聚焦 mixed/Complex 路径（Complex ≈267µs、488 allocs；bin 路径 5,025 allocs）与 128-worker 过订阅问题。

---

# 六、Step 3：shard 构建并发加固（2026-10-04）

## 6.1 改动

- `internal/search/index.go`：
  - `BuildIndex(docs, numShards, workers) (*Index, error)` —— 由 panic 隔离层返回明确错误；
  - 新增内部 `buildIndex(..., builder shardBuilder)`，把 shard 构建函数做成可注入 seam（生产传 `buildShard`）；
  - worker 数上限钉在 `runtime.GOMAXPROCS(0)`，防并发构建过订阅；
  - 每个 shard 构建包 `recover`，首个 panic/`nil` 结果写入 `firstErr`，其余 worker 继续；`Wait` 后返回 `nil, err`。
- `internal/search/engine.go`：`Build` 传播 `BuildIndex` 错误；空索引构造改用 `idx, _ := BuildIndex(nil, ...)`（nil docs 不可能 panic）。
- `internal/search/index_test.go`：新增 `TestBuildIndexShardPanicIsolated`（注入 panic builder，断言返回 error 且不逃逸为进程 panic）；既有 serial/parallel 比较改用新的双返回值。
- `internal/search/bench_test.go`：benchmark 调用适配双返回值。

## 6.2 before/after（BuildIndex，16 shards，NumCPU workers，`-benchmem -count=3`）

| 规模 | before（2026-10-04 Step 1） | after（Step 3） | allocs/op |
|---|---|---|---|
| 10k | 24.0–24.5ms（408–417k docs/sec） | 24.5–25.1ms（398–408k docs/sec） | ~972,673（不变） |
| 20k | 42.3–44.0ms（455–473k docs/sec） | 42.8–44.4ms（450–467k docs/sec） | ~1,816,658（不变） |
| 40k | 84.7–87.8ms（455–472k docs/sec） | 80.3–82.3ms（486–498k docs/sec） | ~3,367,635（不变） |

**结论**：panic 隔离 + GOMAXPROCS 上限的额外开销在噪声范围内；构建吞吐无回退，alloc 不变。40k 档 after 略快属运行间波动。

## 6.3 验证

- `go test ./internal/search` rc=0（含新 panic 隔离用例）；
- `go test ./...` rc=0；`go vet ./...` rc=0；
- `go test -race ./...` rc=0（`internal/search` 5.347s）。
- 原始读数：`/tmp/go-bench-step3.txt`、`/tmp/go-race-step3.txt`、`/tmp/go-test-step3.txt`。

---

# 七、Step 4：单机查询 fan-out 与取消（2026-10-04）

## 7.1 改动

- `internal/search/engine.go`：`searchShards` 每个 shard 处理前检查 `ctx.Err()`（取消即停止剩余 shard）；`wg.Wait()` 后若 ctx 已取消，返回 `nil, ctx.Err()`，不再返回部分结果。
- `internal/search/httpapi.go`：`/search` 增加 5s 查询超时（`context.WithTimeout(r.Context(), 5*time.Second)`），取消/超时路径有明确边界。
- `internal/search/search_test.go`：
  - `TestSearchDeterministicAcrossRepeats`：20k docs，复杂查询重复 10 次，断言 hit 列表 JSON 逐字节一致（score desc / ID asc，不依赖 shard 完成顺序）；
  - `TestSearchCancellationNoLeak`：20k docs，已取消 ctx 重复 200 次，断言错误为 `context.Canceled` 且 goroutine 数不增长（固定 worker pool）。
- 结果排序保持不变：`score desc, ID asc`；scratch 仍由 `defer putScratch` 释放。

## 7.2 query benchmark before/after（`-benchmem -count=3`）

| Benchmark | before（Step 1） | after（Step 4） | allocs/op |
|---|---|---|---|
| SearchSimple | 29.66–30.55µs | 29.22–29.61µs | 72（不变） |
| SearchComplex | 261.7–270.7µs | 244.3–256.5µs | 488（不变） |
| SearchSimpleParallel | 11.11–11.51µs | 10.86–11.54µs | 72（不变） |
| SearchComplexParallel | 279.4–298.5µs | 263.9–292.0µs | 488（不变） |

**结论**：per-shard ctx 检查的开销在噪声内；Complex 路径略有改善，alloc 不变。

## 7.3 HTTP closed-loop before/after（32 shards / 100k docs）

| 场景 | before QPS / p99 | after QPS / p99 |
|---|---|---|
| closed-loop 64 mixed | 14,207 / 12.69ms | **14,115 / 13.08ms**（持平，0 错误） |
| closed-loop 128 mixed | 13,232 / 32.23ms | **14,164 / 29.73ms**（QPS +7%，p99 -7.8%） |

**结论**：取消路径加固未造成吞吐回退；128 worker 过订阅场景在 per-shard 取消检查后反而略好。searchd 压测后 RSS 约 825MB（两场景 + seed 后；Step 5 内存上界基线，需与 Step 1 的 575MB 分场景对比）。

## 7.4 验证

- `go test ./internal/search` rc=0（含确定性 + 取消无泄漏用例）；
- `go test ./...` rc=0；`go vet ./...` rc=0；
- `go test -race ./...` rc=0（search 6.517s）；
- 原始读数：`/tmp/go-bench-step4.txt`、`/tmp/go-race-step4.txt`、`/tmp/loadgen-step4-closed-{64,128}-mixed.txt`、`/tmp/searchd-step4.log`。

---

# 八、Step 5：内存复用与分配上界（2026-10-04）

## 8.1 分配热点定位（memprofile，5s benchtime）

`go test -bench=BenchmarkSearchComplex -benchtime=5s -memprofile` 显示查询侧主要分配：

| 热点 | alloc_space | alloc_objects |
|---|---|---|
| `shardIndex.evalTerm` | 49.62% | 16.05% |
| `shardIndex.prefixPostings` | 23.44% | 8.43% |
| `bitmapArena.new` | 0.64% | 9.87%（4.04M objects） |
| `scoreBoard.reset` | 1.40% | — |
| `shardIndex.topK` | 0.75% | 1.20% |

根因：`evalTerm` 每个 term 分配中间 `lists []leaf`；`prefixPostings` 每次分配 `[][]posting`；`bitmapArena.new` 每次 `&bitmap{}` 分配 struct（word 缓冲已复用，struct 未复用）。

## 8.2 改动

- `internal/search/bitmap.go`：`bitmapArena` 新增 `bitmaps []*bitmap` + `bused`；`new`/`cloneOf` 通过 `bitmap(w)` 返回复用的 `*bitmap` struct（word 仍由 arena 复用）；`reset` 复位 `bused`。稳态查询不再分配 bitmap struct。
- `internal/search/eval.go`：
  - `evalTerm` 改为直接 append 到调用方的 scratch `*leaves`（不再分配中间 `lists`）；
  - prefix 展开内联到 `evalTerm`（不再调用会分配 `[][]posting` 的 `prefixPostings`；该函数保留给 `stats.go`）；
  - negated term 使用本地 discard slice，语义不变（negated leaves 不参与打分）。
- 搜索相关性/排序语义未改；`TestSearchDeterministicAcrossRepeats` 通过。

## 8.3 benchmark before/after（`-benchmem`）

| Benchmark | before allocs / B/op | after allocs / B/op | 降幅 |
|---|---|---|---|
| SearchSimple | 72 / 8,347 | **40 / 7,450** | allocs -44%，bytes -11% |
| SearchComplex | 488 / ~400KB | **56 / ~23.5KB** | allocs **-88.5%**，bytes **-94%** |
| SearchSimpleParallel | 72 / 8,346 | **40 / 7,450** | allocs -44% |
| SearchComplexParallel | 488 / ~408KB | **56 / ~22.5KB** | allocs **-88.5%**，bytes **-94%** |

延迟读数：
- ComplexParallel `-count=5`：178–333µs（中位 ~207µs）vs before 264–298µs，倾向改善但方差大；
- 单线程 Complex `-count=5`：314–428µs（读数随连续压测上升），vs before 262–271µs。该单线程读数呈**热/频率节流特征**（同轮 ComplexParallel 也从 333µs 降到 178µs），不作为干净回归信号；Step 8 做受控 before/after 复测。

## 8.4 HTTP closed-loop（32 shards / 100k docs，0 错误）

| 场景 | Step 4 后 QPS / p99 | Step 5 后 QPS / p99 |
|---|---|---|
| closed-loop 64 mixed | 14,115 / 13.08ms | 12,977 / **12.39ms** |
| closed-loop 128 mixed | 14,164 / 29.73ms | 12,371 / **28.58ms** |

本轮 seed 9.393s（Step 4 8.492s），机器负载偏高；QPS 差异落在运行间波动带（12.4k–14.2k），p99 略优。RSS：Step 5 两场景后 **606MB**（Step 4 825MB，降低）。

## 8.5 验证

- `go test ./internal/search` rc=0；`go test ./...` rc=0；`go vet ./...` rc=0；
- `go test -race ./...` rc=0（search 7.080s）；
- 原始读数：`/tmp/search-complex-5s.mem`、`/tmp/go-bench-step5.txt`、`/tmp/go-race-step5.txt`、`/tmp/loadgen-step5-closed-{64,128}-mixed.txt`、`/tmp/searchd-step5.log`。

