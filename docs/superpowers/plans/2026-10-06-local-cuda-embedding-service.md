# 本地 CUDA Embedding 服务部署计划（BGE-M3，2026-10-06）

> 目标：在现有 RTX 3050 Laptop 4GB 环境下部署本地 OpenAI 兼容 embedding 服务，作为 Axiom 的可选语义检索后端；不依赖外部 embedding API。
> 依赖 skill：`blueprint`（施工计划）、`pytorch-patterns`（CUDA 设备/内存纪律）、`deployment-patterns`（服务、健康检查、回滚）。

## 0. 冻结任务契约

**任务**：使用本地 CUDA 运行 `BAAI/bge-m3`，提供 `POST /v1/embeddings`，并接入 Axiom 的设置语义搜索、记忆语义层与知识库增量索引。

**验收标准**：

1. `torch.cuda.is_available() == True`，`torch.version.cuda` 与驱动兼容；模型实际在 GPU 上推理。
2. `/health` 返回 200，包含 device、GPU 名称、CUDA 可用性、模型 ID、向量维度、max sequence length、allocated/reserved VRAM。
3. `/v1/embeddings` 接受 OpenAI 兼容 `{model, input}`，返回 1024 维归一化向量；string 与 string[] 两种 input 都可用。
4. 批量 1/4/8 与截断长度 512/1024/2048 有实测表；服务稳定在 4GB VRAM 内，不 OOM。
5. Axiom `EDGE_EMBED_URL` 指向本机服务后，设置语义搜索可用。
6. `MEMORY_SEMANTIC_SEARCH=1`、`AXIOM_EMBEDDING_CONSENT=yes` 时，知识库索引写入与 KAL 读取使用同一模型标签；换标签时可确定性重建。
7. systemd 常驻、重启后可恢复；`nvidia-smi` 在推理时能看到 Python 进程占用 GPU。
8. 失败路径明确：CUDA 不可用、模型加载失败、OOM、超时都会 fail-closed；确定性 FTS5/关键词检索仍可用。

**不做项**：

- 不在本阶段训练或微调 embedding 模型。
- 不启用 Docker GPU 路径：当前 Docker 无 NVIDIA runtime / nvidia-container-toolkit。
- 不默认放开 CPU 推理；仅允许显式 `EMBED_ALLOW_CPU=1` 作为调试降级。
- 不改确定性检索的默认优先级；embedding 仍只作可选语义候选召回。
- 不把模型权重、venv、缓存或 token 提交到 git。

**回滚**：停止 `axiom-embed` 服务，移除 Axiom embedding 环境变量，恢复确定性检索；本地 provider 代码用对应 commit revert。

## 1. 环境事实（2026-10-06 实测）

| 项 | 实测 |
|---|---|
| GPU | NVIDIA GeForce RTX 3050 Laptop GPU，4096 MiB VRAM |
| 驱动 / CUDA UMD | 615.71.09 / CUDA 13.4 |
| 当前 VRAM 占用 | 约 125 MiB（桌面/Steam 进程） |
| CUDA Toolkit | `nvcc` 未安装；PyTorch wheel 自带 CUDA runtime，暂不需要系统 toolkit |
| Python | 系统 3.14.7；uv 0.12.21；已有 uv-managed CPython 3.12.14 |
| 现有依赖 | torch / transformers / sentence-transformers / fastapi 均未安装 |
| Docker | 29.8.2，Runtimes 只有 runc/containerd，无 NVIDIA runtime |
| 用户组 | `listen` 已在 `video` 组，可访问 `/dev/nvidia*` |
| 磁盘 | `/` 407G 可用；仓库盘 515G 可用 |
| 端口 | `127.0.0.1:9001` 空闲 |

依赖解析 dry-run 结果：

- cu130：`torch 2.14.1+cu130`、`triton 3.8.0`。
- cu128：`torch 2.11.0+cu128`，作为兼容回退。
- serving：`sentence-transformers 6.1.0`、`transformers 5.18.0`、`fastapi`、`uvicorn[standard]`、`modelscope` 可解析。

模型选择：`BAAI/bge-m3`，1024 维、多语言，与 Axiom 现有 `EMBED_TEXT_MAX=4000`、1024 维语义层和 `SEMANTIC_MIN_SIMILARITY=0.5` 口径一致。4GB VRAM 下使用 FP16、较小 batch 和受控 `max_seq_length`；若 OOM，再单独评估小模型并重建索引，不静默换模型。

## 2. 目标目录与运行单元

```text
runtime-embed/
  server.py                 # FastAPI OpenAI-compatible embedding server
  pyproject.toml            # uv/Python 3.12 依赖声明
  models/bge-m3/            # ModelScope 下载的权重（gitignored）
  .venv/                    # 隔离环境（gitignored）
  .cache/                   # HuggingFace/ModelScope 运行缓存（gitignored）
  .env                      # 本机配置（敏感项不入库）
deploy/systemd/
  axiom-embed@.service      # User=%i, 127.0.0.1:9001
```

服务不监听公网，只绑定 `127.0.0.1`；Axiom 与本地 embedding 服务同机通信。

## 3. Step 1 — CUDA 环境与 GPU 冒烟

**动作**：

1. 在 `runtime-embed/` 建 uv venv：Python 3.12。
2. 先安装 cu130 wheel；安装后执行：
   - `torch.cuda.is_available()`
   - `torch.cuda.get_device_name(0)`
   - `torch.version.cuda`
   - 一次 `torch.randn(..., device="cuda")` 矩阵乘。
3. 若驱动/内核不兼容，回退 cu128 重装，不继续加载模型。
4. 安装 `sentence-transformers`、`transformers`、`fastapi`、`uvicorn[standard]`、`modelscope`，验证 `torch` 仍为 CUDA 版。

**退出判据**：CUDA 冒烟通过；`torch.__version__` 带 `+cu130` 或回退版 `+cu128`；GPU 可用。

## 4. Step 2 — ModelScope 下载 BGE-M3

**动作**：

1. 只从 `~/.axiom/axiom-secrets/modelscope.credentials` 读取下载 token，不写入仓库。
2. 使用 ModelScope SDK 下载 `BAAI/bge-m3` 到 `runtime-embed/models/bge-m3`。
3. 校验配置、tokenizer、权重文件齐全；记录文件大小与关键哈希。
4. 加载模型到 CUDA，FP16，计算一条短文本向量；断言向量维度 1024。

**注意**：ModelScope API-Inference 不提供 embedding 服务，这里只用 ModelScope **模型下载**能力；推理完全本地 CUDA。

**退出判据**：模型加载成功；短文本 1024 维；`nvidia-smi` 显示显存占用；加载失败时保留完整 stderr 但不泄露 token。

## 5. Step 3 — OpenAI 兼容服务实现

**服务接口**：

- `GET /health`：模型、device、CUDA、GPU、维度、max_seq_length、VRAM。
- `GET /v1/models`：返回当前模型 ID。
- `POST /v1/embeddings`：支持 `input: string | string[]`，返回 OpenAI 兼容数据。

**实现纪律**：

- 启动时 `torch.inference_mode()`，模型 `eval()`，`normalize_embeddings=True`。
- 默认要求 CUDA；`EMBED_REQUIRE_CUDA=1` 时 CUDA 不可用直接启动失败。
- 文本输入上限、batch 上限、最大并发显式配置；超限返回 4xx，不静默截断到不可解释状态。
- 健康检查不触发大 batch；首次 warmup 独立于请求。
- 错误响应不回显完整输入与 token。

**测试**：

- 单元：输入形状、空输入、超限、响应维度、模型名。
- GPU 冒烟：短文本、批量、长文本截断。
- `nvidia-smi` 对照：请求期间 GPU 进程/显存变化。

**退出判据**：`curl /health` = 200；`curl /v1/embeddings` = 1024 维；批量与超长输入有确定行为。

## 6. Step 4 — 性能与 VRAM 调参

在真实 GPU 上测：

| 变量 | 候选 |
|---|---|
| batch size | 1 / 4 / 8 |
| max_seq_length | 512 / 1024 / 2048 |
| dtype | FP16 默认；必要时 BF16/FP32 对照 |

记录：

- p50/p95 单请求延迟；
- 每 batch 吞吐；
- `torch.cuda.memory_allocated` / `memory_reserved`；
- `nvidia-smi` 峰值显存与是否有 OOM。

**退出判据**：选定默认 batch 与 max_seq_length；峰值显存留出至少 500MiB 余量；不 OOM。4GB 卡上若长上下文无法稳定，降低 `max_seq_length` 并写清影响，不改变向量维度。

## 7. Step 5 — systemd 常驻

**动作**：

- 新增 `deploy/systemd/axiom-embed@.service`，模板实例 `axiom-embed@listen.service`。
- `User=%i`、`WorkingDirectory` 指向 `runtime-embed`、`ExecStart` 指向 venv 的 uvicorn。
- `Restart=always`、`RestartSec=5`、`StandardOutput=journal`、`NoNewPrivileges=true`。
- 只读保护宿主；仅给 `.cache`/`.tmp` 可写路径。
- 不加 `PrivateDevices=true`（会遮断 GPU）；确认 `listen` 用户可访问 `/dev/nvidia*`。

**验收**：

```bash
systemctl is-active axiom-embed@listen.service
systemctl is-enabled axiom-embed@listen.service
curl -fsS http://127.0.0.1:9001/health
nvidia-smi
```

**退出判据**：健康、enabled、重启后仍可拉起；停止服务不影响 Axiom 的确定性检索。

## 8. Step 6 — Axiom 接线

### 6a. 本地 edge 路径

设置：

```bash
EDGE_SETTINGS_SEARCH=1
EDGE_EMBED_URL=http://127.0.0.1:9001
EDGE_EMBED_MODEL=BAAI/bge-m3
```

此路径被 `src/local-llm/edge-embeddings.ts` 和 `src/memory/semantic-layer.ts` 使用。

### 6b. 知识库索引路径

现有 `scripts/index-knowledge-embeddings.ts` 经 `ModelRouter.embeddings()` 与 `findModelsForRole("embedding")`；计划新增一个本地 provider：

- provider：`local-embed`
- base URL：`http://127.0.0.1:9001/v1`
- model：`BAAI/bge-m3`
- API key：本机占位 key（服务忽略；只用于通过现有 key 门）
- 写入/读取模型标签统一为 `local-embed/BAAI/bge-m3`

实现前先检查 `knowledge_embeddings` 现有行；若存在旧标签，先记录并制定重建/清账步骤，避免写读标签不一致。

### 6c. 授权门

本地推理也必须显式授权，避免无意消耗 GPU/磁盘：

```bash
MEMORY_SEMANTIC_SEARCH=1
AXIOM_EMBEDDING_CONSENT=yes
```

未授权时仍走确定性 FTS5/关键词路径。

## 9. Step 7 — 端到端验证

1. 直接服务：`/health`、`/v1/embeddings`、批量、长文本。
2. Axiom 设置搜索：`EDGE_SETTINGS_SEARCH=1`，确认走本地端点。
3. 知识索引：运行 `scripts/index-knowledge-embeddings.ts` 的受限 batch，确认行数、维度、模型标签。
4. 语义召回：运行现有语义/召回相关测试与 `lexical-vs-semantic-recall` 探针，记录词法与语义差异。
5. 降级：停止 embedding 服务，确认 Axiom health 仍正常、检索回落确定性路径、无请求风暴。
6. GPU：`nvidia-smi` 观察到 Python 进程；停止后显存释放到基线。

## 10. Step 8 — 文档与回滚

- 更新 `runtime-embed/README.md`、`.env.example`、`docs/LIMITATIONS.md`、`docs/ARCHITECTURE.md` 相关段落。
- 记录实际 CUDA wheel、模型文件哈希、GPU 型号、VRAM、batch/max_seq 默认值。
- 写入 `docs/operations-log.md` 后再提交。
- 回滚：`systemctl disable --now axiom-embed@listen.service`；移除 `EDGE_EMBED_*`/`MEMORY_SEMANTIC_SEARCH`；revert 本地 provider 代码；必要时清理 `knowledge_embeddings` 的本地模型标签行。

## 11. 主要风险

| 风险 | 处置 |
|---|---|
| RTX 3050 4GB VRAM 上限 | FP16、batch 1-8、max_seq 512-2048 实测；不 OOM 才定默认；必要时评估小模型但需重建索引 |
| CUDA 13 wheel 与驱动不兼容 | cu130 失败即回退 cu128；不安装整套 CUDA toolkit，除非 wheel 明确要求 |
| 模型下载受网络影响 | 只用 ModelScope SDK 下载；token 仅本地；失败不进入服务启动 |
| Docker 无 NVIDIA runtime | 不选 Docker GPU；采用 venv/systemd |
| 模型标签切换导致旧向量不可比 | 先盘点 `knowledge_embeddings`，换标签时重建/清账 |
| 服务占用 GPU 影响桌面 | 限制 batch/序列长度；空闲时服务不做常驻推理；必要时暂停/停止服务 |

## 12. 需用户确认的默认决策

推荐按以下默认值执行：

1. 模型：`BAAI/bge-m3`，1024 维。
2. CUDA wheel：优先 `cu130`，失败回退 `cu128`。
3. 部署形态：`runtime-embed/` + uv venv + 原生 systemd，不使用 Docker GPU。
4. 端口：`127.0.0.1:9001`。
5. 服务实例：`axiom-embed@listen.service`。
6. 授权：只有确认后设置 `AXIOM_EMBEDDING_CONSENT=yes` 与 `MEMORY_SEMANTIC_SEARCH=1`。

本计划只写文件，不安装依赖、不下载模型、不修改 systemd；执行 Step 1 前等待确认。
