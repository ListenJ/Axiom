---
created: 2026-05-25
type: agent-rules
version: 2.1
---

# AGENTS — 会话启动规则

> **核心原则**: Obsidian Vault 是所有 Agent 的**唯一共享记忆库**。
> 没有独立的"每个 Agent 的记忆"，所有 Agent 读写同一 Vault 中的 Markdown 文件。
> 检索采用**确定性推理**（关键词 + 关系 + PARA 结构），**零向量、零 embedding**。

## 启动检查清单

每次会话开始时执行：

- [ ] 读取 `SOUL.md` 确认人格边界
- [ ] 读取 `USER.md` 确认用户偏好
- [ ] 读取 `MEMORY.md` 加载系统级记忆
- [ ] 检查当日日志 `memory/YYYY-MM-DD.md`
- [ ] 确认可用模型列表（查询 `free_models` 表）
- [ ] **(新)** 调用 `memory_search` 检索与当前主题相关的 Vault 笔记

## 记忆管理策略

### Vault 作为唯一真理来源

```
openclaw-memory/           ← 所有 Agent 共享此目录
├── 00-Meta/               ← 元数据（人格、规则、身份）
│   ├── SOUL.md            ← 所有 Agent 共享同一人格
│   ├── AGENTS.md          ← 本文件
│   ├── IDENTITY.md        ← 系统身份
│   ├── MEMORY.md          ← 长期事实记忆
│   ├── USER.md            ← 用户偏好
│   └── ...
├── 01-Projects/           ← 项目（有明确截止日期）
├── 02-Areas/              ← 领域（长期责任）
├── 03-Resources/          ← 资源（参考材料、代码索引、原子笔记）
│   ├── web-clips/         ← 爬取的网页
│   ├── search-results/    ← 搜索结果
│   ├── code-index/        ← 项目代码索引（自动）
│   └── atomic-notes/      ← Zettelkasten 原子笔记
├── 04-Conversations/      ← 会话日志
├── 05-Archives/           ← 归档
└── memory/                ← 每日日志
```

### 写入规则

| 记忆类型 | 写入时机 | 存储位置 | 工具 |
|---------|---------|---------|------|
| 会话日志 | 每次交互后 | `memory/YYYY-MM-DD.md` | `memory_write` |
| 重要事实 | 用户明确确认 | `MEMORY.md` | `memory_write` |
| 用户偏好 | 首次发现或变更 | `USER.md` | `memory_write` |
| 项目素材 | 研究/编码产出 | `01-Projects/{name}/` | `memory_write` |
| 知识沉淀 | 经蒸馏的通用知识 | `03-Resources/atomic-notes/` | `memory_atomic` |
| 网页爬取 | 自动（Pipeline） | `03-Resources/web-clips/{domain}/` | `web_fetch` |
| 搜索结果 | 自动（Pipeline） | `03-Resources/search-results/` | `web_search` |
| 代码索引 | 自动/手动 | `03-Resources/code-index/` | `code_index` |

### 确定性检索规则（无向量）

检索优先级（从高到低）：

1. **精确匹配** — 文件名、标题、alias、ID（得分 85-100）
2. **关键词匹配** — 标题(3x) > 标签(2.5x) > 内容(1x) > 路径(0.5x)
3. **关系推导** — wiki-link 出链(+10)、入链(+8)、2跳网络(+4)
4. **PARA 语义** — 同分类笔记(+5)
5. **知识图谱** — 通过 KG 实体关联到 Vault 笔记

**检索工具链**：
```
memory_search(query)           ← 全文确定性搜索
memory_browse(para/category)   ← PARA 分类浏览
memory_browse(tag/name)        ← 标签浏览
memory_network(path, depth)    ← wiki-link 网络遍历
memory_read(path)              ← 读取单篇笔记
```

### 记忆共享协议

所有 Agent 遵循以下约定：

- **YAML frontmatter 是接口** — 所有笔记必须有标准的 frontmatter（title, type, created, tags, source）
- **wiki-link 是关系** — 用 `[[Note Name]]` 建立笔记间关联
- **标签是分类** — `#tag` 或 frontmatter `tags: [a, b]`
- **PARA 是目录** — 笔记按 Projects/Areas/Resources/Archives 存放
- **原子笔记是知识单元** — 一个笔记 = 一个独立想法，通过 `memory_atomic` 创建

## 工具使用规范

### 优先级

1. **本地工具**（Vault 读写、数据库查询）— 零成本、低延迟
2. **免费模型**（硅基流动 / OfoxAI 免费层）— 零成本、中等延迟
3. **付费模型**（DeepSeek V4-Flash）— 低成本、高质量
4. **高级模型**（DeepSeek V4-Pro / Claude）— 高成本、复杂推理

### 降级策略

当工具/模型失败时：
- HTTP 429 → 等待 1 秒后重试，最多 3 次
- HTTP 5xx → 立即切换同级备用模型
- 超时 >10s → 降级到下一 Tier
- 全部失败 → 返回错误，不静默忽略
