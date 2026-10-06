# runtime-embed — 本地 CUDA Embedding 服务（BGE-M3）

在**本机 GPU** 上跑 `BAAI/bge-m3`，对外提供 OpenAI 兼容的 `POST /v1/embeddings`，
作为 Axiom 的可选语义检索后端。**不依赖任何外部 embedding API**。

## 事实基线（本机实测，2026-10-07）

| 项 | 值 |
|---|---|
| GPU | NVIDIA GeForce RTX 3050 Ti Laptop GPU，4096 MiB |
| 驱动 / CUDA UMD | 615.71.09 / 13.4 |
| PyTorch | `torch==2.14.1+cu130`（wheel 自带 CUDA runtime，无需系统 CUDA toolkit） |
| 模型 | `BAAI/bge-m3`，1024 维，FP16 |
| 端口 / 绑定 | `127.0.0.1:9001`（仅本机；不监听公网） |
| 服务单元 | `axiom-embed@listen.service`（systemd，模板实例） |

## 目录

```
runtime-embed/
├── server.py              # FastAPI 服务（/health、/v1/models、/v1/embeddings）
├── tests/test_server.py   # 离线单测（FakeEncoder，不加载模型）
├── smoke_cuda.py          # GPU 冒烟（torch 矩阵乘）
├── smoke_model.py         # 真实模型加载 + 编码冒烟
├── benchmark.py           # batch × max_seq 压测
├── BENCHMARKS.md          # 实测延迟/显存表
├── pyproject.toml         # uv / Python 3.12 依赖
├── .env.example           # 配置模板（复制为 .env）
└── models/bge-m3/         # 权重（gitignored）
```

## 环境准备

```bash
cd runtime-embed
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r pyproject.toml        # 见 pyproject 的 cu130 索引
.venv/bin/python smoke_cuda.py                                    # 期望 cuda_available=True
cp .env.example .env
```

模型权重（经 ModelScope 下载；token 只从本地凭据读取，不入库、不进命令行历史）：

```bash
modelscope download --repo-type model BAAI/bge-m3 --local-dir models/bge-m3
```

## 运行

**前台（调试）**

```bash
set -a; . ./.env; set +a
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 9001
```

**systemd（常驻，需 sudo）**

```bash
sudo bash install-systemd.sh          # 安装单元 + daemon-reload + enable --now + health 轮询
systemctl is-active  axiom-embed@listen.service
systemctl is-enabled axiom-embed@listen.service
```

## 接口

```bash
curl -s http://127.0.0.1:9001/health
# {"status":"ok","model":"BAAI/bge-m3","dim":1024,"device":"cuda:0", ...}

curl -s -X POST http://127.0.0.1:9001/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"BAAI/bge-m3","input":["你好","世界"]}'
# data[].embedding 为 1024 维、L2 归一化向量
```

## 配置（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `EMBED_MODEL_PATH` | `./models/bge-m3` | 本地权重目录（未设时为 `server.py` 同级的 `models/bge-m3`） |
| `EMBED_MODEL_ID` | `BAAI/bge-m3` | 对外模型名；请求 `model` 必须与之一致 |
| `EMBED_DEVICE` | `cuda` | `cuda` / `cpu` |
| `EMBED_REQUIRE_CUDA` | `1` | `1` 时 CUDA 不可用即拒绝启动（fail-closed） |
| `EMBED_ALLOW_CPU` | `0` | 仅调试降级用 |
| `EMBED_MAX_SEQ_LENGTH` | `2048` | 截断长度（token）；超长文本按此截断 |
| `EMBED_BATCH_SIZE` | `4` | 服务内部编码子批 |
| `EMBED_MAX_TEXTS` | `32` | 单请求最多条文本 |
| `EMBED_MAX_CHARS` | `200000` | 单请求文本总字符守卫（超出返回 400） |
| `EMBED_MAX_CONCURRENCY` | `1` | 并发信号量（4GB 卡建议 1） |

## 与 Axiom 的接线

- **设置语义搜索 / 边缘路径**：`src/local-llm/edge-embeddings.ts` 的默认 base/model 就是
  `http://127.0.0.1:9001` + `BAAI/bge-m3`；`EDGE_SETTINGS_SEARCH=0` 可强制关键词兜底。
- **知识库索引路径**：`src/router/models/registry.ts` 中的 `local-bge-m3`（provider `local-embed`，
  非 `devOnly`），`findModelsForRole("embedding")` 首选它 → 模型标签 `local-embed/BAAI/bge-m3`。
  需要 `LOCAL_EMBED_API_KEY`（占位值即可，服务不校验）与 `AXIOM_EMBEDDING_CONSENT=yes`。
- 单条文本在送嵌入前按 `MAX_EMBED_TEXT_CHARS`（`src/knowledge/semantic-index.ts`，= 4000）截断：
  既避免超长抓取文档把整批顶过 `EMBED_MAX_CHARS` 而**整批 400 丢向量**，也贴合本机 `max_seq_length` 口径。

## 失败与回退

服务不可用 / 超时 / 非 2xx：边缘路径返回 `null`，知识召回降级为**无候选**，
最终一律回落确定性 FTS5/关键词检索，不抛错、不重试风暴。
`/health` 是不可用判据；`journalctl -u axiom-embed@listen.service` 是日志入口。

## 回滚

```bash
sudo systemctl disable --now axiom-embed@listen.service
```

移除 Axiom 侧的 `EDGE_EMBED_*` / `LOCAL_EMBED_*` / `AXIOM_EMBEDDING_CONSENT`；
代码回滚对应 commit；如需清账，删除 `knowledge_embeddings` 中 `model='local-embed/BAAI/bge-m3'` 的行。
