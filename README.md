# 🦅 OpenClaw AI Agent v2.8.2

> 基于 Bun + TypeScript 的 AI Agent，以 Obsidian Vault 为核心记忆引擎，采用确定性推理（零向量、零 embedding），所有 Agent 共享同一 Markdown 记忆库。

[![Tests](https://img.shields.io/badge/tests-500%20pass-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-zero%20errors-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw AI Agent v2.8.2              │
├─────────────────────────────────────────────────────────┤
│  前端 (4 页)                                             │
│  ├─ Home: 欢迎 + 快速输入                                │
│  ├─ Chat: 流式对话 + 会话侧边栏                          │
│  ├─ Search: 统一搜索                                     │
│  └─ Settings: 主题 + 行为 + 系统状态                     │
├─────────────────────────────────────────────────────────┤
│  规划层: 第一性原理 + 反幻觉 + LRU 缓存                  │
│  路由层: 贝叶斯专业度 + 受保护快速路径 + 归一化评分       │
│  意识层: EWMA 自适应 + 话题漂移 + WebSocket              │
│  工具层: 动态生成 + 中间件管道 + 组合执行                 │
│  错误处理: 上下文感知恢复建议                             │
├─────────────────────────────────────────────────────────┤
│  API: 90+ 端点 (GET /health, /api, POST /chat, ...)     │
└─────────────────────────────────────────────────────────┘
```

## 核心特性

### 🧠 规划优先 + 反幻觉

- **第一性原理约束** — 每次推理前分解为原子事实
- **声明级验证** — 年份/工具引用/前提走私检测
- **DRE 风险评分** — 黑名单/长度/来源风险叠加
- **Noisy-OR 聚合** — 多声明联合幻觉概率

### 🔀 意识感知动态路由

- **统一路由器** — 取代 4 套分散路由器
- **贝叶斯专业度推断** — 后验概率替代单样本阈值
- **受保护快速路径** — 检查失败/漂移/疲劳后才使用
- **EWMA 自适应异常检测** — 控制图替代固定阈值

### 🔧 自适应工具系统

- **ToolFactory** — 动态生成 REST/CLI/转换/管道工具
- **ToolMiddleware** — 验证/模式守卫/缓存/指标/断路器
- **ToolComposition** — 顺序/并行/条件/错误恢复管道
- **ExecutionMode** — Plan/Agent/YOLO 模式守卫

### 🎨 前端做减法

- **4 页精简** — Home/Chat/Search/Settings
- **启动动画** — 线框绘制 + 径向填充
- **会话侧边栏** — Chat 集成会话管理

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/ListenJ/openclaw-fusion.git
cd openclaw-fusion

# 2. 安装依赖
bun install
cd frontend && npm install && cd ..

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 API 密钥

# 4. 启动服务
bun run start

# 5. 打开浏览器
open http://localhost:18789
```

## 环境变量

```bash
# 必需
OPENCLAW_AUTH_TOKEN=your-auth-token

# 可选 (至少一个 LLM 提供商)
SILICONFLOW_API_KEY=your-key
DEEPSEEK_API_KEY=your-key
OPENROUTER_API_KEY=your-key

# 可选 (搜索)
SERPAPI_API_KEY=your-key

# 可选 (GitHub)
GITHUB_TOKEN=your-token
```

## API 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/health` | 系统健康 + 模块状态 |
| GET | `/api` | API 文档 (自动生成) |
| GET | `/metrics` | Prometheus 格式指标 |
| POST | `/chat` | 流式对话 |
| GET | `/search?q=...` | 统一搜索 |
| GET | `/vault/stats` | Vault 统计 |
| GET | `/agents/status` | Agent 状态 |
| GET | `/consciousness/status` | 意识状态 |

完整 API 文档见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 项目结构

```
openclaw-fusion/
├── src/
│   ├── agents/
│   │   ├── planning/          # 规划层
│   │   │   ├── planner.ts     # 复杂度分类 + LLM 规划
│   │   │   ├── verifier.ts    # 声明级验证
│   │   │   └── first-principles.ts
│   │   └── consciousness/     # 意识层
│   │       ├── trace-analyzer.ts  # EWMA 异常检测
│   │       └── activity-tracker.ts # 话题漂移
│   ├── router/
│   │   ├── unified-router.ts  # 统一路由
│   │   ├── context-scorer.ts  # 贝叶斯评分
│   │   └── route-strategy.ts  # 断路器策略
│   ├── mcp/
│   │   ├── tool-factory.ts    # 动态工具生成
│   │   ├── tool-middleware.ts  # 中间件管道
│   │   ├── tool-composition.ts # 工具组合
│   │   └── server.ts          # MCP 服务器
│   └── routes/
│       ├── chat.ts            # 聊天路由
│       ├── health.ts          # 健康检查
│       └── ...
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Home.tsx       # 欢迎页
│       │   ├── Chat.tsx       # 流式对话
│       │   ├── Search.tsx     # 统一搜索
│       │   └── Settings.tsx   # 设置
│       └── components/
│           └── layout/
│               └── OpeningAnimation.tsx
├── tests/                     # 507 测试
├── docs/
│   └── ARCHITECTURE.md        # 完整架构文档
└── config/
    ├── openclaw.yaml          # 主配置
    └── model-router.yaml      # 路由配置
```

## 测试

```bash
# 运行所有测试
bun test tests/

# 运行特定测试
bun test tests/planning.test.ts

# TypeScript 检查
bunx tsc --noEmit

# 前端构建
cd frontend && npx vite build
```

### 测试统计

```
总计: 507 tests across 43 files
通过: 500 pass
跳过: 6 skip (MiniMax API key)
失败: 1 fail (DataPipeline 网络超时)
错误: 1 error (OCR tesseract.js 依赖)
```

## 论文引用

| 论文 | arXiv | 应用 |
|------|-------|------|
| Fine-Grained UQ | 2602.17431 | 贝叶斯专业度推断 |
| MARCH | 2603.24579 | 受保护快速路径 |
| RT4CHART | 2603.27752 | 声明级幻觉检测 |
| Premise Smuggling | 2606.24902 | 前提走私检测 |
| RefChecker | 2405.14486 | 声明三元组 |
| AEGIS | 2603.20637 | 图引导推理 |
| 控制图理论 | — | EWMA 自适应阈值 |

## 版本历史

| 版本 | 日期 | 主要变更 |
|------|------|---------|
| v2.8.2 | 2026-06-28 | 规划层 + 动态路由 + 工具系统 + 前端精简 |
| v2.3.0 | 2026-06-20 | Rust 原生核心 + 双版本 + 统一 TUI |
| v2.2.0 | 2026-06-10 | 扁平路由架构 + 快速键 CLI |
| v2.1.0 | 2026-06-01 | 智能任务分配 + 模型能力注册表 |
| v2.0.0 | 2026-05-20 | 初始发布 |

## 相关文档

- [完整架构文档](docs/ARCHITECTURE.md)
- [API 端点文档](http://localhost:18789/api) (运行时访问)
- [系统健康状态](http://localhost:18789/health) (运行时访问)

## 许可证

MIT License
