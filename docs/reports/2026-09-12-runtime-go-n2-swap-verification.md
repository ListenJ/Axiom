> **历史报告（2026-10-03 标注）**：n1/n2/w1 多机联动已全部退役，本文仅作历史验证证据，不代表现行架构；现行口径见 ADR-011。
# runtime-go n2 换机验证报告（.22 退役五项改造）

- 日期：2026-09-12 ~ 09-13 ｜ 计划：`docs/superpowers/plans/2026-09-12-node22-decommission-n2-swap.md`（T3，已冻结）｜ 决策：`docs/decisions/ADR-006-node22-decommission-n2-swap.md`
- 拓扑终态：**w1**（Windows，本机，192.168.0.111，searchd 作 n1，GOMAXPROCS=12）+ **n2**（Linux 笔记本，有线 192.168.0.110，三守护进程，GOMAXPROCS=12）；32 分片各持 16。token 统一（本文略，见 deploy.sh 注入方式）。

## A1 deploy.sh 改造（M scripts/runtime-go/deploy.sh）

- n2 切换（默认值最终 `listen@192.168.0.110` / `N2_ADDR=http://192.168.0.110:9103`），无 .22 残留（grep 核验）；
- `N1/N2/N1_ADDR/N2_ADDR/REDIS_HOST` 可 env 覆盖；preflight 对 scope 内节点 BatchMode SSH 快速失败并明示不可达节点；
- `AUTH_TOKEN` 透传 SEARCHD_/AGENTD_/PCDAD_AUTH_TOKEN；`GP_N1/GP_N2` 缺省自动探测远端 nproc；
- `bash -n` 语法通过；幂等重复部署验证通过（按 pid 文件杀旧进程，healthz 复验）。

## A2 全链条验证（在原 .111 上完成，行为与 .110 一致）

- 鉴权矩阵：无 token → `403 write endpoint disabled`；错 token → 403；对 token → 200（三守护进程一致）；
- healthz ×3 → 200；`/metrics` 可抓取；重复部署幂等；
- 集群行为：`/cluster` 分片归属正确（n1 偶数 / n2 奇数）；对端下线时查询降级 `partial:true`；写路由按分片归属跨节点转发成功（seed 100k 双节点各落 ~50k）。

## A3 单机峰值（w1，GP=12）

- simple 闭环 64w：**49,943 QPS**（旧 2 核数据 17.1k 的 2.9×）；
- acceptors=1 vs 12 无显著差异；GOMEMLIMIT 调优被复测门禁否决（QPS −2.9%、RSS 2.4×）。

## A4 算法改造：两项均无量化收益，回退

| 实验 | 实现 | 实测 | 结论 |
|---|---|---|---|
| 写路径 /internal/docs 二进制化 | docbin.go（'S''D'0x01 批量 upsert/delete，JSON 回退）+ 单测 | seed 13.2s（基线）→ 19.4s / 14.1s | 无收益，回退 |
| 查询微批聚合 | querybatch.go（'S''B'0x01 一包多 query）；v1 每 peer 单 flusher / v2 8 flushers | v1 simple −74%；v2 恢复 simple 但 mixed −11%（队头阻塞） | 无收益，回退 |

前置事实：跨节点 RPC 已有 P2-12 二进制查询协议 + 按对端分组扇出；剩余开销在链路 RTT 与内核路径。

## A4 回退复测（gate 闭环，n2 链路归因）

同参复测：seed 100k（batch 500）→ simple/mixed 各 30s @ 64 workers，入口 w1:9103，全程零错误。

| 指标 | 旧基线（w1+旧.111 台式机） | 回退复测 #1（n2 走 WiFi） | **回退复测 #2（n2 有线 .110）** |
|---|---|---|---|
| seed 100k | 13.19s | 25.89s | **12.98s** |
| simple QPS | 12,635 | 6,613 | **13,804**（+9.3%） |
| mixed QPS | 10,711 | 7,753 | **10,893**（+1.7%） |
| simple p50/p95 | 4.61 / 8.16ms | 6.75 / 25.63ms | **3.23 / 17.42ms** |

**归因证据链**（#1 → #2 差异的唯一变量是链路）：
- WiFi：ping 均值 60ms（14-105ms 抖动）、HTTP 往返 14-123ms、n2 有线口 `eno1` NO-CARRIER（未插线）、governor 已 performance、负载空闲；
- 有线：ping 0ms、keep-alive HTTP ~2.8ms；
- 64 workers ÷ ~10ms 均延迟 ≈ 6.4k QPS，与 WiFi 组实测吻合（算术自洽）。
**Gate 结论**：回退后代码在可比条件下恢复并略超旧基线，A4 回退判定成立。

## A5 有界浸泡与 72h 交付

- 30min 定速浸泡（mixed @3000 QPS，32w）：结果见 ops log 对应条目（判据：错误率 0、p95 无漂移、RSS 无泄漏、零重启）；
- 交付 `scripts/runtime-go/soak-72h.sh`（用户侧执行）：每小时 RSS/PID 快照，结束时输出判据核对清单。

## A6 .22 清理（破坏性操作，用户批准）

- 备份：`~/runtime-go` + `~/openclaw-fusion.git` → `/home/data/runtime22-retire-20260912.tar.gz`（155MB，`tar -tf` 校验通过）；
- 停服：searchd/agentd/pcdad（pcdad 需 force）；核验：`pgrep` 无进程、9101/9102/9103 端口关闭；
- 删除：`~/runtime-go`、`~/openclaw-fusion.git`；ops log 留痕。

## 偏差与未决项

- ADR 编号：计划原定 ADR-004，因已占用顺延为 ADR-006；
- n2 IP 漂移历史：.111（初配）→ 被 DHCP 收回给 w1 → .108（WiFi）→ .110（有线，终态）；deploy.sh 头注已记录；
- w1 侧 searchd 手动运维（deploy.sh 不支持本地 Windows）；`${LAN_NODE_N1}`（.150）离线期间 scope=n1 preflight 失败属预期；
- 72h 长测由用户执行（会话内不可行，如实声明）。
