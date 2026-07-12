# 知识库网络: 分布式采集与处理系统

## 概述

将知识采集从单机扩展到三机分布式架构，支持 GitHub 趋势发现、Z-Library / 开源电子图书馆 PDF 采集、MinerU PDF→Markdown 转换、GLM-4.7-Flash 内容提炼，最终入库 SQLite + Vault + 知识图谱。

## 物理节点

| 节点 | IP | 角色 | CPU | GPU | 网卡 | Python |
|------|-----|------|-----|-----|------|--------|
| 编排名 | 192.168.2.121 | 编排器 (Bun/Node) | - | 无 | 千兆 | 无(用 Bun) |
| PDF 处理 | 192.168.2.11 | MinerU PDF→MD | E5-2450 | 无 | Intel X520 万兆 | uv + 3.11 |
| LLM 服务 | 192.168.2.150 | Embeddings(预留) | - | RTX 3050 | - | uv + 3.11 |

> 当前阶段统一使用 GLM-4.7-Flash API，LLM Worker 暂不部署本地模型。

## 通信协议

所有 Worker 统一 REST API：

```
POST /v1/submit
→ { "task_type": "...", "payload": {...} }
← { "task_id": "uuid", "status": "queued" }

GET /v1/status/{task_id}
← { "task_id": "uuid", "status": "running|completed|failed",
    "progress": 0~1, "result": {...}, "error": "..." }
```

编排器轮询间隔 2-5s，超时阈值 300s。Worker 内部用 asyncio.Queue 限流。

## PDF Worker (data@192.168.2.11)

Task types:
- `pdf:download` — 从 URL 下载 PDF 到缓存
- `pdf:convert` — MinerU CPU 模式 PDF→Markdown
- `url:fetch` — 抓取网页内容

缓存结构:
```
/data/knowledge/cache/{task_id}/
├── input.pdf
├── output.md
├── metadata.json
└── images/
```

## 编排器集成 (本机)

### 新增模块

| 模块 | 说明 |
|------|------|
| `src/workers/pdf-worker.ts` | PDF Worker HTTP 客户端 (submit + poll) |
| `src/knowledge/sources/github-trending.ts` | GitHub 趋势抓取 + API 搜索 |
| `src/knowledge/sources/z-library.ts` | Z-Library / 开源电子书发现 |
| `src/knowledge/pipeline.ts` | 端到端编排器 |

### 数据流

```
发现阶段                   处理阶段                      入库阶段
─────────                ─────────                  ─────────
GitHub Trending ──┐      PDF Worker ── Markdown ──▶ SQLite 索引
Z-Library ────────┤──▶   GLM API ──── 结构化数据 ──▶ Vault 笔记
网络搜索 ─────────┘      知识提取                    知识图谱
                                                     数据集(JSONL)
```

### GitHub 趋势采集

两种策略并行:
1. `github.com/trending` 页面抓取 — 每日热门
2. GitHub API `search/repositories?q=stars:>10000&sort=stars` — 高潜力发现

结果汇聚为 markdown 表格存入 `00-Knowledge/GitHub/trending/`。

### 内容提炼

GLM-4.7-Flash API 对原始 Markdown 做:
- 章节提取与摘要
- 关键词/实体提取
- 质量评分 (0-1)
- 结构化数据 → JSONL 数据集
- 非结构化数据 → 提炼后 Markdown → 知识图谱

### PDF 获取源

- Z-Library 镜像 (通过 proxy)
- OpenStax / MIT OCW / arXiv 等已知开放教材
- GitHub Repo 中附带的 PDF (README 链接、Release assets)

## 部署步骤

### Phase 1: 编排器增强 (当前机器)
1. 新增 `src/workers/` 目录和客户端代码
2. 新增 GitHub 趋势采集
3. 新增知识源发现模块
4. 新增 `knowledge:pipeline` CLI 命令
5. 现有测试全部通过

### Phase 2: PDF Worker 部署 (data@192.168.2.11)
1. 配置 SSH 密钥认证
2. 安装 uv + Python 3.11
3. 部署 FastAPI Worker
4. 安装 MinerU (CPU)
5. 端到端测试 PDF→Markdown→入库

### Phase 3: 调优
1. 长任务 timeout/retry 策略
2. 并发限流参数
3. 缓存清理策略
