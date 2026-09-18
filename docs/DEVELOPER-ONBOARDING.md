# Developer Onboarding Guide

> 快速上手 Axiom Runtime DRE — 从零开始运行和使用。

---

## 1. 前置条件

| 依赖 | 版本要求 | 验证命令 |
|------|----------|----------|
| [Bun](https://bun.sh) | >= 1.3.0 | `bun --version` |
| Git | 任意 | `git --version` |
| (可选) LLM API | OpenAI 兼容 | 见 §4 |

## 2. 安装

```bash
# 1. 克隆仓库
git clone <repo-url>
cd openclaw-fusion

# 2. 安装依赖
bun install

# 3. (可选) 安装 TypeScript 类型
bun add -d typescript
```

## 3. 快速启动

### 3.1 启动 MCP 服务器 (推荐)

```bash
# 默认 HTTP 模式 (端口 3001)
bun run mcp

# 或 stdio 模式 (用于 OpenCode 等 MCP 客户端)
bun run src/mcp/server.ts --stdio
```

### 3.2 验证服务器运行

```bash
# HTTP 模式: 调用 initialize 方法
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# 预期响应:
# {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":...}}}
```

### 3.3 列出可用工具

```bash
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 预期: 返回 130+ 工具的 meta 信息
```

## 4. 配置

### 4.1 环境变量

创建 `.env` 文件 (或直接设置环境变量):

```bash
# === 必需 (DRE 引擎) ===
DRE_DB_PATH=./data/dre.db          # SQLite 数据库路径
DRE_LLM_URL=http://127.0.0.1:8080  # LLM API 地址 (llama.cpp / vLLM / Ollama)
DRE_LLM_MODEL=qwen3-1.7b-instruct  # 主推理模型

# === 可选 (甄别模型) ===
DRE_DISCRIMIN_URL=                 # 小模型 API 地址 (留空则使用主模型)
DRE_DISCRIMIN_MODEL=qwen3-0.6b-instruct

# === 可选 (云降级) ===
DEEPSEEK_API_KEY=sk-xxx            # DeepSeek / OpenAI API Key
DEEPSEEK_MODEL=deepseek-chat

# === 可选 (引擎调优) ===
DRE_TICK_INTERVAL=10000            # Kernel tick 间隔 (ms)
DRE_AUTO_TICK=true                 # 是否自动启动 tick 循环
DRE_WORKING_MEMORY_CAPACITY=16     # 工作记忆容量
DRE_EPISODIC_TTL=3600000          # 情景记忆 TTL (ms)
```

### 4.2 LLM 后端配置示例

**llama.cpp:**
```bash
# 启动 llama.cpp 服务器
./llama-server -m qwen3-1.7b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 --n-gpu-layers 99
```

**Ollama:**
```bash
ollama run qwen3:1.7b
# Ollama 默认地址: http://127.0.0.1:11434
# 设置 DRE_LLM_URL=http://127.0.0.1:11434
# 设置 DRE_LLM_MODEL=qwen3:1.7b
```

## 5. 核心功能使用

### 5.1 查询引擎状态

```bash
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dre_status","arguments":{}}}'
```

### 5.2 切换 Persona 模式

```bash
# 切换到安全审计模式 (只读, 禁止写操作)
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"persona_switch","arguments":{"mode":"audit"}}}'

# 切换到代码生成模式 (diff 输出, 自动测试)
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"persona_switch","arguments":{"mode":"code"}}}'
```

### 5.3 查看认知状态

```bash
# 获取统一认知状态 (Persona + 意识流 + 推理 + 约束 + 目标)
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"cognitive_state","arguments":{}}}'

# 预期响应包含:
# - persona: mode, name, temperature, allowWrite
# - consciousness: workingMemorySize, episodicMemorySize
# - reasoning: nodes, edges, gaps
# - constraints: total, byDimension
# - goals, beliefs, hypotheses
# - dataUnifier: atom stats
```

### 5.4 运行认知管道

```bash
# 纯确定性推理 (6 步闭环, 零 LLM)
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"cognitive_loop","arguments":{"input":"分析这个项目的架构"}}}'

# 带 LLM 降级的认知管道 (L1确定→L2本地LLM→L3云→L4规则)
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"cognitive_pipeline_run","arguments":{"input":"重构用户认证模块"}}}'
```

### 5.5 统一数据写入

```bash
# 通过 DataUnifier 写入 (同时创建 Atom + 持久化到 KnowledgeStore)
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"data_write","arguments":{"content":"JWT 令牌应在 1 小时后过期","kind":"fact","domain":"security","paradigm":"rule"}}}'

# 统一搜索 (同时搜索 Atom + KnowledgeStore)
curl -X POST http://127.0.0.1:3001 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"data_search","arguments":{"query":"JWT"}}}'
```

### 5.6 Persona 用法速查

| 模式 | 温度 | 可写 | 用途 | 能力契约 |
|------|------|------|------|----------|
| `plan` | 0.0 | ✗ | JSON 执行计划 | planning.structured, reasoning.deductive |
| `code` | 0.0 | ✓ | diff 格式代码生成 | code.reasoning, code.generation, code.review |
| `retrieve` | 0.0 | ✗ | 知识库检索 | knowledge.retrieval |
| `reflect` | 0.0 | ✓ | 自监督复盘 | reasoning.causal, verification.factual |
| `audit` | 0.0 | ✗ | 安全审计 (只读) | code.review, verification.factual |
| `creative` | 0.7 | ✓ | 创意写作 | generation.creative |
| `research` | 0.1 | ✓ | 多源研究 | research.synthesis, reasoning.analogical |
| `general` | 0.3 | ✓ | 通用协作 | — |

## 6. 运行测试

```bash
# 运行 DRE 核心模块测试 (93 tests, 0 fail expected)
bun test tests/dre-core-modules.test.ts

# 运行全部测试 (若存在)
bun test
```

## 7. 项目结构

```
openclaw-fusion/
├── src/
│   ├── dre/                  # DRE 确定性推理引擎 (核心)
│   │   ├── kernel.ts         # 极薄启动器 (init/tick/shutdown)
│   │   ├── engine.ts         # 引擎主入口 (12 个子系统)
│   │   ├── config.ts         # 配置加载器 (env → KernelConfig)
│   │   ├── system-resource.ts# 硬件无关资源预算
│   │   ├── vfs.ts            # VFS / StorageAdapter
│   │   ├── index.ts          # barrel export (v3.1.0)
│   │   ├── constraint/       # 5 维约束求解器
│   │   ├── mental-model/     # 心智模型池 (4 预注册)
│   │   ├── pipeline/         # CognitivePipeline + TaskGraph
│   │   ├── persona/          # PersonaLoader (8 模式)
│   │   ├── consciousness/    # 意识流 (3 层记忆)
│   │   ├── runtime/          # DataUnifier, AtomEngine, EventBus, WorldState...
│   │   └── storage/          # KnowledgeStore (SQLite FTS5)
│   ├── mcp/
│   │   └── server.ts         # MCP 服务器 (3400+ 行, 133 工具)
│   ├── main.ts               # HTTP 服务器入口
│   └── launcher.ts           # 统一启动器
├── docs/
│   ├── AXIOM-ARCHITECTURE.md # 唯一权威架构文档 (1388 行)
│   └── archive/              # 历史版本存档
├── tests/
│   └── dre-core-modules.test.ts # 93 tests, 22 describe 组
├── README.md
└── package.json
```

## 8. 架构速查

| 你想做什么? | 看哪里? |
|------------|---------|
| 理解整体架构 | `docs/AXIOM-ARCHITECTURE.md` §一, §二 |
| 理解设计哲学 | `docs/AXIOM-ARCHITECTURE.md` §〇 |
| 查看所有 MCP 工具 | `docs/AXIOM-ARCHITECTURE.md` §三 |
| 添加新 Persona 模式 | `src/dre/persona/loader.ts` — `BUILTIN_PERSONA_BASE` |
| 修改认知管道步骤 | `src/dre/pipeline/cognitive-pipeline.ts` — `run()` |
| 添加新约束 | `src/dre/constraint/solver.ts` — `RESOURCE_CONSTRAINTS` 等 |
| 修改记忆策略 | `src/dre/consciousness/stream.ts` — `EpisodicMemory` |
| 添加新的 MCP 工具 | `src/mcp/server.ts` — `registry.add()` |
| 写测试 | `tests/dre-core-modules.test.ts` — 添加 `describe()` 块 |
