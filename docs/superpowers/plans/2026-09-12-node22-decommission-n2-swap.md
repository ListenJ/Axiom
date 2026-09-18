# 计划：.22 整机退役 → n2 切换 .111 + 全链条验证 + 峰值调优 + 协同算法改造

- 日期：2026-09-12 ｜ 级别：**T3**（架构/运维/部署） ｜ 状态：已冻结（用户已确认 4 项关键决策）
- 决策记录（AskUserQuestion，2026-09-12）：
  1. 拓扑：**两节点形状保留，n2 = listen@${LAN_NODE_W1}**（n1 = listen@${LAN_NODE_N1}，当前离线）；
  2. .22 清理：**停服务 + tar 打包备份后删除**（~/runtime-go、~/openclaw-fusion.git）；
  3. 算法优化：**多项全做**（以测量为门禁，见 §4 事实修正）；
  4. 72h 验收：**有界浸泡（30min）+ 交付用户侧 72h 脚本**（如实声明会话验证边界）。

## 0. 勘察事实（2026-09-12 实测）

| 事实 | 证据 |
|---|---|
| .111 SSH 密钥登录打通（BatchMode） | `ssh -o BatchMode=yes listen@${LAN_NODE_W1}` 成功 |
| .111：Debian 13 / 12 核 / 13Gi（可用 8.4Gi）/ NVMe 451G（9%）/ docker 可用（listen 在 docker 组）/ 无免密 sudo / 无 runtime-go 残留 | 远程探测输出 |
| .150 **已下线**（Windows 与 .111 双向 ping 不通，网关 host unreachable） | ping 输出 |
| .22 仍存活（up 59 天）：searchd/agentd/pcdad 在跑（PID 153355-57），~/runtime-go 与裸仓库在，隧道端口已消失 | ssh 探测输出 |
| 全仓 `.22` 引用仅 deploy.sh + 历史文档（不改写）；`.111` 零引用 | grep |
| **二进制查询 RPC（P2-12）已实现**：querybin.go 协议 v1 + cluster.go 客户端恒走二进制 + JSON 回退；**按节点分组扇出已实现**（每对端 1 次 /internal/query） | 源码 cluster.go:244-257、querybin.go |
| 写路径 /internal/docs 仍 JSON（cluster.go:173 DoJSON） | 源码 |
| 鉴权：httpauth.WriteGuard 包裹全部非 GET（未配 token → 403 write disabled；配了 → X-Axiom-Token 常量时间比较）；出站 RPC 自动带 token（distrib/rpc.go） | cmd/searchd/main.go:81、httpauth/auth.go |
| loadgen 无 token 参数（配置 token 后 seed 会被 403 拒绝） | cmd/loadgen/main.go |
| README 已取证：100K 未达（41.6k），90%+ 开销在 HTTP/TCP 内核路径 + 每查询 32 分片扇出；二进制 RPC、分组扇出、多 acceptor、连接池 256 均已落地 | runtime-go/README.md:119 |

## 1. 任务契约

```
任务: .22 退役五项改造（见标题）
验收标准:
  A1 deploy.sh：n2=listen@${LAN_NODE_W1}，无 .22 残留；N1/N2/N1_ADDR/N2_ADDR/REDIS_HOST 可 env 覆盖；
     preflight 双节点快速失败（明示不可达节点）；AUTH_TOKEN 透传三守护进程；GOMAXPROCS 默认远端 nproc
  A2 .111 全链条验证通过：鉴权矩阵（无token 403 disabled / 错token 403 / 对token 200）；
     healthz×3；/cluster 显示 n2 自己 + n1 unhealthy；查询降级 partial:true；重复部署幂等；/metrics 可抓取
  A3 单机峰值：GP=12 基线表（bench-single acceptors 1 vs 12 + loadgen simple/mixed 闭环），
     与 README 旧 2 核数据对比；调优项（GOGC/GOMEMLIMIT）以复测为门禁
  A4 算法改造前后对照：双节点（Windows w1 + .111）闭环压测基线 → /internal/docs 二进制化 →
     并发查询微批聚合（每对端一包多 query）→ 复测；每项仅当有量化收益才保留，否则回退并记录
  A5 有界浸泡：.111 上 30 分钟定速负载错误率 0%；交付 scripts/runtime-go/soak-72h.sh（判据：错误率、
     p95 漂移、RSS 泄漏、零重启）；72h 长测由用户执行（会话内不可行，如实声明）
  A6 .22 清理完成：tar 备份校验（tar -tf）→ 停三服务 → 删 ~/runtime-go 与 ~/openclaw-fusion.git →
     crontab 检查 → ops log 留痕（破坏性操作已获用户批准，范围见决策 2）
  A7 仓库：实际 diff 与本清单一致；全部提交推 gitea codex/node22-decommission-n2-swap
改动清单（文件级）:
  M scripts/runtime-go/deploy.sh            — n2 切换 + preflight + AUTH_TOKEN + GP auto + env 覆盖
  M runtime-go/cmd/loadgen/main.go          — 增加 -token（X-Axiom-Token，seed/search 共用）
  M runtime-go/internal/search/httpapi.go   — handleInternalDocs 二进制协商（v1 JSON 不变）
  A runtime-go/internal/search/docbin.go    — 写路径二进制协议（'S''D'0x01）+ roundtrip 单测
  M runtime-go/internal/search/cluster.go   — clusterUpdate 走二进制（按响应 Content-Type 回退 JSON）
  A runtime-go/internal/search/querybatch.go— 微批协议（'S''B'0x01：一包多 query）+ 单测
  M runtime-go/internal/search/cluster.go   — clusterSearch 对端微批队列（~150µs 窗口 / ≥8 条即发）
  M runtime-go/cmd/searchd/main.go          — /internal/query 支持批量 magic（并发执行、按序聚合）
  A scripts/runtime-go/soak-72h.sh          — 用户侧 72h 浸泡脚本
  M runtime-go/README.md                    — 拓扑（n2=.111 占位符）、新实测表、节点添加流程
  A docs/decisions/ADR-004-node22-decommission-n2-swap.md
  A docs/reports/2026-09-12-runtime-go-n2-swap-verification.md（基准与验证证据）
  M docs/operations-log.md                  — 规则 5 留痕
  A 本计划文档
不做项:
  - .150 恢复/任何改动（离线，不可达）
  - .111 上 postgres 崩溃循环、mysql8 的修复（无关资产，仅报备）
  - 历史文档（ops log 2026-07/08、ADR-003b、AGENTS.md 规则 3）改写
  - git 历史改写 / LFS 重迁移；agentd 调度算法重写（无瓶颈证据——若双节点复测出现
    agentd 热点，回 Plan 另立项）
  - Windows accept 上限改造（w1 仅作测量节点）
验证命令:
  - cd runtime-go && go vet ./... && go test -race ./...
  - bash scripts/runtime-go/build-linux.sh && GOOS=windows go build ./cmd/searchd
  - .111 部署后 curl /healthz /cluster /metrics + 鉴权 curl 矩阵（见报告）
  - loadgen 闭环压测（-qps 0）前后对照表；pprof 对照（DEBUG_PPROF=1）
  - .22: tar -tf 校验 → pgrep 确认服务停止 → ls 确认目录删除
风险/回滚:
  - deploy.sh/代码改动：git revert（分支未合 main）；.tmp/backups 备份至验证通过后删
  - .22：tar 备份保留于 .22:/home/data/backup-runtime-go-node22-20260912.tar.gz（删目录前校验），
    极端情况可解包恢复；裸仓库内容已核验 gitea .10 为完整超集（ADR-003b）
  - 协议改动向后兼容：二进制仅在新请求 magic 时启用，老 JSON 路径不动；w1/.111 同步重部署
```

## 2. 执行顺序

1. 备份 → deploy.sh 改造 + loadgen -token → go vet/test → build-linux
2. .111 单侧部署（deploy.sh n2 路径同款命令，n1 离线故 ship/start 逐节点执行）→ A2 验证矩阵
3. A3 单机基线与调优 → 记录
4. Windows w1 + .111 双节点基线 → A4 两项算法改造（垂直切片：单测→实现→复测，逐项 gate）
5. A5 浸泡 30min + soak-72h.sh
6. A6 .22 清理（破坏性，已批准）
7. 文档 + ops log + 分组提交推 gitea + 删备份

## 3. 约束审查（规则 10 摊牌）

- 用户第 4 项点名"RPC 二进制编码 / 分片本地化路由"：**两者已在 P2-12 落地**（querybin.go + 分组扇出）。
  故 A4 的"多项"落点改为剩余有证据方向：写路径二进制化 + 并发查询微批聚合；agentd 调度升级无证据，
  列不做项（若坚持需回 Plan 立项）。
- 第 3 项 72h：会话内不可行 → 有界浸泡 + 用户侧脚本（决策 4）。
- .111 崩溃循环的 postgres 容器会周期性占用 CPU，压测数字可能受干扰——如需绝对干净环境，由用户决定
  是否停掉该容器（不在本任务范围内动它）。

## 4. 偏差记录

（执行中追加）
