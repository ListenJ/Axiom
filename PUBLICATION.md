# 公开快照说明 / Public snapshot notice

本分支是 Axiom 的一个**无历史公开快照**（orphan branch，无 git ancestry），生成于 2026-09-18。
权威源仓库是私有 Gitea `agent/openclaw-fusion`，本分支只是其一个经过筛选与脱敏的只读切片。

This branch is a **history-free public snapshot** (orphan branch, no git ancestry) of Axiom, generated on 2026-09-18.
The authoritative source repository is the private Gitea instance; this branch is only a filtered, redacted, read-only slice of it.

## 与源仓库的差异 / Differences from the source repository

**已排除 / Excluded**

| 路径 | 原因 |
| --- | --- |
| 全部 git 历史（1259+ commits） | 历史中含内部运行记录与拓扑信息，无法在不重写历史的前提下安全公开 |
| `AGENTS.md` | 内部施工规则，含真实 remote 与主机信息 |
| `docs/operations-log*` | 操作留痕（含内部主机、凭据处置记录） |
| `eval-results/` | 真实模型评测记录 |
| `runtime-go/bin/` | 编译产物（`runtime-go/README.md` 自述"不入库"），约 57 MB |
| `e2e-visual/**/*-{firefox,webkit-*}-*.png` | 像素基线（测试产物，LFS 管理），约 64 MB |

**已脱敏 / Redacted**：所有真实内网地址替换为 `${LAN_*}` 占位符。占位符词汇表见 `LIMITATIONS.md`。
占位符**不是可运行值**；`scripts/runtime-go/deploy.sh` 等脚本已改为缺失环境变量即报错退出，避免静默连到错误主机。

**未修改 / Unchanged**：全部源码、测试、公开文档、CI 配置与其余资源。

## 注意 / Caveats

- 本分支**无 git 历史**，`git log` 只会显示快照提交，不要据此推断项目演进。
- 本分支为**只读镜像**，不接受直接开发；改动请针对私有源仓库。
- 安全测试夹具中保留少量 `192.168.x` 地址作为 SSRF/私网负例，属测试语义必需，非真实拓扑。

- This branch has **no git history**; `git log` shows only the snapshot commit.
- This branch is a **read-only mirror**; development happens in the private source repository.
- A few `192.168.x` literals remain inside security test fixtures as SSRF/private-range negative cases. They are required by the tests and are not real topology.
