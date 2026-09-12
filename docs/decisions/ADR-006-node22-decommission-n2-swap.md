# ADR-006：.22 整机退役与 n2 换机（n2-swap）

- 日期：2026-09-12 ~ 09-13 ｜ 状态：**已完成（A1-A4 落地，A5 浸泡收尾中）** ｜ 决策人：项目经理（用户，五项任务书）
- 背景与计划：五项改造（n2 新机加入、全链合理性、单机峰值、算法优化、.22 离场）冻结于 `docs/superpowers/plans/2026-09-12-node22-decommission-n2-swap.md`（T3）。本 ADR 记录关键决策与结果；完整数据见验证报告。

## 决策记录

| # | 决策 | 结论 |
|---|---|---|
| 1 | 节点配置 | n1=本机 Windows w1（.111，手动运维）；n2=listen 笔记本。n2 IP 经历 .111→（DHCP 被 w1 收回）→.108（WiFi）→**.110（有线，最终）**；集群对等地址必须用有线 IP |
| 2 | .22 清理 | tar 备份（155MB，`tar -tf` 校验）→ 停三服务（pcdad 需 force）→ 删 `~/runtime-go` 与 `~/openclaw-fusion.git` → 端口/进程核验清零。破坏性操作经用户批准 |
| 3 | 算法改造（A4） | **两项均回退**：写路径 /internal/docs 二进制化（seed 13.2s→14.1/19.4s，无收益）；查询微批聚合（v1 单 flusher simple −74%；v2 8 flushers mixed −11%）。P2-12 二进制查询 RPC + 按对端分组扇出此前已落地，剩余瓶颈在链路 RTT 与内核路径 |
| 4 | 浸泡 | 30min 有界浸泡（mixed @3000 QPS）会话内执行；72h 由用户跑 `scripts/runtime-go/soak-72h.sh`（判据：错误率 0、p95 漂移 <1.5×、RSS <2×、PID 零变化） |

## 施工中发现的关键问题与修正

- **IP 漂移连锁**：原 n2（.111）关机后 DHCP 将 .111 分配给 w1，导致 w1 上残留 searchd 对"n2"健康检查打到自己（假健康 recovered）。处置：重启 w1 searchd 指向真实 n2；`ssh-keygen` 清理陈旧 known_hosts 指纹（.108/.110 均为新条目）。
- **WiFi 链路归因（复测 gate 的关键）**：首轮回退复测（n2 走 WiFi，RTT 14-105ms）simple 6,613 / mixed 7,753，较旧基线 −47.7%/−27.6%。归因诊断：ping 均值 60ms、HTTP 往返 14-123ms、.108 有线口 `eno1` NO-CARRIER 未插线、CPU governor 已是 performance。**用户插入网线后**（n2=.110，RTT <1ms，HTTP ~2.8ms）：simple **13,804**（旧基线 12,635 的 +9.3%）、mixed **10,893**（+1.7%）、seed 12.98s（基线 13.19s）。三组数据构成完整证据链：**差距 100% 来自链路，非回退代码回归**。
- **鉴权与幂等**：AUTH_TOKEN 透传三守护进程（未配置 → 403 write disabled；出站 RPC 自动带 token）；deploy.sh preflight 对不可达节点快速失败并明示；重复部署幂等（pid 文件杀旧进程）。

## 实测汇总（HTTP，10 万文档，错误率 0%）

| 场景 | simple | mixed | 备注 |
|---|---|---|---|
| 单机全分片本地（w1，GP=12） | 49,943 | — | 旧 2 核数据的 2.9× |
| 双节点有线（w1 + n2@.110） | 13,804 | 10,893 | 最终基线 |
| 双节点 WiFi 对照 | 6,613 | 7,753 | 链路归因对照 |

## 影响面与后续

- 规则 3 主远端已于同日切至 gitea（.10，ADR-003b），.22 同步通道随整机退役一并终结。
- 遗留：72h 浸泡由用户执行；`${LAN_NODE_N1}`（.150）离线期间 scope=n1 preflight 失败属预期；w1 侧 searchd 为手动运维（deploy.sh 不覆盖本地 Windows）。
- ADR 编号说明：计划文档原定 "ADR-004"，因 ADR-004/005 已被占用（target-paths / perf-measurement），顺延为 ADR-006。
