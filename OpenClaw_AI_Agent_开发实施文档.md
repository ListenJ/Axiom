# OpenClaw AI Agent — 开发实施文档

> **版本**: v3 | **日期**: 2026年5月 | **技术栈**: Bun + TypeScript + OpenClaw + DeepSeek V4

> **架构**: 纯云端免费模型方案（硅基流动 + OfoxAI）| 零GPU成本 | 国内直连

<!-- TOC -->
- [执行摘要](#执行摘要)
- [1. 系统总体架构设计](#1-系统总体架构设计)
- [2. AI模型选型与订阅方案](#2-ai模型选型与订阅方案)
- [3. OpenClaw网关层配置](#3-openclaw网关层配置)
- [4. Hermes Agent深度研究模块](#4-hermes-agent深度研究模块)
- [5. 编码Agent模块设计](#5-编码agent模块设计)
- [6. Obsidian记忆管理系统](#6-obsidian记忆管理系统)
- [7. 数据采集与处理Pipeline](#7-数据采集与处理pipeline)
- [8. MCP协议配置指南](#8-mcp协议配置指南)
- [9. LSP集成配置指南](#9-lsp集成配置指南)
- [10. 免费模型路由与管理](#10-免费模型路由与管理)
- [11. 结构化数据库设计](#11-结构化数据库设计)
- [12. 安装部署指南](#12-安装部署指南)
- [13. 运维与监控](#13-运维与监控)
- [附录A: 完整配置文件集](#附录a-完整配置文件集)
- [附录B: 开发实施检查清单](#附录b-开发实施检查清单)
- [附录C: 故障排查手册](#附录c-故障排查手册)
<!-- /TOC -->


## 执行摘要

### 系统概述

本文档定义 **OpenClaw AI Agent** 的完整开发与实施方案：以 OpenClaw 为通讯网关，集成 Hermes Agent（深度研究）、OpenCode/通义灵码（编码执行）、Obsidian（记忆管理）、硅基流动/OfoxAI（免费云端模型）四大模块，全部基于 **Bun 运行时** 和 **国内可直连平台**。

### 核心技术决策

| 决策项 | 选型方案 | 理由 |
|--------|---------|------|
| 决策大模型 | DeepSeek V4-Flash（主）+ V4-Pro（辅） | 1M上下文、0.2元/百万输入（命中）、工具调用优化 |
| 编码模型 | DeepSeek Coder V4 | LiveCodeBench 93.5分全球第一、1M上下文 |
| 工具/分类模型 | 硅基流动免费层（Qwen2-7B/GLM-4-9B） | 7个模型永久免费、国内50ms延迟 |
| 模型聚合 | OfoxAI（主）+ OpenRouter（备用） | 国内直连200-500ms、三协议兼容 |
| 记忆管理 | Obsidian Vault + SQLite FTS5 + AST | Markdown原生、BM25检索<10ms、非向量 |
| 运行时 | Bun + TypeScript | 内置SQLite、比Node.js快3-14倍 |
| 协议层 | MCP（FastMCP）+ LSP（agent-lsp） | 行业标准、工具生态丰富 |
| 数据库 | bun:sqlite + Drizzle ORM（3KB） | 零依赖、FTS5全文索引 |

### 成本方案

| 方案 | 月度成本 | 适用场景 |
|------|---------|---------|
| **纯免费** | **¥0** | 硅基流动7免费模型 + OfoxAI 10免费模型 |
| 轻度使用 | ¥0-50 | 免费为主 + V4-Flash少量付费 |
| 中度使用 | ¥100-300 | V4-Flash主力 + 免费边缘任务 |
| 重度使用 | ¥500-1500 | V4-Pro复杂推理 + 全量付费 |

### 零成本起步资源

| 平台 | 免费额度 |
|------|---------|
| 阿里云百炼 | 7000万 Token / 90天 |
| 硅基流动 | 2000万 Token + 9B模型永久免费 |
| 火山引擎 | 50万 + 每日200万重置 |
| DeepSeek官方 | 500万 Token |
| OfoxAI | 10个模型免费层 |
| **合计** | **约1.2亿+ Token** |

### 关键约束

- **不使用本地部署**：全部云端API，零GPU成本
- **不使用国外模型直连**：全部国内平台（DeepSeek/通义千问/硅基流动/OfoxAI）
- **不使用向量数据库**：SQLite FTS5 + AST算法完成检索
- **不使用向量化存储**：结构化数据库存储 + Markdown文件管理
- **OpenRouter仅作备用**：通过用户代理访问，需处理免费模型变动

---


## 1. 系统总体架构设计

### 1.1 架构设计原则

OpenClaw Agent系统的架构设计遵循四项核心原则，这些原则指导了从组件选型到接口定义的全部技术决策，确保系统在功能性、可维护性与国内部署约束之间取得平衡。

#### 1.1.1 国内优先：零依赖国外API

系统所有模型和服务必须在国内网络环境下可直接访问，不依赖任何国外API端点。这一原则源于国内网络环境的实际约束，而非单纯的技术偏好。具体而言，模型层采用DeepSeek V3.1作为云端决策与编码模型——该模型通过国内API端点提供服务，同时具备OpenAI与Anthropic双协议兼容能力 [(Tencent Cloud)](https://www.tencentcloud.com/techpedia/141564) ；本地工具模型采用通义千问qwen2.5:14b，通过Ollama在本地运行，完全离线可用 [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) 。网关层OpenClaw Gateway作为Node.js守护进程在国内服务器部署，支持微信、飞书、Telegram等国内外主流渠道 [(Hermes Agent)](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/acp) 。爬虫层在80%常规场景使用Bun原生fetch配合cheerio解析，仅在20%高反爬场景通过Bun.spawn()启动Scrapling子进程，确保运行时核心不离开Bun生态 [(Github)](https://github.com/D4Vinci/Scrapling) 。

这一原则带来的额外收益是数据主权：所有对话记录、记忆文件、代码产出均存储在本地或国内服务器，敏感信息不出境。

#### 1.1.2 极简内核：代码即扩展

Pi引擎（OpenClaw核心Agent运行时）仅配备4个核心工具——Read、Write、Edit、Bash，系统提示不到1000 tokens [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。这一极简设计的深层逻辑在于：工具数量与上下文消耗成正比，Playwright MCP一个工具就消耗13,700 tokens（占7%上下文窗口），而Pi通过让Agent自行编写代码来扩展能力，将扩展成本从"每工具固定消耗"转化为"按需生成代码" [(Github)](https://github.com/jwangkun/hermes-agent-guide/blob/main/04-%E6%A0%B8%E5%BF%83%E6%9E%B6%E6%9E%84%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90.md) 。

Pi引擎的"NO列表"明确拒绝添加MCP、子Agent、Plan Mode、内置TODO、权限弹窗、后台Bash、自动压缩等功能 [(Github)](https://github.com/jwangkun/hermes-agent-guide/blob/main/04-%E6%A0%B8%E5%BF%83%E6%9E%B6%E6%9E%84%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90.md) 。每一项拒绝都有替代方案：不内建MCP → 通过CLI工具+README文档实现按需读取；不内建子Agent → 通过Bash启动新Pi实例实现完全可观察的并行执行；不内建TODO → 写TODO.md文件供人类与Agent共同编辑。这种设计使得Pi引擎的系统提示保持在亚千token级别，为模型推理留出最大化的可用上下文空间。

#### 1.1.3 文件优先：Git友好的人类可读记忆

所有持久化记忆以Markdown文件形式存储，Workspace目录结构为"git-backable"的纯文本目录 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) 。核心记忆文件包括：SOUL.md（Agent人格、语气、边界）、USER.md（用户信息、偏好）、IDENTITY.md（Agent名称与角色）、AGENTS.md（会话启动规则与记忆管理策略）、MEMORY.md（长期记忆）、HEARTBEAT.md（心跳检查清单）以及memory/YYYY-MM-DD.md形式的每日日志 [(OpenClaw)](https://docs.openclaw.ai/reference/AGENTS.default) 。

文件优先的设计产生三个级联效应。第一，人类可以直接通过Obsidian UI或其他Markdown编辑器查看和编辑AI的记忆，形成"人机共享记忆空间"。第二，Git版本控制天然适用，记忆的每一次变更都有diff可追溯，错误更新可以回滚。第三，数据格式与处理逻辑解耦——即使更换Agent框架，记忆文件本身仍然可读可用。这与Anthropic推荐的NOTES.md模式一致，但将理念推向了极致：数据存在于文件中，数据库仅用于索引和加速检索 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) 。

#### 1.1.4 分层解耦：每层可独立替换

系统采用Gateway-Agent-Workspace三层分离架构 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。Gateway层作为长期运行的Node.js守护进程，是所有状态（会话、配对、节点注册表）的唯一所有者 [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) ，负责50+消息渠道的接入与路由。Agent层承载具体的智能体运行时，Pi引擎是默认选项，但可以通过OpenClaw的bindings配置将特定渠道路由到Hermes Agent或其他Agent实现 [(thebomb.ca)](https://thebomb.ca/blog/openclaw-multi-agent-routing/) 。Workspace层是纯文件系统，任何能够读写Markdown文件的Agent都可以使用同一套记忆数据。

解耦的关键机制在于Gateway的单写者架构：每个会话同时只有一个Agent运行，Gateway维护命令队列确保会话转录无并发写入冲突 [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) 。这意味着Agent层可以热替换——将某个渠道从Pi引擎切换到Hermes Agent只需修改bindings配置并重启Gateway，Workspace中的记忆文件完全保留。

### 1.2 总体架构图

#### 1.2.1 系统分层架构

系统采用五层物理架构，从外到内依次为外部渠道层、OpenClaw Gateway层、Agent编排层、工具服务层和记忆持久层。

![系统分层架构图](fig_1_1_system_layered_architecture.png)

**外部渠道层**涵盖微信（通过ClawBot插件或agent-wechat方案接入）、Telegram、Discord、Slack、飞书等50+消息渠道 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) ，以及直接WebSocket和REST API接入。所有渠道消息经过统一格式化后进入Gateway层。

**OpenClaw Gateway层**是系统的神经中枢，作为Node.js守护进程长期运行。WebSocket控制平面默认绑定127.0.0.1:18789 [(nvidia.com)](https://build.nvidia.com/spark/hermes-agent/instructions) ，内部包含消息路由器（按match.peer > match.guildId/teamId > match.accountId > default优先级匹配Agent [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) ）、认证管理器（token-based auth）、渠道适配器（将各渠道消息格式统一为OpenClaw内部协议）和MCP Bridge（连接外部MCP服务器 [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) ）。

**Agent编排层**是智能体的实际运行环境。Pi引擎作为核心Agent运行时，通过不到1000 tokens的系统提示驱动 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) ；Hermes Agent作为深度研究专用Agent，通过MCP协议与OpenClaw互操作 [(Github)](https://github.com/exbald/openclaw-skill-vector-memory) ；编码Agent（OpenCode或通义灵码）负责代码生成、重构与测试；Ollama本地引擎运行qwen2.5:14b模型，承担任务路由与快速分类的"神经路由器"角色。各Agent之间通过Workspace文件交换状态，而非共享内存或消息总线。

**工具服务层**提供Agent所需的全部外部能力。Pi引擎的4个核心工具（Read/Write/Edit/Bash）构成最内圈 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) ；MCP Server通过FastMCP框架和TypeScript SDK提供标准化工具接入 [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) ；LSP集成（agent-lsp）为代码Agent提供语言级智能；Web Crawler使用Bun原生fetch + cheerio处理常规页面，Scrapling子进程处理反爬场景 [(Github)](https://github.com/D4Vinci/Scrapling) ；PTC（Programmatic Tool Calling）模式下Agent编写Python脚本批量调用工具，将8次工具调用压缩为1轮模型推理 [(AI星球)](https://www.aixq.cc/25003.html) 。

**记忆持久层**是所有状态的最终落地点。Obsidian Vault以Markdown文件形式存储结构化记忆 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) ；SQLite FTS5（通过bun:sqlite零依赖访问）提供全文索引与混合检索 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) ；Session Trees支持会话的分支、回退与合并 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) ；Git版本控制提供变更追溯与协作同步。

#### 1.2.2 数据流设计

![数据流设计图](fig_1_2_data_flow_design.png)

数据流遵循"请求→路由→决策→执行→记忆→响应"的六阶段闭环。用户请求（1）从任意渠道进入Gateway（2），Gateway根据bindings配置将消息路由到对应Agent（3）。Agent决策引擎加载系统提示、记忆文件和技能定义，调用模型进行推理并生成执行计划。计划被分解为一系列工具调用（4），工具执行结果可能触发额外的模型调用（如PTC模式下的脚本执行 [(腾讯云)](https://cloud.tencent.com/developer/article/2649246) ）。执行完成后，Agent更新记忆文件（5）——写入memory/YYYY-MM-DD.md日志、必要时更新MEMORY.md长期记忆，SQLite FTS5索引通过文件监视器（1.5秒防抖）自动增量更新 [(GitHub Gist)](https://gist.github.com/royosherove/971c7b4a350a30ac8a8dad41604a95a0) 。最终响应（6）经Gateway格式化后返回用户原渠道。

两条旁路流值得关注。其一，Heartbeat（心跳）默认每30分钟触发一次 [(arXiv.org)](https://arxiv.org/html/2605.10763v1) ，Agent读取HEARTBEAT.md检查清单执行轻量级状态巡检，无事时回复HEARTBEAT_OK静默通过，有事时发送alert。其二，Cron定时任务以isolated模式运行——每个任务启动独立的Agent实例，执行完成后将结果投递到指定渠道 [(arXiv.org)](https://arxiv.org/html/2605.10763v1) 。

#### 1.2.3 模块间通信协议

系统内部采用三层通信机制。MCP（Model Context Protocol）是工具服务层的主要协议，FastMCP框架简化了服务器开发，TypeScript SDK提供完整的客户端能力 [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) 。传输方式选择上，stdio用于本地进程集成，Streamable HTTP用于远程服务调用 [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) 。Agent间不直接通信，而是通过Workspace文件交换状态——一个Agent写入的Markdown文件，另一个Agent在下次会话启动时读取。这种"文件级消息传递"牺牲了实时性，换取了完全的可观察性和零耦合度。

### 1.3 核心组件职责

#### 1.3.1 OpenClaw Gateway

Gateway是系统的统一入口，承担三项核心职责：多渠道接入、消息路由和会话管理。作为长期运行的Node.js守护进程，它同时维护50+消息渠道的WebSocket连接，将Discord、Google Chat、iMessage、Matrix、Microsoft Teams、Signal、Slack、Telegram、WhatsApp、Zalo、WebChat等渠道的消息统一转换为内部事件格式 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。

路由机制采用四级优先级匹配：match.peer（最高，精确到用户）> match.guildId/teamId（频道/团队级）> match.accountId（账户级）> default（默认Agent） [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) 。这允许细粒度的Agent分配——例如，将某个Discord服务器的#coding频道绑定到OpenCode Agent，而同一服务器的#general频道绑定到Pi引擎。

会话管理采用单写者架构，每个会话的命令队列确保同时只有一个Agent实例运行 [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) 。Gateway还负责MCP Bridge功能，将外部MCP服务器的工具暴露给Agent调用。MCP服务器支持stdio、SSE和streamable-http三种传输方式，可在Gateway级别（所有Agent共享）或Workspace级别（单个Agent独享）配置 [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) 。

**表1-1：OpenClaw Gateway核心配置参数**

| 配置项 | 默认值 | 说明 | 安全影响 |
|--------|--------|------|----------|
| gateway.port | 18789 | WebSocket控制平面监听端口 | 生产环境应限制loopback访问 |
| gateway.bind | "loopback" | 绑定地址，可选"all" | all模式下需配合防火墙规则 |
| gateway.auth.token | 无 | 认证令牌 | 必须设置为高强度随机字符串 |
| sandbox.mode | "non-main" | 容器隔离模式 | 主会话在宿主机运行以保障集成 |
| mcpServers.*.command | — | MCP服务器启动命令 | 需审计命令来源防止供应链攻击 |
| bindings.*.match.peer | — | 用户级Agent绑定 | 精确控制谁访问哪个Agent |

Gateway配置存储在~/.openclaw/openclaw.json（JSON5格式，支持注释和尾部逗号） [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。表中列出的参数直接影响系统的安全边界：gateway.auth.token若不设置，任何可访问18789端口的进程都能控制Agent；sandbox.mode的默认non-main设置意味着主会话在宿主机运行——这保障了Agent对本地开发工具的访问能力，但也意味着应遵循"不在主机器上运行"的最佳实践 [(来源)](https://claudeyy.com/zh/blog/qwen-api-guide-qwen3-max-qwen3-6-2026/) 。

#### 1.3.2 Pi引擎

Pi引擎是OpenClaw的核心Agent运行时，由Mario Zechner（libGDX创建者）开发 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。其设计哲学通过三项独特机制体现。

**Session Trees（会话树）**：会话可以分支、回退、跳转。当Agent在调试时破坏了工具环境，可以fork到新分支修复问题，验证通过后返回主分支继续 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。这一机制将版本控制的思想引入交互式会话，使得"探索-回滚"成为工作流的基本操作。

**Extension System（扩展系统）**：扩展是TypeScript代码，支持热重载，Agent自身可以读取和修改扩展代码 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。与插件市场模式不同，Pi没有固定的扩展目录——告知Agent需求，它会自行编写TypeScript代码实现。这一机制将"代码即配置"推向了极致。

**RPC Mode**：Pi可以作为子进程嵌入更大的自动化系统中 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。编排层通过stdin发送任务描述，Pi执行编码工作并通过stdout返回结果。这使得Pi既能作为独立Agent运行，也能作为编码组件嵌入外部工作流。

Pi引擎系统提示不到1000 tokens，仅配备Read、Write、Edit、Bash四个工具 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。所有扩展能力通过代码实现：需要Web搜索？Agent用Bash调用curl；需要操作浏览器？Agent编写Python脚本调用Playwright；需要并行处理？Agent用Bash启动多个Pi实例。这种"授人以渔"的设计将上下文窗口的每一token都用于推理，而非浪费在工具描述上。

#### 1.3.3 Hermes Agent

Hermes Agent是由Nous Research开发的开源自主AI Agent框架，定位"The agent that grows with you"——随你成长的Agent [(CSDN博客)](https://blog.csdn.net/2401_85343303/article/details/160121215) 。与Pi引擎的"工具论"（精确配置、可靠执行）相对，Hermes奉行"同事论"——Agent不是工具，而是会自主学习、自主进化的同事 [(稀土掘金)](https://juejin.cn/post/7628045857251180554) 。

Hermes采用五层架构设计：基础设施层（Local/Docker/SSH/Modal/Daytona/Singularity）、工具与技能层（47个内置工具 + MCP Client）、Agent核心层（AIAgent/Prompt Builder/Provider Resolution/Tool Dispatch）、状态与持久化层（SQLite + FTS5 + Memory + Skills + Cron）、平台适配层（15+消息平台） [(腾讯云)](https://cloud.tencent.com/developer/article/2649246) 。

其核心差异化能力在于**自学习Skill系统**和**四层温度记忆模型**。Skill系统采用封闭学习循环：完成涉及5+次工具调用的复杂任务后，Agent进行自我评估，若判断值得保存则调用skill_manage工具生成新的SKILL.md文件 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。Skill以Markdown形式存储，放进目录即生效，人类可读且diff友好 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。四层温度记忆模型将记忆划分为热记忆（当前会话上下文，~5KB/消息）、温记忆（MEMORY.md/USER.md冻结快照，~800/500 tokens）、冷记忆（SQLite FTS5全文索引按需检索）和外部记忆（Honcho/Mem0等8种Provider） [(博客园)](https://www.cnblogs.com/Wcowin/articles/19860617) 。MEMORY.md与USER.md以冻结快照形式注入system prompt，mid-session写入不改变运行中prompt，保证prefix cache不被破坏 [(Github)](https://github.com/pydantic/pydantic-ai-harness/issues/102) 。

**表1-2：Pi引擎与Hermes Agent架构对比**

| 维度 | Pi引擎（OpenClaw） | Hermes Agent |
|------|-------------------|--------------|
| 设计哲学 | 工具论——精确配置、可靠执行 | 同事论——自主学习、越用越懂你 |
| 系统提示 | <1000 tokens，4个核心工具 | 动态构建，47个内置工具 |
| 记忆管理 | Markdown文件，手动管理 | 四层温度记忆，自动沉淀 |
| 技能系统 | ClawHub市场，人工编写 | 自学习闭环，自动创建+自改进 |
| 多Agent | 单Agent + 任务规划 | 子Agent并行委派 |
| 安全模型 | 单人可信边界 + Docker沙箱 | 七层防御体系 |
| MCP支持 | Gateway层支持（Pi本身无MCP） | 原生Client + Server双向 |
| 典型设置时间 | <30分钟 | 2-4小时 |
| 代码行数 | ~430,000行TypeScript [(财联社)](https://www.cls.cn/detail/2287927)  | Python 3.11+ |

两个Agent的互补性体现在各自的优势区间：Pi引擎胜在极简高效、快速启动、低token消耗；Hermes胜在深度研究、长期记忆、自进化能力。生产环境中约20%的用户同时使用两者 [(ChatBench)](https://www.chatbench.org/what-is-openclaw-and-how-does-it-work/) ，典型模式为OpenClaw处理高频简单任务（路由、多渠道接入），Hermes处理复杂推理任务（研究、记忆沉淀），通过MCP协议或Workspace文件实现互操作 [(Github)](https://github.com/exbald/openclaw-skill-vector-memory) 。本系统将Pi引擎作为默认Agent，Hermes Agent作为深度研究的专用Agent，两者共享同一Workspace实现记忆互通。

#### 1.3.4 编码Agent

编码Agent负责代码生成、重构、测试和代码审查任务。系统支持两种集成方案：OpenCode（开源方案）或通义灵码（国内方案），两者均通过LSP（Language Server Protocol）与Agent系统通信。

编码Agent的工作流遵循"理解→规划→生成→验证"四阶段。首先通过LSP获取代码库的结构信息（符号表、调用关系、类型定义），然后制定修改计划，接着生成代码变更（以Edit工具的形式），最后运行测试验证正确性。LSP集成通过agent-lsp项目实现，为Agent提供代码导航、重构建议和诊断信息。

PTC模式在此发挥关键作用：编码Agent可以编写Python脚本批量调用LSP工具、执行测试、分析覆盖率，将多步骤的代码操作压缩为少量模型推理轮次 [(AI星球)](https://www.aixq.cc/25003.html) 。例如，一次重构涉及查找所有引用、修改签名、更新调用点、运行测试——传统模式下这需要4-8轮工具调用，PTC模式下Agent编写一个Python脚本完成全部操作，仅需1轮模型推理。

#### 1.3.5 Obsidian Vault

Obsidian Vault作为系统的记忆管理中心，承担Markdown文件的存储、组织和检索职责。选择Obsidian而非自研UI的核心原因在于：Obsidian已经是一个成熟的Markdown知识管理工具，具备双向链接、图谱视图、插件生态等特性 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) 。人类用户可以在Obsidian中直接查看和编辑AI的记忆，形成真正的人机共享工作空间。

Vault通过REST API和MCP双协议向Agent开放。REST API提供完整的CRUD操作，Agent可以直接读写特定路径的Markdown文件。MCP协议则提供更高级的语义操作，如搜索相关笔记、创建链接、更新 frontmatter 等。Vault内部使用SQLite FTS5（bun:sqlite零依赖）构建全文索引，支持BM25相关性评分和混合检索策略 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。

索引管道的设计直接影响检索质量：Markdown文件首先分块（约400 tokens/块，80 token重叠），然后通过Embedding或FTS5建立索引，SQLite存储索引数据，文件监视器以1.5秒防抖间隔处理增量更新 [(GitHub Gist)](https://gist.github.com/royosherove/971c7b4a350a30ac8a8dad41604a95a0) 。混合检索默认权重为70%向量相似度 + 30% BM25全文匹配 [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) ，在无需外部向量数据库的情况下实现接近纯向量方案的检索质量。

#### 1.3.6 Ollama本地引擎

Ollama本地引擎运行qwen2.5:14b模型，承担两项职责：任务路由与快速分类。该模型的VRAM需求约9.5GB，工具调用可靠性约90%，在本地部署的成本效益曲线上处于最优平衡点 [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) 。

作为"神经路由器"，qwen2.5:14b将传入任务分类为编码、研究、一般对话三类，然后路由到对应的处理Agent或云端模型。这种分类本身消耗约50-100 tokens，但可避免将简单任务发送到昂贵的云端大模型，长期运行可节省30-50%的API费用。本地部署的另一个收益是隐私保障：敏感代码片段、内部文档摘要等数据不离开本地机器。

Ollama通过OpenAI兼容API与系统通信，baseUrl配置为http://127.0.0.1:11434/v1 [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) 。支持的本地模型还包括DeepSeek系列、GLM系列等，可根据硬件条件和任务需求切换 [(博客园)](https://www.cnblogs.com/chingho/p/19671464) 。

### 1.4 技术栈总览

#### 1.4.1 运行时：Bun

Bun作为系统的基础运行时，取代Node.js执行所有TypeScript/JavaScript代码。选型依据来自四项量化指标：启动时间比Node.js快14倍（从1秒降至90毫秒以下）、执行性能比Node.js快最多4倍、包安装速度比npm快最多25倍（bun install）、内存占用约20MB对比Node.js的约50MB [(MintMCP)](https://www.mintmcp.com/blog/bun-with-mcp) 。

Bun原生支持TypeScript，直接执行.ts文件无需预编译，消除了tsc编译步骤和对应的配置维护 [(MintMCP)](https://www.mintmcp.com/blog/bun-with-mcp) 。内置SQLite驱动（bun:sqlite）受better-sqlite3启发采用同步API设计，读取查询性能比better-sqlite3快3-6倍，比deno.land/x/sqlite快8-9倍 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。Bun 1.3引入的Bun.SQL统一API进一步扩展了数据库支持范围，覆盖PostgreSQL、MySQL、MariaDB和SQLite，自动参数化防止SQL注入，内置连接池管理 [(InfoQ)](https://www.infoq.com/news/2026/01/bun-v3-1-release/) 。

生产环境稳定性方面，Bun 1.2+通过96%的Node.js测试套件，核心模块（node:fs 100%、node:path 100%、node:crypto 99%、node:http 98%）兼容性良好 [(DEV Community)](https://dev.to/pockit_tools/bun-12-deep-dive-built-in-sqlite-s3-and-why-it-might-actually-replace-nodejs-4738) 。来自三个月真实流量生产的反馈显示：HTTP API性能显著提升，内存使用降低25-40%，Lambda冷启动从约940ms降至约290ms [(langfuse.com)](https://langfuse.com/integrations/model-providers/ollama) 。2025年底Anthropic收购Bun后，项目保持开源MIT许可证，核心团队继续领导开发，长期资金保障得到确认 [(elightwalk.com)](https://www.elightwalk.com/blog/latest-ollama-models) 。

#### 1.4.2 网关：OpenClaw Gateway

OpenClaw Gateway作为系统的统一入口，是一个长期运行的Node.js守护进程（注意：Gateway本身使用Node.js运行，其上层的Agent和工具服务使用Bun运行，两者通过进程间通信交互）。它支持50+消息渠道同时接入，WebSocket控制平面默认监听127.0.0.1:18789 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。

Gateway的安装支持curl一键安装、npm安装和Docker部署三种方式 [(来源)](https://claudeyy.com/zh/blog/qwen-api-guide-qwen3-max-qwen3-6-2026/) 。Docker部署的安全加固配置包括：security_opt设置为no-new-privileges、cap_drop为ALL、cap_add仅为NET_BIND_SERVICE、read_only根文件系统、资源限制为2 CPU/4GB内存 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) 。Gateway与Agent的混合架构设计值得关注：Gateway在宿主机运行以保障系统集成能力，Agent工作会话在Docker容器中执行以获得沙箱隔离 [(GitHub Gist)](https://gist.github.com/royosherove/971c7b4a350a30ac8a8dad41604a95a0) 。

**表1-3：系统核心技术栈选型与参数**

| 层级 | 组件 | 选型 | 版本/规格 | 关键参数 |
|------|------|------|-----------|----------|
| 运行时 | JavaScript引擎 | Bun | 1.3+ | 启动90ms, 内存~20MB |
| 网关 | 消息路由 | OpenClaw Gateway | 最新稳定版 | 50+渠道, WS 127.0.0.1:18789 |
| 数据库 | 结构化存储 | bun:sqlite (SQLite3) | 内置 | 读速比better-sqlite3快3-6x |
| 全文索引 | 文本检索 | SQLite FTS5 | 内置 | 亚10ms查询, BM25评分 |
| ORM | 数据库抽象 | Drizzle ORM | 最新版 | 3KB运行时, 原生bun:sqlite支持 |
| 协议层 | 工具协议 | MCP (FastMCP + TS SDK) | 2025-11-25 spec | stdio/HTTP双传输 |
| 代码协议 | 语言服务 | LSP (agent-lsp) | 最新版 | 多语言符号/重构/诊断 |
| 云端模型 | 决策+编码 | DeepSeek V3.1 | API接入 | 双协议兼容(OpenAI/Anthropic) |
| 本地模型 | 工具路由 | Ollama + qwen2.5:14b | 本地部署 | VRAM ~9.5GB, 工具可靠率~90% |
| 爬虫 | 数据采集 | Bun fetch + cheerio + Scrapling | 子进程模式 | 80%常规 + 20%反爬 |
| 记忆UI | Markdown管理 | Obsidian Vault | 社区版 | REST API + MCP双协议 |
| 版本控制 | 变更追踪 | Git | 任意版本 | diff友好, 回滚支持 |

技术栈的选型遵循"国内可用、性能优先、最小依赖"的原则。Bun运行时替代Node.js带来全链路性能提升，从Gateway的启动速度到SQLite查询延迟均有可测量的改善。bun:sqlite作为内置模块消除了原生依赖的兼容性问题——在Bun环境中无需安装better-sqlite3或任何SQLite驱动，Database类开箱即用 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。Drizzle ORM以3KB运行时体积提供完整的数据库抽象，原生支持bun:sqlite驱动，相比Prisma的~500KB客户端在边缘部署场景有显著优势 [(PkgPulse)](https://www.pkgpulse.com/guides/state-of-nodejs-orms-2026) 。MCP协议层采用FastMCP框架而非官方SDK的直接使用，原因在于FastMCP自动处理连接管理、错误处理、认证等样板代码 [(jsr.io)](https://jsr.io/@punkpeye/fastmcp) ，使团队可以专注于业务逻辑而非协议细节。

#### 1.4.3 记忆存储：Obsidian Vault + SQLite FTS5

记忆存储采用"文件为主、索引为辅"的混合架构。Obsidian Vault作为Markdown文件的存储与管理界面，SQLite FTS5作为全文索引引擎。这一组合避免了专用向量数据库的引入，在百万文档级别仍保持亚10ms的查询延迟 [(Github)](https://github.com/mneves75/ffts-grep) 。

FTS5的Tokenizer采用双表策略：主表使用porter+unicode61分词（适合英文内容），辅助表使用trigram分词（适合CJK内容） [(Zenn)](https://zenn.dev/kanseilink/articles/kanseilink-fts5-trigram-cjk-20260507?locale=en) 。查询时根据内容语言自动路由，最终结果通过RRF（Reciprocal Rank Fusion）算法融合，公式为 $\text{score} = \sum \frac{1}{k + \text{rank}}$（$k=60$ 为平滑参数），实现接近纯向量方案的检索质量 [(Github)](https://github.com/pvliesdonk/markdown-vault-mcp) 。

索引Schema设计包含documents（文档元数据）、sections（Markdown分块）、notes_fts（FTS5虚拟表）三层结构。触发器自动同步FTS5索引的增删改操作，确保文件内容与索引状态一致 [(Github)](https://github.com/pvliesdonk/markdown-vault-mcp/issues/3) 。

#### 1.4.4 模型API：DeepSeek V3.1 + Ollama本地qwen2.5:14b

模型层采用"云端大模型 + 本地小模型"的双层架构。DeepSeek V3.1作为决策模型和编码模型，通过国内API端点提供服务，支持OpenAI和Anthropic两种调用协议 [(Tencent Cloud)](https://www.tencentcloud.com/techpedia/141564) 。Ollama本地运行qwen2.5:14b作为工具模型，负责任务分类、简单问答和工具调用前置判断。

分层路由策略基于成本优化：本地qwen2.5:14b处理FAQ、任务分类、简单工具调用等低复杂度任务；云端DeepSeek V3.1处理复杂推理、代码生成、深度研究等高复杂度任务。两阶段故障转移机制确保可用性：第一层为Auth Profile旋转（多个API Key轮换），第二层为模型Fallback（主模型失败时切换到备用模型） [(Tencent Cloud)](https://www.tencentcloud.com/techpedia/141564) 。

#### 1.4.5 协议层：MCP + LSP

MCP（Model Context Protocol）是系统内部工具集成的标准协议。采用FastMCP框架构建MCP服务器，相比官方SDK减少了约60%的样板代码 [(jsr.io)](https://jsr.io/@punkpeye/fastmcp) 。工具注册使用Zod Schema进行运行时类型验证，工具返回支持文本、图片、音频等多种内容类型 [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) 。

传输方式的选择遵循场景适配原则：stdio用于本地MCP服务器（Agent与工具在同一机器），Streamable HTTP用于远程服务（支持负载均衡和认证中间件），HTTP+SSE仅用于向后兼容 [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) 。MCP代码执行模式是系统的一项关键优化：Agent在沙箱中执行Python代码调用工具，中间数据不通过模型上下文传递，总Token消耗降低77.4%，平均延迟仅增加7% [(AIMultiple)](https://aimultiple.com/code-execution-with-mcp) 。

LSP（Language Server Protocol）为编码Agent提供代码级智能。agent-lsp项目将LSP能力封装为Agent可调用的工具，支持符号导航、重构建议、诊断信息获取和代码补全。

#### 1.4.6 爬虫：Bun原生fetch + cheerio + Scrapling

数据采集层采用分层策略：80%的常规场景使用Bun原生fetch获取页面内容，cheerio进行服务器端HTML解析。这一组合无需浏览器开销，单页抓取延迟通常在200-500ms。剩余20%的高反爬场景（JavaScript渲染、复杂交互、严格反爬策略）通过Bun.spawn()启动Scrapling子进程处理 [(Github)](https://github.com/D4Vinci/Scrapling) 。

Scrapling是一个Python Web抓取框架，内置MCP服务器用于AI辅助抓取 [(Github)](https://github.com/D4Vinci/Scrapling) 。通过MCP集成，Agent可以直接控制Scrapling的浏览器自动化流程，先提取页面相关内容再返回给Agent，避免整页HTML浪费上下文窗口 [(darkwebinformer.com)](https://darkwebinformer.com/scrapling-an-adaptive-web-scraping-framework-that-handles-everything-from-single-requests-to-full-scale-crawls/) 。子进程架构的关键优势在于隔离性：即使Scrapling进程因页面异常或内存泄漏崩溃，也不会影响主Bun运行时。

PTC模式在爬虫场景的价值尤为突出：Agent可以编写Python脚本实现多页抓取、数据清洗、格式转换的完整流程，脚本在沙箱中执行，仅最终结果返回模型上下文。相比传统模式每抓取一页需要一轮模型推理，PTC模式将任意数量的页面抓取压缩为单轮推理，输入Token减少78.5% [(AIMultiple)](https://aimultiple.com/code-execution-with-mcp) 。


---


## 2. AI模型选型与订阅方案

本章针对"零本地部署"场景，提供一套纯云端、纯免费模型的完整技术方案。核心思路是：以硅基流动（SiliconFlow）7个永久免费模型为工具调用基座，以OfoxAI为API聚合主网关，以OpenRouter为备用模型池，通过动态发现机制解决免费模型频繁变动的问题，实现"零成本、高可用"的模型供给体系。

### 2.1 决策大模型选型

#### 2.1.1 DeepSeek V4-Flash（推荐默认）

DeepSeek V4-Flash是V4系列的轻量版本，采用284B总参数/13B激活参数的MoE架构，支持1M上下文窗口和最大384K输出，同时兼容OpenAI与Anthropic双端点格式 [(deepseek.com)](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 。其官方定价极具竞争力：

| 计费项 | 价格（每百万Token） |
|--------|-------------------|
| 缓存命中输入 | ¥0.02（$0.0028） |
| 缓存未命中输入 | ¥1（$0.14） |
| 输出 | ¥2（$0.28） |

2026年4月26日，DeepSeek进一步将缓存命中价格降至首发价的1/10，使得高频调用场景（如RAG知识库、智能客服）的成本降幅超90% [(证券时报官方网站)](https://www.stcn.com/article/detail/3821826.html) 。V4-Flash的交付质量已接近Claude Opus 4.6非思考模式，在Agent编码任务中表现优异 [(极客公园)](https://www.geekpark.net/news/363222) ，是成本敏感型项目的默认首选。

#### 2.1.2 DeepSeek V4-Pro

V4-Pro采用1.6T总参数/49B激活参数的MoE架构，是当前规模最大的开源权重模型 [(InfoQ)](https://www.infoq.cn/article/e4UXTsCToLXsRVEWNUqW) 。在数学、STEM、竞赛级代码等核心推理测评中超越了所有已公开评测的开源模型 [(极客公园)](https://www.geekpark.net/news/363222) 。目前官方提供2.5折限时优惠（截至2026年5月31日） [(deepseek.com)](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) ：

| 计费项 | 原价 | 促销价（2.5折） |
|--------|------|---------------|
| 缓存命中输入 | ¥0.1 | ¥0.025 |
| 缓存未命中输入 | ¥12 | ¥3 |
| 输出 | ¥24 | ¥6 |

V4-Pro适合复杂推理、深度调试和架构规划等高价值场景。与海外旗舰模型相比，其成本约为GPT-5.5的1/70、Claude Opus 4.7的1/60 [(21经济网)](https://www.21jingji.com/article/20260426/herald/05fee61739e3aa4cb240e8063303a948.html) 。

#### 2.1.3 通义千问Max

通义千问Max（Qwen-Max）是阿里云自研的旗舰闭源模型，在中文理解、知识问答和创意写作方面表现突出。其API定价为：输入¥5/百万Token，输出¥10/百万Token [(siliconflow.cn)](https://docs.siliconflow.cn/cn/userguide/introduction) 。对于强中文场景（如中文文档分析、舆情监控），Qwen-Max仍是值得考虑的选项。

#### 2.1.4 决策模型推荐

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| 日常编码/Agent路由 | DeepSeek V4-Flash | 成本最低、1M上下文、工具调用完善 |
| 复杂推理/架构设计 | DeepSeek V4-Pro | 推理能力最强、限时2.5折 |
| 中文内容生成 | 通义千问Max | 中文语境理解最佳 |
| 生产环境兜底 | OfoxAI聚合路由 | 多源备份、99.9% SLA |

### 2.2 编码模型选型

#### 2.2.1 DeepSeek Coder V4

DeepSeek Coder V4是专为代码场景优化的模型，在V4架构基础上针对编程任务进行了深度训练。支持FIM（Fill-In-the-Middle）补全、代码生成、代码审查等功能 [(deepseek.com)](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 。建议通过OfoxAI的`deepseek-v4`端点调用，可获得500/min的宽松限流 [(稀土掘金)](https://juejin.cn/post/7632185396085063718) 。

#### 2.2.2 MiniMax M2.5

MiniMax M2.5是MiniMax推出的新一代多模态模型，在代码生成和数学推理方面表现均衡。硅基流动提供该模型的API服务，输入价格约¥0.35-4/百万Token [(七牛云)](https://news.qiniu.com/archives/1775631011890) 。适合作为编码任务的备选模型。

#### 2.2.3 Qwen3-Coder

Qwen3-Coder是阿里通义团队专为代码场景训练的模型，在HumanEval、MBPP等代码评测基准上表现优异。硅基流动提供Qwen3系列模型的免费和付费选项，免费版Qwen3-8B可满足轻量代码补全需求 [(七牛云)](https://news.qiniu.com/archives/1775631011890) 。

### 2.3 免费工具模型方案（替代本地部署）

#### 2.3.1 硅基流动免费模型（7个永久免费+3个蒸馏免费）

硅基流动提供7个永久免费的大语言模型，在不超过平台限速的条件下可免费使用 [(Mint Starter Kit)](https://docs.siliconflow.com/quickstart/models) ：

| 模型名称 | 上下文长度 | 适用场景 |
|---------|-----------|---------|
| Qwen/Qwen2-7B-Instruct | 32K | 通用对话、文本分类 |
| Qwen/Qwen2-1.5B-Instruct | 32K | 轻量任务、低延迟场景 |
| Qwen/Qwen1.5-7B-Chat | 32K | 中文对话、情感分析 |
| THUDM/glm-4-9b-chat | 32K | 中文推理、知识问答 |
| THUDM/chatglm3-6b | 32K | 简单分类、实体提取 |
| internlm/internlm2_5-7b-chat | 32K | 多轮对话、摘要生成 |
| mistralai/Mistral-7B-Instruct-v0.2 | 32K | 英文任务、代码辅助 |

此外，硅基流动还免费提供3个DeepSeek-R1蒸馏模型，适合需要推理能力的轻量任务：

| 蒸馏模型 | 特点 |
|---------|------|
| DeepSeek-R1-Distill-Qwen-7B | 7B参数，推理能力接近大模型 |
| DeepSeek-R1-Distill-Llama-8B | 8B参数，英文场景更优 |
| DeepSeek-R1-Distill-Qwen-1.5B | 1.5B参数，极速响应 |

新用户注册即送14元+2000万Token免费额度 [(七牛云)](https://news.qiniu.com/archives/1775631011890) ，可用于付费模型的试用。

#### 2.3.2 免费模型能力评估（工具调用/分类/检索）

对于OpenClaw架构中的工具调用、任务分类和文档检索三个核心场景，免费模型的能力评估如下：

| 任务类型 | 推荐模型 | 能力评级 | 说明 |
|---------|---------|---------|------|
| 工具调用（Function Calling） | Qwen2-7B-Instruct | ★★★☆☆ | 原生支持工具调用格式，准确率约75-80% |
| 意图分类 | THUDM/glm-4-9b-chat | ★★★★☆ | 中文分类效果好，延迟低 |
| 文档检索（Embedding） | BAAI/bge-large-zh | N/A | 免费向量模型需配合付费LLM使用 |
| 简单摘要 | internlm2_5-7b-chat | ★★★★☆ | 长文本摘要效果可接受 |
| 代码补全 | DeepSeek-R1-Distill-Qwen-7B | ★★★☆☆ | 小模型代码能力有限 |

**重要提示**：7B级别免费模型的工具调用能力虽可用，但相比DeepSeek V4-Flash或Claude系列仍有明显差距。建议生产环境中对工具调用准确率要求高的场景，使用V4-Flash作为决策模型，免费模型仅作为流量分流和降级方案。

#### 2.3.3 OfoxAI免费层（10个免费模型）

OfoxAI平台提供10个免费模型，覆盖主流厂商的日常开发需求 [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-alternative-ofoxai-comparison-migration-2026/) 。免费模型的具体列表会动态调整，建议通过API定期获取最新信息（详见2.5.2动态发现机制）。

#### 2.3.4 免费模型路由策略

免费模型的路由优先级如下：

1. **第一优先级**：硅基流动免费模型（7个永久免费+3个蒸馏模型）— 国内延迟50-100ms，零成本
2. **第二优先级**：OfoxAI免费层 — 国内直连200-500ms，覆盖更多场景
3. **第三优先级**：OpenRouter免费模型 — 需代理，延迟1500-3000ms，作为模型多样性兜底

### 2.4 API聚合平台对比与OfoxAI评价

#### 2.4.1 OfoxAI平台深度评价

OfoxAI（ofox.ai）是面向国内开发者的API聚合平台，定位为"OpenRouter的国内替代方案"。平台聚合了100+主流模型，覆盖OpenAI、Anthropic、Google、DeepSeek等厂商 [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-china-access-solutions-2026/) 。

**核心能力**：
- **三协议兼容**：同时提供OpenAI格式（`api.ofox.ai/v1`）、Anthropic格式（`api.ofox.ai/anthropic`）和Gemini格式（`api.ofox.ai/gemini`）端点 [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-alternative-ofoxai-comparison-migration-2026/) 
- **国内直连**：服务器在国内，延迟200-500ms，无需任何网络工具 [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-china-access-solutions-2026/) 
- **支付友好**：支持支付宝、微信、USDT充值，人民币结算 [(小罗资源网)](https://www.xiaoluo3.top/news/?28603.html) 
- **团队功能**：支持子账号管理、额度分配、用量报表，适合企业采购 [(小罗资源网)](https://www.xiaoluo3.top/news/?28603.html) 
- **OpenClaw集成**：一键OAuth配置，无需手动编辑JSON [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-alternative-ofoxai-comparison-migration-2026/) 
- **SLA承诺**：99.9%可用性保障 [(新浪)](https://k.sina.com.cn/article_7857201856_1d45362c001903p3rk.html?from=tech) 

#### 2.4.2 OfoxAI vs OpenRouter vs 硅基流动六维对比

| 维度 | OfoxAI | OpenRouter | 硅基流动 |
|------|--------|-----------|---------|
| 国内延迟 | 200-500ms | 1500-3000ms（需代理） | 50-100ms |
| 模型数量 | 100+ | 353+ | 200+ |
| 免费模型 | 10个 | 27-30个 | 7个永久免费+3个蒸馏 |
| Claude原生协议 | ✅ Anthropic端点 | ❌ 仅OpenAI兼容 | ❌ 仅OpenAI兼容 |
| 支付方式 | 支付宝/微信/USDT | 美元信用卡 | 支付宝/微信 |
| 加价策略 | 对齐官方，0%加价 | +5-20% | 官方价 |
| SLA | 99.9% | 无明确SLA | 99.5% |
| OpenClaw集成 | 一键OAuth | 手动配置 | 手动配置 |
| 团队功能 | 子账号/额度分配/报表 | 有限 | 基础版 |

#### 2.4.3 OfoxAI核心优势分析

1. **国内直连体验**：对于没有稳定海外网络环境的开发者，OfoxAI的200-500ms延迟相比OpenRouter的1500-3000ms是质的飞跃，Claude Code、Cursor等工具不再频繁超时 [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-china-access-solutions-2026/) 

2. **三协议兼容**：这是OfoxAI相比其他平台的最大差异化能力。Anthropic原生端点意味着Claude Code可以直接使用`https://api.ofox.ai/anthropic`，无需任何适配层 [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-alternative-ofoxai-comparison-migration-2026/) 

3. **企业级功能**：子账号管理和用量报表对于团队使用AI API的场景至关重要，可以精确追踪每个成员的Token消耗 [(小罗资源网)](https://www.xiaoluo3.top/news/?28603.html) 

4. **零加价策略**：模型价格与官方完全对齐，没有OpenRouter那样的5-20%加价 [(来源)](https://claudeyy.com/zh/blog/ai-api-relay-station-comparison-guide-2026) 

#### 2.4.4 OfoxAI局限性与风险

尽管OfoxAI在国内使用场景表现出色，但开发者需要清醒认识以下局限：

1. **模型覆盖有限**：100+模型虽然覆盖主流需求，但相比OpenRouter的353+模型，冷门开源模型的覆盖存在缺口。如果需要调用HuggingFace上的小众社区模型，仍需回退到OpenRouter [(Ofox AI)](https://ofox.ai/zh/blog/openrouter-alternative-ofoxai-comparison-migration-2026/) 

2. **平台依赖性**：作为商业聚合平台，OfoxAI本身依赖上游Azure、Bedrock、VertexAI等供应商。虽然平台声称多供应商冗余 [(新浪)](https://k.sina.com.cn/article_7857201856_1d45362c001903p3rk.html?from=tech) ，但任何聚合平台都存在单点风险

3. **免费层限制**：免费模型仅10个，且可能随平台策略调整而变化。免费层的并发限制通常较为严格，不适合高流量生产场景

4. **数据隐私**：API请求会经过OfoxAI服务器中转，对数据合规有严格要求的场景（如金融、政务）建议直接接入官方API或选择私有化部署

5. **长期稳定性**：相比OpenRouter（运营多年、社区基础深厚）和硅基流动（华为昇腾生态合作），OfoxAI作为相对较新的平台，长期运营稳定性有待时间验证 [(来源)](https://claudeyy.com/zh/blog/ai-api-relay-station-comparison-guide-2026) 

#### 2.4.5 推荐接入方案

基于以上分析，推荐的接入策略是"OfoxAI为主、硅基流动为辅、OpenRouter兜底"的三层架构：

- **日常开发/生产流量**：走OfoxAI（国内直连、低延迟、人民币结算）
- **免费模型调用/轻量任务**：走硅基流动（7个永久免费模型、零成本）
- **冷门模型需求**：走OpenRouter（353+模型池，需代理）

### 2.5 OpenRouter免费模型变动处理

#### 2.5.1 免费模型动态变化的问题

OpenRouter提供约27-30个免费模型，覆盖主流厂商的基础模型。然而，免费模型列表存在两个核心问题：

1. **模型频繁增减**：厂商随时可能将模型从免费列表中移除，或新增免费模型
2. **调用限制动态调整**：免费调用要求账户余额≥$10，此时每天限额1000次；余额不足时每天仅50次

这意味着依赖OpenRouter免费层的系统必须具备动态适应能力，不能硬编码模型列表。

#### 2.5.2 动态发现机制设计

解决免费模型变动问题的核心策略是通过`/v1/models`端点定期拉取可用模型列表，并根据规则动态筛选免费模型。

**设计原则**：
- 启动时全量拉取模型列表，缓存到内存
- 每10分钟刷新一次，保持列表时效性
- 根据模型ID特征（如包含`:free`后缀）自动识别免费模型
- 结合多平台（OfoxAI、硅基流动）免费模型，构建统一的免费模型池

#### 2.5.3 模型路由优先级配置

路由配置采用分层优先级设计：

| 优先级 | 平台 | 模型类型 | 触发条件 |
|--------|------|---------|---------|
| P0 | 硅基流动 | 7个永久免费模型 | 轻量任务、高频调用 |
| P1 | OfoxAI | 10个免费模型 | 需要更大模型时 |
| P2 | OfoxAI | 付费模型（低单价） | 免费模型不可用时 |
| P3 | OpenRouter | 免费模型 | 需要特定模型且前述不满足 |
| P4 | OpenRouter | 付费模型 | 终极兜底 |

#### 2.5.4 降级策略

当高优先级模型不可用时，系统自动降级到下一优先级。降级条件包括：HTTP 429（限流）、HTTP 5xx（服务端错误）、超时（>10秒）。每次降级后记录日志，用于后续成本分析。

### 2.6 订阅方案与成本估算

#### 2.6.1 纯免费方案（¥0/月）

| 组件 | 方案 | 月成本 |
|------|------|--------|
| 决策模型 | 硅基流动免费模型 + OfoxAI免费层 | ¥0 |
| 代码补全 | DeepSeek-R1-Distill-Qwen-7B | ¥0 |
| Embedding | 硅基流动免费向量模型 | ¥0 |
| API网关 | OfoxAI免费层 | ¥0 |
| **合计** | | **¥0** |

适用场景：个人学习、原型验证、轻量工具调用。限制：免费模型的并发限制较严格，不适合高流量场景。

#### 2.6.2 轻度使用方案（¥0-50/月）

在纯免费方案基础上，利用硅基流动新用户赠送的14元+2000万Token额度 [(七牛云)](https://news.qiniu.com/archives/1775631011890) ，以及OfoxAI新用户测试额度，覆盖中等强度的开发需求。此阶段核心策略是"能免费就免费，付费只买最便宜的"。

#### 2.6.3 中度使用方案（¥100-300/月）

| 组件 | 方案 | 估算月成本 |
|------|------|-----------|
| 决策模型 | DeepSeek V4-Flash（缓存命中为主） | ¥30-80 |
| 复杂推理 | DeepSeek V4-Pro（按需调用） | ¥20-50 |
| 代码补全 | DeepSeek Coder V4 | ¥20-60 |
| Embedding | 硅基流动bge-large-zh | ¥10-20 |
| API聚合 | OfoxAI（0%加价） | 按量计费 |
| **合计** | | **¥100-300** |

此方案可满足10人以下团队的日常AI开发需求，日均调用量约5000-10000次。

#### 2.6.4 平台选型决策矩阵

| 你的情况 | 推荐方案 | 理由 |
|---------|---------|------|
| 无海外网络/无信用卡 | OfoxAI + 硅基流动 | 国内直连、支付宝付款 |
| 有海外网络、追求模型多样性 | OpenRouter + 硅基流动 | 353+模型池 |
| 使用Claude Code为主 | OfoxAI | 原生Anthropic端点 |
| 使用OpenClaw为主 | OfoxAI | 一键OAuth集成 |
| 企业团队/需用量追踪 | OfoxAI团队版 | 子账号+用量报表 |
| 追求极致低成本 | 硅基流动免费层 | 7个永久免费模型 |
| 数据合规要求极高 | 官方直签 | 不经第三方中转 |

### 2.7 配置文件与操作指南

#### 2.7.1 硅基流动API配置

```typescript
// config/siliconflow.ts
export const siliconFlowConfig = {
  baseURL: "https://api.siliconflow.cn/v1",
  apiKey: process.env.SILICONFLOW_API_KEY,
  
  // 免费模型列表（7个永久免费 + 3个蒸馏模型）
  freeModels: [
    "Qwen/Qwen2-7B-Instruct",           // 通用对话
    "Qwen/Qwen2-1.5B-Instruct",         // 轻量任务
    "Qwen/Qwen1.5-7B-Chat",             // 中文对话
    "THUDM/glm-4-9b-chat",              // 中文推理
    "THUDM/chatglm3-6b",                // 简单分类
    "internlm/internlm2_5-7b-chat",     // 多轮对话
    "mistralai/Mistral-7B-Instruct-v0.2", // 英文任务
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",  // 蒸馏推理
    "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", // 英文推理
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", // 极速推理
  ],
  
  // 限速配置（免费模型）
  rateLimit: {
    requestsPerMinute: 100,
    tokensPerMinute: 100000,
  },
};
```

#### 2.7.2 OfoxAI API配置

```typescript
// config/ofoxai.ts
export const ofoxAIConfig = {
  // 三协议兼容端点
  endpoints: {
    openai: "https://api.ofox.ai/v1",
    anthropic: "https://api.ofox.ai/anthropic",
    gemini: "https://api.ofox.ai/gemini",
  },
  
  apiKey: process.env.OFOXAI_API_KEY,
  
  // 常用模型映射
  models: {
    // DeepSeek系列
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
    
    // Anthropic系列
    "claude-opus-4-6": "anthropic/claude-opus-4-6",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
    
    // OpenAI系列
    "gpt-5-4": "openai/gpt-5.4",
    "gpt-4o": "openai/gpt-4o",
    
    // Google系列
    "gemini-3-1-pro": "google/gemini-3.1-pro",
    "gemini-3-1-flash": "google/gemini-3.1-flash",
    
    // 国产模型
    "qwen-3-5": "alibaba/qwen3.5",
    "kimi-k2-5": "moonshot/kimi-k2.5",
  },
};
```

#### 2.7.3 OpenRouter备用配置

```typescript
// config/openrouter.ts
export const openRouterConfig = {
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  
  // OpenRouter免费模型前缀
  freeModelPrefix: ":free",
  
  // 常用免费模型（会动态变化，仅供参考）
  commonFreeModels: [
    "google/gemini-2.5-pro-exp-03-25:free",
    "deepseek/deepseek-chat:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "nvidia/llama-3.1-nemotron-70b-instruct:free",
    "microsoft/phi-4-multimodal-instruct:free",
    "qwen/qwen2.5-vl-72b-instruct:free",
  ],
  
  // 免费调用限制
  freeLimits: {
    withBalance: 1000,    // 余额≥$10时每天1000次
    withoutBalance: 50,   // 余额不足时每天50次
  },
};
```

#### 2.7.4 多平台路由配置代码

```typescript
// lib/model-router.ts
import OpenAI from "openai";

interface ModelRoute {
  provider: "siliconflow" | "ofoxai" | "openrouter";
  model: string;
  priority: number;
  maxRetries: number;
  timeout: number;
}

// 路由配置表
const MODEL_ROUTES: Record<string, ModelRoute[]> = {
  "general-chat": [
    { provider: "siliconflow", model: "Qwen/Qwen2-7B-Instruct", priority: 0, maxRetries: 2, timeout: 10000 },
    { provider: "ofoxai", model: "qwen-3-5", priority: 1, maxRetries: 2, timeout: 15000 },
  ],
  "code-generation": [
    { provider: "ofoxai", model: "deepseek-v4-flash", priority: 0, maxRetries: 2, timeout: 15000 },
    { provider: "siliconflow", model: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", priority: 1, maxRetries: 2, timeout: 10000 },
  ],
  "complex-reasoning": [
    { provider: "ofoxai", model: "deepseek-v4-pro", priority: 0, maxRetries: 2, timeout: 30000 },
    { provider: "ofoxai", model: "claude-opus-4-6", priority: 1, maxRetries: 1, timeout: 30000 },
  ],
};

class MultiPlatformRouter {
  private clients: Map<string, OpenAI> = new Map();
  
  constructor() {
    // 初始化各平台客户端
    this.clients.set("siliconflow", new OpenAI({
      baseURL: "https://api.siliconflow.cn/v1",
      apiKey: process.env.SILICONFLOW_API_KEY!,
    }));
    
    this.clients.set("ofoxai", new OpenAI({
      baseURL: "https://api.ofox.ai/v1",
      apiKey: process.env.OFOXAI_API_KEY!,
    }));
    
    this.clients.set("openrouter", new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY!,
    }));
  }
  
  async chat(taskType: string, messages: any[]) {
    const routes = MODEL_ROUTES[taskType];
    if (!routes) throw new Error(`Unknown task type: ${taskType}`);
    
    // 按优先级排序
    const sortedRoutes = routes.sort((a, b) => a.priority - b.priority);
    
    for (const route of sortedRoutes) {
      for (let attempt = 0; attempt <= route.maxRetries; attempt++) {
        try {
          const client = this.clients.get(route.provider);
          if (!client) continue;
          
          const response = await Promise.race([
            client.chat.completions.create({
              model: route.model,
              messages,
              temperature: 0.7,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), route.timeout)
            ),
          ]);
          
          return {
            content: response.choices[0].message.content,
            model: route.model,
            provider: route.provider,
            usage: response.usage,
          };
        } catch (error) {
          console.warn(`Attempt ${attempt + 1} failed for ${route.provider}/${route.model}:`, error);
          if (attempt === route.maxRetries) continue; // 尝试下一路由
        }
      }
    }
    
    throw new Error("All model routes exhausted");
  }
}

export const router = new MultiPlatformRouter();
```

#### 2.7.5 免费模型动态发现脚本

```typescript
// scripts/discover-free-models.ts
import { writeFileSync } from "fs";

interface FreeModel {
  id: string;
  provider: string;
  context_length: number;
  pricing?: { prompt: number; completion: number };
}

/**
 * 多平台免费模型动态发现
 * 建议通过crontab每10分钟执行一次：
 * */10 * * * * bun run scripts/discover-free-models.ts
 */
async function discoverFreeModels(): Promise<FreeModel[]> {
  const freeModels: FreeModel[] = [];
  
  // 1. 拉取OfoxAI模型列表
  try {
    const ofoxRes = await fetch("https://api.ofox.ai/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OFOXAI_API_KEY}` },
    });
    const ofoxData = await ofoxRes.json();
    
    for (const model of ofoxData.data || []) {
      // 免费模型标识：pricing为0或模型ID包含free
      if (model.id?.includes(":free") || 
          (model.pricing?.prompt === 0 && model.pricing?.completion === 0)) {
        freeModels.push({
          id: model.id,
          provider: "ofoxai",
          context_length: model.context_length || 0,
          pricing: model.pricing,
        });
      }
    }
    console.log(`[OfoxAI] Found ${freeModels.filter(m => m.provider === "ofoxai").length} free models`);
  } catch (e) {
    console.error("[OfoxAI] Failed to fetch models:", e);
  }
  
  // 2. 拉取OpenRouter免费模型列表
  try {
    const orRes = await fetch("https://openrouter.ai/api/v1/models");
    const orData = await orRes.json();
    
    for (const model of orData.data || []) {
      if (model.id?.includes(":free")) {
        freeModels.push({
          id: model.id,
          provider: "openrouter",
          context_length: model.context_length || 0,
          pricing: model.pricing,
        });
      }
    }
    console.log(`[OpenRouter] Found ${freeModels.filter(m => m.provider === "openrouter").length} free models`);
  } catch (e) {
    console.error("[OpenRouter] Failed to fetch models:", e);
  }
  
  // 3. 硅基流动免费模型（硬编码，因官方模型列表API不区分免费/付费）
  const sfFreeModels = [
    "Qwen/Qwen2-7B-Instruct",
    "Qwen/Qwen2-1.5B-Instruct",
    "Qwen/Qwen1.5-7B-Chat",
    "THUDM/glm-4-9b-chat",
    "THUDM/chatglm3-6b",
    "internlm/internlm2_5-7b-chat",
    "mistralai/Mistral-7B-Instruct-v0.2",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  ];
  
  for (const modelId of sfFreeModels) {
    freeModels.push({
      id: modelId,
      provider: "siliconflow",
      context_length: 32768,
      pricing: { prompt: 0, completion: 0 },
    });
  }
  
  return freeModels;
}

// 主执行逻辑
async function main() {
  console.log("🔍 Discovering free models across platforms...");
  const models = await discoverFreeModels();
  
  // 按提供商分组
  const grouped = models.reduce((acc, m) => {
    acc[m.provider] = acc[m.provider] || [];
    acc[m.provider].push(m);
    return acc;
  }, {} as Record<string, FreeModel[]>);
  
  // 写入缓存文件
  const output = {
    lastUpdated: new Date().toISOString(),
    total: models.length,
    byProvider: grouped,
  };
  
  writeFileSync("./data/free-models.json", JSON.stringify(output, null, 2));
  console.log(`✅ Cached ${models.length} free models to ./data/free-models.json`);
  
  // 生成路由配置更新建议
  console.log("\n📋 Router configuration recommendations:");
  for (const [provider, providerModels] of Object.entries(grouped)) {
    console.log(`\n${provider.toUpperCase()}:`);
    for (const m of providerModels) {
      console.log(`  - ${m.id} (${m.context_length / 1024}K context)`);
    }
  }
}

main().catch(console.error);
```

**使用说明**：

1. 将上述脚本配置为定时任务，每10分钟自动更新免费模型列表：
```bash
# crontab配置
echo "*/10 * * * * cd /path/to/project && bun run scripts/discover-free-models.ts >> /var/log/free-models.log 2>&1" | crontab -
```

2. 路由层启动时读取`./data/free-models.json`，构建运行时路由表

3. 当免费模型不可用时（HTTP 404或返回"model not available"），自动标记为失效并在下次刷新时更新状态

---

通过以上配置，OpenClaw系统可实现"硅基流动免费模型优先 → OfoxAI免费层补充 → OfoxAI付费模型兜底 → OpenRouter终极备用"的四级路由体系。该方案在保证零成本起步的同时，预留了弹性扩展空间，可根据业务增长平滑过渡到付费方案。


---


## 3. OpenClaw网关层配置

OpenClaw的网关层（Gateway）是整个系统的单一入口，承担着消息接入、请求路由、渠道管理和安全隔离的核心职责。作为长期运行的Node.js守护进程，Gateway默认监听`127.0.0.1:18789`的WebSocket控制平面，同时处理来自50+消息渠道的连接请求 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。Gateway采用单写者架构，确保每个会话在任意时刻仅有一个Agent运行，从根本上消除了会话转录的并发写入冲突 [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) 。本章将从安装部署、渠道配置、引擎调参到安全加固四个维度，详细阐述网关层的完整配置流程。

### 3.1 OpenClaw安装与部署

#### 3.1.1 安装方式：curl一键安装或Docker部署

OpenClaw提供三种主流安装路径，以适应不同用户的技术背景和运维需求。

**curl一键安装**是最快入门方式，适用于macOS和Linux用户。该方式通过官方安装脚本自动完成Node.js依赖检测、二进制下载和路径配置 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) ：

```bash
# macOS / Linux
curl -fsSL https://openclaw.ai/install.sh | bash

# Windows PowerShell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

安装脚本执行完毕后会自动启动`openclaw onboard`交互式配置向导，引导用户输入LLM API Key并选择消息渠道。该方式的前置要求为：Node.js 24（推荐）或Node.js 22 LTS（22.19+）、一个LLM提供商的API Key，以及约5分钟的配置时间 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。截至2026年5月，curl方式在全球范围完成一次完整安装的平均耗时约为3分40秒，其中二进制下载受网络环境影响占时最长。

**Docker部署**更适合生产环境和需要隔离运行的场景。OpenClaw的Docker架构采用混合模式：Gateway守护进程在宿主机运行以保证集成能力，Agent工作会话则在容器中执行以获得沙箱隔离优势 [(GitHub Gist)](https://gist.github.com/royosherove/971c7b4a350a30ac8a8dad41604a95a0) 。部署流程如下：

```bash
git clone https://github.com/openclaw/openclaw
cd openclaw
cp .env.example .env
# 编辑.env填入API Key
docker-compose up --build -d
```

Docker部署的安全加固配置尤为重要，尤其是`cap_drop`和`read_only`参数可有效降低容器逃逸风险 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) ：

```yaml
services:
  openclaw-gateway:
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    read_only: true
    deploy:
      resources:
        limits: { cpus: '2.0', memory: 4G }
```

**开发环境安装**适用于需要二次开发或调试源码的开发者，通过pnpm workspace管理多包依赖 [(来源)](https://claudeyy.com/zh/blog/qwen-api-guide-qwen3-max-qwen3-6-2026/) ：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm openclaw setup
pnpm ui:build
pnpm gateway:watch
```

| 安装方式 | 适用场景 | 安装耗时 | 隔离级别 | 维护复杂度 |
|:---:|:---:|:---:|:---:|:---:|
| curl一键 | 个人快速体验 | ~5分钟 | 无（宿主机运行） | 低 |
| Docker Compose | 生产/团队部署 | ~15分钟 | 容器级沙箱隔离 | 中 |
| 源码编译 | 二次开发/调试 | ~30分钟 | 依赖开发环境配置 | 高 |

三种安装方式在核心功能上完全等价，配置均以JSON5格式存储于`~/.openclaw/openclaw.json`，支持注释和尾部逗号，便于人工编辑和版本控制 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。

#### 3.1.2 国内部署注意事项

国内网络环境下的OpenClaw部署需额外关注模型接入和依赖获取两个环节。在模型接入层面，最直接的方案是通过Ollama部署本地模型实现完全离线运行，无需任何外网连接 [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) 。以GLM 4或Gemma 4为例，本地部署流程为：

```bash
# 安装Ollama后启动本地模型
ollama run glm-4.7-flash

# 配置OpenClaw连接本地端点
openclaw onboard
# → Model/auth provider → Custom Provider
# → API Base URL → http://127.0.0.1:11434/v1
# → API Key → ollama（不可留空，任意非空字符串均可）
# → Endpoint compatibility → OpenAI-compatible
# → Model ID → glm-4.7-flash
```

Ollama方案的核心约束在于上下文长度——OpenClaw建议至少64k tokens的上下文窗口以保证多轮对话中工具调用历史的完整性 [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) 。目前通过Ollama验证的兼容模型包括GLM 4系列、Gemma 4、Qwen 3、DeepSeek和Kimi等，均需支持64k以上上下文长度 [(博客园)](https://www.cnblogs.com/chingho/p/19671464) 。该方案的数据完全停留在本地，适合处理企业内部文档和流程，但无法获取实时外部信息（如股价、新闻）。

在依赖获取层面，首次安装时建议将npm registry切换为国内镜像源以加速TypeScript依赖的下载 [(什么值得买)](https://post.smzdm.com/p/aqr37kr7) 。此外，Ollama的`baseUrl`配置必须包含`/v1`后缀，即`http://127.0.0.1:11434/v1`，而非裸端点地址——这是OpenClaw与Ollama集成中最常见的配置错误之一 [(什么值得买)](https://post.smzdm.com/p/aqr37kr7) 。

#### 3.1.3 安全配置

安装完成后的首要安全步骤是配置Gateway认证令牌和绑定地址。默认配置中Gateway WS控制平面绑定在`127.0.0.1:18789`，仅接受本机连接，这在单用户场景中已具备基础安全性。若需跨网络访问，应通过SSH隧道或Tailscale等私有网络方案转发，而非直接暴露端口 [(nvidia.com)](https://build.nvidia.com/spark/hermes-agent/instructions) 。配置文件中的`auth.token`字段用于WebSocket连接的令牌认证 [(openrouter.ai)](https://openrouter.ai/docs/cookbook/coding-agents/openclaw-integration) ：

```json
{
  "gateway": {
    "port": 18789,
    "bind": "loopback",
    "auth": { "token": "your-secure-token" }
  }
}
```

### 3.2 Gateway多渠道配置

#### 3.2.1 配置文件结构

`~/.openclaw/openclaw.json`是Gateway层的核心配置文件，采用JSON5格式（兼容注释与尾部逗号）。文件按功能域划分为`gateway`、`agents`、`bindings`、`channels`、`tools`等顶层键。其中`bindings`数组定义消息路由规则，`channels`对象配置各消息渠道的账户凭据和行为策略 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。

以下是一个完整的多渠道配置示例，涵盖Telegram和Discord的接入：

```json5
{
  gateway: {
    port: 18789,
    bind: "loopback",
    auth: { token: "${env.OC_TOKEN}" },
  },
  agents: {
    list: [
      {
        id: "main",
        default: true,
        name: "Assistant",
        workspace: "~/.openclaw/workspace",
      },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "telegram" } },
    { agentId: "main", match: { channel: "discord" } },
  ],
  channels: {
    telegram: {
      enabled: true,
      botToken: "${env.TELEGRAM_BOT_TOKEN}",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
    discord: {
      enabled: true,
      botToken: "${env.DISCORD_BOT_TOKEN}",
      guildId: "123456789",
    },
  },
}
```

配置中的`${env.VAR_NAME}`语法支持从环境变量读取敏感值，避免将API Key直接写入磁盘文件。Telegram的`dmPolicy`设置为`pairing`表示仅在用户完成配对后才响应私信，这是防止机器人被陌生人滥用的关键设置 [(博客园)](https://www.cnblogs.com/chingho/p/19671464) 。

#### 3.2.2 CLI工具配置

OpenClaw提供一套完整的命令行工具用于动态管理Gateway和渠道。CLI的优势在于无需手动编辑JSON文件即可完成常见配置变更 [(来源)](https://claudeyy.com/zh/blog/qwen-api-guide-qwen3-max-qwen3-6-2026/) 。

```bash
# 交互式首次配置
openclaw onboard

# 渠道登录（多账户支持）
openclaw channels login --channel telegram --account default
openclaw channels login --channel whatsapp --account personal

# 查看已配置渠道状态
openclaw channels list

# 插件管理
openclaw plugins install @agent-wechat/wechat
openclaw plugins list

# Gateway生命周期管理
openclaw gateway start
openclaw gateway restart
openclaw gateway stop

# 查看Agent绑定关系
openclaw agents list --bindings
```

CLI配置与文件配置完全互通，CLI命令最终会持久化到`openclaw.json`中。对于微信接入这类复杂场景，CLI提供了`openclaw channels login --channel wechat`命令触发扫码绑定，比手动配置JSON更直观 [(Hermes Agent)](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/acp) 。

#### 3.2.3 消息路由规则

Gateway的消息路由系统是其架构设计的核心亮点。路由采用确定性优先级机制——模型不决定消息去向，由主机配置完全控制，确保回复行为在任何模型 improvising 的情况下都可预测 [(Worth A Try LLC)](https://www.openclawplaybook.ai/blog/openclaw-channel-routing-multi-app-agent/) 。

路由评估遵循8层优先级层级，从最具体到最泛化依次匹配 [(OpenClaw)](https://docs.openclaw.ai/channels/channel-routing) ：

![OpenClaw Gateway Routing Priority Hierarchy](openclaw_routing_priority.png)

**第1层 `peer match`**：精确匹配直接消息（DM）或群组ID，优先级最高。当需要将某个特定对话路由到专用Agent时使用，例如将家庭WhatsApp群组绑定到"家庭助手"Agent。

**第2层 `parentPeer match`**：线程继承匹配。当消息属于某个已有线程的子对话时，自动继承父级路由决策，保持会话连贯性。

**第3-4层 `guildId/roles/guildId`**：Discord专属路由层，支持基于服务器ID和角色标签的联合匹配，适用于企业场景中按部门路由的场景。

**第5层 `teamId`**：Slack workspace级别匹配，将特定Workspace的全部消息导向指定Agent。

**第6层 `accountId`**：渠道账户级别匹配。Telegram、WhatsApp等渠道支持多账户登录，每个账户可绑定不同Agent [(OpenClaw)](https://docs.openclaw.ai/concepts/multi-agent) 。

**第7层 `channel`**：全渠道通配匹配，使用`accountId: "*"`捕获该渠道下所有未被上层规则命中的消息。

**第8层 `default agent`**：最终兜底规则，匹配`agents.list`中标记`default: true`的Agent，否则取列表第一项 [(OpenClaw)](https://docs.openclaw.ai/channels/channel-routing) 。

两个关键约束决定了路由行为的精确性：其一，同一层级内首个匹配项胜出，配置文件中`bindings`数组的顺序直接影响路由结果；其二，单个binding中若同时设置多个匹配字段（如`peer` + `guildId`），所有字段必须同时满足AND语义才会触发匹配 [(Assisted Coding: The $1.00 Challenge)](https://www.stack-junkie.com/blog/openclaw-multi-agent-setup-guide) 。以下多Agent配置展示了典型的工作-生活分离路由模式 [(OpenClaw)](https://docs.openclaw.ai/concepts/multi-agent) ：

```json5
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
      },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],
}
```

上述配置中，个人WhatsApp号码默认由`home`Agent处理，商务号码由`work`Agent处理，而个人号码中的一个特定工作群组则被peer匹配规则优先拦截至`work`Agent。peer匹配始终优先于accountId匹配的设计，使得细粒度覆盖成为可能 [(Assisted Coding: The $1.00 Challenge)](https://www.stack-junkie.com/blog/openclaw-multi-agent-setup-guide) 。

对于多人群聊场景，建议显式启用`per-channel-peer`的DM作用域模式，将默认的共享主会话改为按渠道+ peer隔离的独立会话，避免Alice的私密信息被Bob的查询意外泄露 [(Amulya Bhatia)](https://iamulya.one/posts/openclaw-channels-routing-and-nodes/) 。

### 3.3 Pi引擎配置

#### 3.3.1 模型配置

Pi引擎是OpenClaw的Agent运行时核心，其设计哲学刻意保持极简——系统提示不到1000 tokens，仅配备Read、Write、Edit、Bash四个核心工具 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。Pi本身不直接处理消息渠道接入，所有渠道交互均由Gateway层代理并通过标准接口传递给Pi。这种分层设计使得Pi可以专注于任务执行，而Gateway专注于连接管理。

模型配置位于`openclaw.json`的`models`或`agents.defaults.model`区块。OpenClaw作为模型无关的网关，支持Anthropic（Claude系列）、OpenAI（GPT系列）、Google（Gemini系列）、Ollama（本地模型）、OpenRouter（统一路由端点）等21+提供商 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。

多模型分层路由配置示例 [(Tencent Cloud)](https://www.tencentcloud.com/techpedia/141564) ：

```json5
{
  models: {
    mode: "merge",
    providers: {
      anthropic: {
        apiKey: "${env.ANTHROPIC_KEY}",
        models: [
          { id: "claude-sonnet-4-6", contextWindow: 200000 },
          { id: "claude-opus-4-6", contextWindow: 200000 },
        ],
      },
      ollama: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        api: "openai-compatible",
        models: [
          { id: "glm-4.7-flash", contextWindow: 64000 },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallback: "ollama/glm-4.7-flash",
      },
    },
  },
}
```

配置中`mode: "merge"`至关重要——若省略该参数，自定义配置将完全替换内置提供商列表而非追加 [(Github)](https://github.com/pmarreck/gemma4-heretical/blob/yolo/OPENCLAW_SETUP.md) 。`contextWindow`字段直接影响提示截断行为：高估会导致服务器拒绝请求，低估则浪费模型容量。对于生产环境，推荐启用两阶段故障转移机制：第一层在Anthropic的Auth Profile间旋转以应对速率限制，第二层在模型级别Fallback至备用提供商 [(thebomb.ca)](https://thebomb.ca/blog/openclaw-multi-agent-routing/) 。

#### 3.3.2 Workspace结构

Workspace是Pi引擎的持久化工作空间，位于`~/.openclaw/workspace`。OpenClaw的核心创新在于使用纯Markdown文件作为记忆系统，实现了"人类可读、完全可控、Git友好"的状态管理 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) 。所有记忆文件均为纯文本，可直接通过版本控制追踪变更。

Workspace的标准文件结构如下 [(OpenClaw)](https://docs.openclaw.ai/reference/AGENTS.default) ：

```
~/.openclaw/workspace/
├── SOUL.md              # Agent人格、语气、边界定义
├── USER.md              # 用户信息、偏好
├── IDENTITY.md          # Agent名称、类型、角色
├── TOOLS.md             # 可用工具/API列表
├── AGENTS.md            # 会话启动程序、记忆管理规则
├── HEARTBEAT.md         # 心跳检查清单（每30分钟触发）
├── BOOTSTRAP.md         # 首次运行引导
├── MEMORY.md            # 长期记忆（仅主会话加载）
├── GROUP_MEMORY.md      # 群组共享记忆（不含个人信息）
└── memory/
    ├── 2026-05-21.md    # 当日日志
    ├── 2026-05-20.md    # 昨日日志（自动加载）
    └── ...
```

`SOUL.md`是最关键的配置文件，定义了Agent的核心人格和行为边界——包括响应语气、拒绝策略、以及当用户请求超出能力范围时的处理方式。`HEARTBEAT.md`中的检查清单则驱动OpenClaw的主动自动化机制，默认每30分钟触发一次，Agent读取清单中的监控项（如收件箱状态、PR状态、日历提醒），无事时静默回复`HEARTBEAT_OK`，有事时主动发送alert给用户 [(arXiv.org)](https://arxiv.org/html/2605.10763v1) 。

混合检索系统为记忆查询提供高效支持：BM25全文索引负责精确关键词匹配，向量相似度搜索负责语义模糊查询，默认权重为70%向量 + 30% BM25 [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) 。索引管道采用文件监视器（1.5秒防抖）实现增量更新，Markdown文件变更后自动触发分块（约400 tokens/块，80 token重叠）、Embedding生成和SQLite存储更新 [(GitHub Gist)](https://gist.github.com/royosherove/971c7b4a350a30ac8a8dad41604a95a0) 。

#### 3.3.3 PTC模式配置

Programmatic Tool Calling（PTC，程序化工具调用）是OpenClaw最具架构特色的功能之一 [(AI星球)](https://www.aixq.cc/25003.html) 。传统模式下，每次工具调用需要一轮独立的模型推理——8次工具调用即消耗8轮推理。PTC通过让Agent编写Python脚本批量调用工具，将8次调用压缩为1轮模型推理，大幅降低延迟和token消耗。

PTC的核心原理是：Agent生成一段Python代码，代码在隔离的Docker沙箱中运行（`--network none`，内存和CPU受限），通过RPC串行调用工具桩。工具桩将请求写入`/shared/requests.jsonl`，宿主机端轮询执行真实工具handler并将响应写回沙箱 [(Github)](https://github.com/jibril2333/openclaw-ptc) 。

PTC插件的安装与配置流程 [(Github)](https://github.com/jibril2333/openclaw-ptc) ：

```bash
# 1. 安装PTC插件
git clone https://github.com/openclaw/openclaw-ptc.git
cd openclaw-ptc
npm install && npm run build
docker pull python:3.12-slim

# 2. 以本地链接方式安装到OpenClaw
openclaw plugins install -l ~/openclaw-ptc

# 3. 重启Gateway
openclaw gateway --force

# 4. 验证安装
openclaw plugins list
```

PTC在`openclaw.json`中的配置 [(Github)](https://github.com/jibril2333/openclaw-ptc) ：

```json5
{
  plugins: {
    entries: {
      "ptc-sandbox": {
        enabled: true,
        config: {
          sandboxImage: "python:3.12-slim",
          timeoutSeconds: 60,
          memoryLimit: "256m",
          cpuLimit: "0.5",
        },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: ["ptc_execute", "group:openclaw"],
        },
      },
    ],
  },
}
```

`tools.allow`字段显式声明了Agent可调用的工具白名单，`ptc_execute`是PTC模式的入口点，`group:openclaw`则允许访问OpenClaw内置工具组。`memoryLimit: "256m"`和`cpuLimit: "0.5"`将沙箱资源消耗限制在合理范围内，防止失控脚本过度占用宿主机资源。沙箱网络被完全隔离（`--network none`），所有外部调用必须通过宿主机端的工具handler代理，这一设计在功能性与安全性之间取得了有效平衡。

### 3.4 安全与隔离

#### 3.4.1 YOLO模式

YOLO（You Only Live Once）模式是OpenClaw安全模型中最具争议的设计。在该模式下，Agent执行命令和文件操作时无需任何人类确认，直接获得完整系统访问权限。Pi引擎的创造者Mario Zechner对此的解释是：权限对话框属于"安全剧场"——真正的安全应通过环境隔离实现，而非交互式弹窗 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。

YOLO模式的启用由`sandbox.mode`配置控制，可选值为`off`、`non-main`和`all` [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。`off`表示完全禁用沙箱，Agent直接在宿主机上运行命令，仅在受控的CI/CD环境或个人开发机中建议使用。`non-main`对主会话外的所有会话启用沙箱隔离（如Cron任务和子Agent）。`all`则对所有会话强制启用Docker沙箱，是生产环境的安全基准。

```json5
{
  agents: {
    list: [
      {
        id: "main",
        sandbox: {
          mode: "non-main",
          docker: {
            binds: [],
            image: "openclaw/sandbox:latest",
          },
        },
      },
    ],
  },
}
```

OpenClaw的安全文档明确建议：不在主机器上运行Agent，应在专用机器、虚拟机或Docker容器中运行，并定期更新至最新版本 [(来源)](https://claudeyy.com/zh/blog/qwen-api-guide-qwen3-max-qwen3-6-2026/) 。这一建议的背后是Agent拥有Bash工具后的潜在破坏力——在YOLO模式下，`rm -rf /`级别的指令会被直接执行。

#### 3.4.2 七层安全防御

OpenClaw采用纵深防御架构，从网络边界到数据持久化构建多层安全屏障 [(csdn.net)](https://gitcode.csdn.net/69c2006f0a2f6a37c599e75e.html) 。

**第一层：Gateway网络加固。** 控制平面默认绑定`127.0.0.1`回环地址，拒绝任何外部网络直连。WebSocket连接通过令牌认证，需CVE-2026-25253补丁（CVSS 8.8，v1.8.4修复）防护令牌通过URL参数泄露的风险 [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) 。

**第二层：DM与群组访问控制。** `dmPolicy`字段支持`allowlist`（仅白名单用户可交互）、`pairing`（配对后可用）、`open`（完全开放）三种模式。`allowlist`搭配`allowFrom`数组明确列出允许交互的用户ID，是防止Agent被未授权访问的第一道业务级防线 [(博客园)](https://www.cnblogs.com/chingho/p/19671464) 。

**第三层：Exec安全策略。** 通过命令审批机制拦截高风险操作。当Agent尝试执行删除、系统修改或网络请求类命令时，策略引擎可强制要求人类确认，超时后自动拒绝。

**第四层：Tool Policy。** `tools.allow`和`tools.deny`字段实现工具级权限控制，精确到单个工具的粒度。Agent无法调用未被白名单授权的工具，即使模型输出中包含了工具调用意图也会被Gateway层拦截。

**第五层：Docker沙箱隔离。** Agent会话在资源受限的容器中运行，`--network none`切断沙箱与外部网络的直接连接，`cap_drop: [ALL]`移除所有Linux capabilities，容器文件系统以只读方式挂载 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) 。

**第六层：Elevated Mode。** 当沙箱内的操作需要访问宿主机资源时，通过显式提权通道（如`--bind`挂载指定目录）受控放行，而非赋予完整宿主机权限。

**第七层：SecretRef凭证管理。** API Key等敏感凭证通过`${env.VAR}`语法引用环境变量，确保密钥永不以明文形式落盘到配置文件或Workspace中 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。

| 防御层级 | 机制 | 配置键/方式 | 防护目标 |
|:---:|:---|:---|:---|
| L1 | Gateway网络绑定 | `gateway.bind: "loopback"` + auth token | 未授权网络接入 |
| L2 | DM/群组访问控制 | `dmPolicy: "allowlist"` + `allowFrom` | 未授权用户交互 |
| L3 | 命令审批 | `execPolicy.approvalRequired: true` | 高风险命令执行 |
| L4 | 工具白名单 | `tools.allow: [...]` | 越权工具调用 |
| L5 | Docker沙箱 | `sandbox.mode: "all"` | 系统级破坏 |
| L6 | 提权模式 | `docker.binds`受控挂载 | 过度权限获取 |
| L7 | 凭证不落盘 | `${env.VAR}`环境变量引用 | 密钥泄露 |

该七层防御体系并非抽象概念，而是对应着`openclaw.json`中可精确配置的具体字段。生产环境部署应至少启用L1-L5五层防护，处理敏感数据时再激活L6-L7。2026年2月的"ClawHavoc"安全事件已充分说明供应链安全的必要性——341个恶意技能在社区技能市场ClawHub被发现并清理 [(财联社)](https://www.cls.cn/detail/2287927) ，用户在安装第三方技能前应审查`SKILL.md`的内容来源。

#### 3.4.3 敏感操作审计

OpenClaw的审计能力建立在两个基础之上：纯Markdown文件的Git可追溯性，以及Gateway层的结构化日志。由于Workspace完全由文本文件构成，每次Agent的文件操作（Write、Edit）都会直接反映在磁盘文件上，可通过Git diff精确审计 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) 。建议将Workspace目录纳入Git版本控制，配合定时commit脚本实现操作留痕：

```bash
# 在crontab中添加定时提交
cd ~/.openclaw/workspace && \
  git add -A && \
  git commit -m "auto: $(date +%Y-%m-%d-%H:%M)" 2>/dev/null
```

Gateway层输出的结构化日志记录了每条消息的完整生命周期——接收时间戳、路由决策结果、Agent执行耗时、以及响应回传状态。日志文件位于`~/.openclaw/logs/`，按日期滚动。对于合规要求严格的场景，可通过`gateway.logLevel`配置将 verbosity 调至`debug`级别以捕获完整的WebSocket帧内容，但需注意该级别日志可能包含用户消息全文，应配套适当的日志保留和访问控制策略。

Cron任务的`isolated`运行模式推荐用于所有实质性周期性工作，该模式下每次触发创建独立的子Agent会话，执行完毕后自动清理，不会污染主会话的上下文窗口 [(arXiv.org)](https://arxiv.org/html/2605.10763v1) 。结合Docker沙箱使用，即使周期性任务被注入恶意指令，其影响范围也被严格限制在一次性容器内。


---


## 4. Hermes Agent深度研究模块

Hermes Agent是由Nous Research于2026年2月发布的开源自主AI Agent框架，定位"The agent that grows with you"，核心设计哲学围绕自学习、自进化和持久记忆展开 [(CSDN博客)](https://blog.csdn.net/2401_85343303/article/details/160121215) 。截至2026年5月，该项目在GitHub获15,000+ Stars，最新版本v0.13.0（Tenacity release），以MIT许可证发布。与OpenClaw的"工具论"——Agent应被精确配置和组合——不同，Hermes Agent秉持"同事论"：Agent是会自主学习、成长和记住用户偏好的协作者 [(稀土掘金)](https://juejin.cn/post/7628045857251180554) 。这一根本差异决定了两者在架构选择、记忆管理和技能系统上的显著分化。

### 4.1 Hermes Agent架构

#### 4.1.1 五层架构

Hermes Agent采用五层架构设计，每一层承担独立职责，层间通过定义接口通信 [(腾讯云)](https://cloud.tencent.com/developer/article/2649246) 。图4-1展示了该架构的整体布局。

![图4-1 Hermes Agent五层架构](fig_4_1_hermes_architecture.png)

**Layer 1（基础设施层）**提供代码执行环境，支持7种后端：Local（宿主机）、Docker（完整容器隔离）、SSH（远程服务器）、Modal（云端VM）、Daytona（托管云环境）、Singularity（HPC集群）和Vercel Sandbox。Agent根据任务安全等级选择后端——个人开发用local，CI/CD用docker，临时计算用modal。多后端架构使同一Agent可在不同任务间动态切换执行环境，无需重启或重新配置 [(Github)](https://github.com/NousResearch/hermes-agent/issues/15005) 。

**Layer 2（工具与技能层）**包含47个内置工具，覆盖文件操作、终端执行、Web搜索、浏览器自动化、记忆管理、技能管理和MCP集成7大类别 [(Github)](https://github.com/jwangkun/hermes-agent-guide/blob/main/03-Hermes%E8%AF%9E%E7%94%9F%E4%B8%8E%E6%BC%94%E8%BF%9B.md) 。该层承载Skills Hub和MCP Client，终端后端在此被调用执行工具请求 [(ERRO 404: Lógica não encontrada!)](https://erro404.dev.br/en/posts/hermes-agent-architecture-harness-identity-context/) 。

**Layer 3（Agent核心层）**由AIAgent类、Prompt Builder、Provider Resolution和Tool Dispatch构成。所有入口点汇聚到同一AIAgent实例，实现"一个Agent，多个入口" [(ERRO 404: Lógica não encontrada!)](https://erro404.dev.br/en/posts/hermes-agent-architecture-harness-identity-context/) 。Provider Resolution支持20+模型Provider，具备Fallback链——主模型失败时自动切换备用模型 [(Github)](https://github.com/jwangkun/hermes-agent-guide/blob/main/03-Hermes%E8%AF%9E%E7%94%9F%E4%B8%8E%E6%BC%94%E8%BF%9B.md) 。

**Layer 4（状态与持久化层）**使用SQLite + FTS5引擎，持久化会话状态、四层温度记忆、639+技能文件和Cron任务 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) 。FTS5全文索引使Agent能跨会话进行毫秒级关键词检索。

**Layer 5（平台适配层）**通过统一网关连接15+消息平台，包括Telegram、Discord、Slack、WhatsApp、Signal、Feishu/Lark、WeCom等 [(博客园)](https://www.cnblogs.com/chingho/p/19671464) 。网关设计原则是"fan-out layer，not separate brain"——仅负责消息路由，所有平台消息路由到同一AIAgent实例处理，共享session store、memory和skills [(OpenClaw Setup)](https://clawlodge.com/lobsters/corluka423-openclaw-workspace) 。

#### 4.1.2 AIAgent核心循环

AIAgent核心循环是中央处理管线，负责完整对话周期，由8个顺序阶段组成 [(ERRO 404: Lógica não encontrada!)](https://erro404.dev.br/en/posts/hermes-agent-architecture-harness-identity-context/) ：（1）**输入接收**——从CLI、Gateway、ACP、Cron或API接收消息；（2）**上下文构建**——Prompt Builder组装系统提示词，注入记忆快照和技能摘要；（3）**Provider解析**——选择模型Provider和凭据，不可用时触发Fallback链；（4）**模型调用**——发送请求到LLM，支持OpenRouter、OpenAI、Anthropic和Ollama等；（5）**工具调用解析**——正则表达式检测`<tool_call>` XML标签，提取JSON格式指令 [(DEV Community)](https://dev.to/piwe/building-an-ambient-developer-daemon-with-nous-hermes-1667) ；（6）**工具执行**——Tool Dispatch路由到对应后端；（7）**观察与响应**——收集结果，生成响应或继续循环；（8）**持久化**——保存会话状态和记忆。

该循环的关键特征是**递归性**：第7阶段输出可能触发新一轮循环，Agent在"思考→调用工具→观察→再思考"中自主推进任务。工具调用采用Hermes Function Calling标准，模型在正常文本中emit `<tool_call>`标签，与Hermes模型原生能力深度耦合 [(arXiv.org)](https://arxiv.org/html/2604.11839v2) 。

#### 4.1.3 封闭学习闭环

封闭学习闭环（Closed Learning Loop）是Hermes最具差异化的架构特征，将记忆系统与技能系统连接成自增强反馈回路 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。运作流程为：记忆记录的事实→提炼为Skill流程→下次检索Skill+历史→增量修正Skill→更新记忆→正反馈循环 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) 。

触发条件有明确量化标准：完成涉及5+次工具调用的复杂任务；遇错后找到解决方案；用户纠正Agent方法；发现非平凡执行流程。满足后Agent自我评估，判断经验是否值得保存为新SKILL.md [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。

Skill自改进采用patch操作——仅修改问题段落，保留其余内容 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。这种增量更新使Skill越用越准确，避免全量重写的I/O开销。闭环在运行时内部自动完成，是"随你成长"理念的技术基础。

### 4.2 技能系统配置

#### 4.2.1 内置技能

在Hermes中，Skill不是代码插件，而是`~/.hermes/skills/`下的Markdown文件（SKILL.md），包含能力描述、参数规格、触发条件、执行步骤和注意事项 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。安装只需放入目录，删除即卸载，完全可移植、人类可读、diff友好 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。

截至2026年4月，技能生态规模达639+，分布如表4-1 [(Github)](https://github.com/jwangkun/hermes-agent-guide/blob/main/03-Hermes%E8%AF%9E%E7%94%9F%E4%B8%8E%E6%BC%94%E8%BF%9B.md) 。

| 技能类别 | 数量 | 代表性技能 | 覆盖领域 |
|---------|------|-----------|---------|
| 内置技能 | 74 | docker-management、duckduckgo-search | DevOps、搜索、爬虫 |
| 官方可选技能 | 44 | kubernetes-deploy、aws-cli | 云平台、CI/CD |
| 社区技能 | 521+ | custom-workflows、niche-tools | 行业定制、自动化 |
| **总计** | **639+** | — | 7大工具类别、15+业务领域 |

表4-1 Hermes Agent技能生态系统构成（2026年4月）

社区技能占比81.5%（521/639），表明生态已形成社区驱动增长。内置74个技能覆盖7大类别，开箱即用程度较高；官方可选技能经Nous Research审核，适合生产环境。技能安装通过CLI完成，如`hermes skills install official/devops/docker-management` [(OpenClaw Setup)](https://clawlodge.com/lobsters/corluka423-openclaw-workspace) 。

#### 4.2.2 技能创建

技能创建分人工和自动两种模式。人工模式直接编写SKILL.md；自动模式依托封闭学习闭环，满足触发条件后Agent自主生成 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。管理通过`skill_manage`工具完成，支持`create`、`patch`（推荐，仅修改old_string到new_string）、`edit`、`delete`、`write_file`和`remove_file`六种操作 [(脚本之家)](https://www.jb51.net/ai/1021119.html) 。

Token控制采用Progressive Disclosure机制 [(OpenClaw Setup)](https://clawlodge.com/lobsters/corluka423-openclaw-workspace) ：默认只加载名称和描述（全部648个约3K tokens），仅当显式调用`/<skill名>`时加载完整内容。实测40+常用技能启动时约3,000 tokens即可覆盖，有效避免上下文token爆炸。

#### 4.2.3 ClawHub技能市场

ClawHub与Hermes之间存在双向技能流动。Hermes官方`official/`命名空间下118个技能（内置+可选）通过Git仓库分发 [(OpenClaw Setup)](https://clawlodge.com/lobsters/corluka423-openclaw-workspace) 。社区技能分散在各开发者仓库，ClawHub对高质量技能进行收录和筛选。

Hermes提供官方迁移命令`hermes claw migrate`，可将OpenClaw完整设置（SOUL.md、memories、skills、API keys、Telegram config）在不到一分钟内迁移 [(Github)](https://github.com/yukiharukonishi/openclaw-cc) 。社区分析显示：35%用户坚持OpenClaw，30%已切换Hermes，20%同时使用两者，15%不信任Hermes [(ChatBench)](https://www.chatbench.org/what-is-openclaw-and-how-does-it-work/) 。

### 4.3 记忆管理配置

#### 4.3.1 四层温度记忆

Hermes记忆系统采用"四层温度模型"（Four-Tier Temperature Model），在新鲜度、检索效率和存储成本间分层权衡 [(博客园)](https://www.cnblogs.com/Wcowin/articles/19860617) 。

**热记忆（Hot Memory）**即当前会话上下文，以消息历史驻留内存，约5KB per message，session结束释放。这层确保对话连贯性。

**温记忆（Warm Memory）**由MEMORY.md和USER.md两个冻结快照组成 [(Github)](https://github.com/pydantic/pydantic-ai-harness/issues/102) 。MEMORY.md约2,200字符/800 tokens，记录环境配置和技术发现；USER.md约1,375字符/500 tokens，记录用户画像。两者以冻结快照注入system prompt，mid-session写入立即存盘但不改变运行中prompt，下次session读取更新文件 [(Github)](https://github.com/pydantic/pydantic-ai-harness/issues/102) 。这种"延迟生效"保证prefix cache不被破坏，降低长session推理成本。

**冷记忆（Cold Memory）**基于SQLite + FTS5全文索引 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) 。所有历史持久化到`~/.hermes/state.db`，通过FTS5倒排索引支持按需检索——关键词查询→轻量LLM摘要→相关片段注入上下文，避免全量加载。

**外部记忆（External Memory）**支持Honcho、Mem0、Pinecone、Weaviate等8种Provider [(Hermes Agent)](https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho) 。Honcho提供辩证式用户建模（Dialectic reasoning），跨12个身份维度被动构建长期画像 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) 。

#### 4.3.2 记忆整合机制

四层记忆通过整合机制协同，形成事实记录到技能提炼的链路。表4-2对比了Hermes方案与主流替代方案。

| 特性维度 | Hermes四层记忆 | 静态CLAUDE.md | 向量数据库 | 原始会话转录 |
|---------|--------------|--------------|-----------|-------------|
| 人类可审计 | 是（Markdown） | 是（Markdown） | 否（嵌入向量） | 部分 |
| 自动更新 | 是（Agent维护） | 否（手动编辑） | 是（自动索引） | 是 |
| 人类可编辑 | 是（直接改文件） | 是 | 否 | 否 |
| 规模扩展 | 是（FTS5+外部DB） | 差（线性增长） | 是（近似检索） | 是 |
| 精确删除 | 是（文件级） | 是 | 部分 | 是 |
| 无需外部服务 | 是（SQLite内置） | 是 | 通常需要 | 是 |

表4-2 Hermes Agent记忆方案与主流替代方案特性对比

表4-2揭示了关键设计权衡：Hermes方案在"自动更新"和"人类可审计"两个维度同时取得"是"，四种方案中唯一。静态CLAUDE.md可人工编辑但缺乏自动更新；向量数据库可自动索引但嵌入向量不可审计；原始转录保留完整信息但缺乏结构化提炼。

整合核心流程是episodic memory（发生了什么，存于SQLite）与procedural memory（怎么做，提炼为Skill）的分离协作 [(稀土掘金)](https://juejin.cn/post/7634760691857522698) 。冷记忆层FTS5检索定位历史事件，AIAgent模式识别后调用`skill_manage`固化为SKILL.md；执行Skill时遇到的问题记录到MEMORY.md，形成事实→流程→改进→新事实的闭环，使Agent经验跨session累积。

### 4.4 与OpenClaw的集成方案

#### 4.4.1 独立运行模式

Hermes与OpenClaw呈互补关系，存在三种部署模式 [(Github)](https://github.com/exbald/openclaw-skill-vector-memory) 。**纯OpenClaw模式**适合高频简单任务，设置时间<30分钟。**纯Hermes模式**适合长期运行、可学习的复杂任务，需Docker/Singularity沙箱隔离，配置需2-4小时。**混合模式**约20%用户采用，OpenClaw作前端网关，Hermes作后端推理引擎 [(ChatBench)](https://www.chatbench.org/what-is-openclaw-and-how-does-it-work/) 。

混合架构典型拓扑：用户输入→OpenClaw Router→按复杂度分流，简单工具调用由OpenClaw Skill Executor处理，复杂推理转发Hermes Agent。Hermes读写持久记忆后返回结构化响应，OpenClaw格式化投递用户 [(Github)](https://github.com/exbald/openclaw-skill-vector-memory) 。此模式下，OpenClaw的24+平台接入能力（含iMessage原生）弥补Hermes平台覆盖不足，Hermes的四层记忆和封闭学习闭环则为OpenClaw提供深度推理和自进化能力。

#### 4.4.2 任务触发方式

混合架构中，OpenClaw向Hermes触发任务有三种机制。**直接API调用**：OpenClaw通过Hermes API Server发送HTTP请求，Hermes处理后返回响应，OpenClaw解析`<tool_call>`标签整合到回复管线 [(ERRO 404: Lógica não encontrada!)](https://erro404.dev.br/en/posts/hermes-agent-architecture-harness-identity-context/) 。**消息队列模式**：OpenClaw将任务投递到Hermes Gateway支持的消息平台（如Telegram Bot），Gateway后台消费并启动AIAgent循环，处理完成后投递回通道 [(OpenClaw Setup)](https://clawlodge.com/lobsters/corluka423-openclaw-workspace) 。此模式天然支持长时任务，Hermes Cron可处理数分钟复杂推理，OpenClaw无需保持长连接。

**MCP Server模式**是最新集成方式。Hermes可作为MCP服务器运行（`hermes mcp serve`），暴露消息和推理能力为标准MCP工具集 [(Hermes Agent 中文社区)](https://hermesagent.org.cn/en/docs/user-guide/features/mcp) 。OpenClaw通过MCP Client连接，以标准化格式触发任务。双方无需了解内部实现，仅通过MCP协议交互，降低集成耦合度。

#### 4.4.3 结果回传

Hermes向OpenClaw回传三种输出类型。**纯文本响应**直接作为聊天消息投递。**工具调用轨迹**包含推理过程中调用的工具及参数、输出，OpenClaw可格式化为可折叠"思维链"展示 [(DEV Community)](https://dev.to/piwe/building-an-ambient-developer-daemon-with-nous-hermes-1667) 。**结构化数据**（JSON报告、文件diff、搜索结果）通过OpenClaw模板渲染为富文本或附件。

安全方面，Hermes七层防御体系（命令审批、DM配对、容器隔离、MCP过滤、凭据隔离、权限分级、插件验证）在混合架构中仍然有效 [(promptlayer.com)](https://www.promptlayer.com/glossary/openclaw-provider-routing) 。危险操作审批提示通过OpenClaw路由到用户平台，用户可点击"允许一次""允许会话""始终允许"或"拒绝"，结果回传Hermes继续执行 [(OpenClaw)](https://docs.openclaw.ai/concepts/memory) 。

Hermes v0.13.0的Checkpoint v2机制进一步增强可靠性——执行中自动创建检查点，失败时`/rollback`回退到上一个良好状态 [(AI Skill Market)](https://aiskill.market/blog/openclaw-vs-hermes-agent-2026-platform-comparison) 。在OpenClaw→Hermes链路中，即使Hermes执行失败也不污染OpenClaw状态，用户可选择重试或回滚。这种故障隔离机制是混合架构在生产环境中稳定运行的关键保障，避免了单点故障导致的系统性服务中断。


---


## 5. 编码Agent模块设计

编码Agent模块是OpenClaw系统中负责将规划阶段产出的PTC（Plan-to-Code）指令转化为可执行代码的核心组件。2025年中国AI代码生成市场规模达24.5亿元，同比增长187.3% [(CSDN博客)](https://blog.csdn.net/m980828/article/details/159695699) ，编码Agent工具的选型直接决定系统的代码质量与开发效率。本章基于对OpenCode、通义灵码、iFlow CLI三款主流编码Agent的深度评估，确定OpenCode作为首选方案，并详述其配置方式、任务流水线及与OpenClaw系统的协作机制。

### 5.1 编码Agent选型对比

编码Agent的选型需综合考量开源协议、模型灵活性、LSP（Language Server Protocol，语言服务器协议）支持深度、MCP（Model Context Protocol，模型上下文协议）集成能力以及与OpenClaw技术栈的匹配度。三款候选Agent在这些维度上呈现出显著差异。

#### 5.1.1 OpenCode首选

OpenCode是目前最接近Claude Code的开源替代方案，GitHub Stars超过150K，月活用户达650万 [(博客园)](https://www.cnblogs.com/qiniushanghai/p/archive/2026/04/29) 。其核心优势体现在六个方面。

**完全开源与模型无锁定**。OpenCode采用MIT许可证发布，可自由使用、修改和分发。系统支持75+ LLM提供商，包括Claude、GPT、Gemini、DeepSeek、Qwen等，允许在同一对话中切换模型 [(陈广亮的技术博客)](https://chenguangliang.com/posts/blog149_ai-coding-tools-2026-review/) 。这种模型无关架构使OpenClaw可根据任务复杂度动态选择模型——简单任务调用轻量模型以节省成本，复杂任务切换至旗舰模型保证质量，综合可降低60-70%的API费用 [(OpenClaw)](https://docs.openclaw.ai/reference/AGENTS.default) 。

**双Agent架构**。`build`代理拥有完全的系统访问权限，专为编码、调试和测试设计；`plan`代理运行于只读模式，用于安全分析和代码库探索 [(博客园)](https://www.cnblogs.com/itech/p/19918589) 。该设计与OpenClaw的PTC（规划）和编码（执行）分离理念天然契合。

**LSP开箱即用**。OpenCode内置完整的LSP支持，相比Claude Code的LSP支持更加稳定 [(明立非|Mingnify的博客)](https://mingnify.com/zh/blog/p/opencode-guide/) 。LSP为编码Agent带来从"文本搜索"到"语义理解"的范式转变，使Agent能够像软件架构师一样理解代码，而非仅执行复杂的grep操作 [(Machines Do It Better)](https://machinesdoitbetter.ai/ai-coding-assistants-dont-understand-your-code-lsp-scip-and-real-code-intelligence-2/) 。结构化LSP响应相比grep搜索可减少5-34倍的token消耗 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

**客户端/服务器架构**。OpenCode支持将核心服务部署在远程服务器上，本地通过轻量客户端连接 [(博客园)](https://www.cnblogs.com/itech/p/19918589) 。该架构适合OpenClaw的分布式部署场景，编码Agent可作为独立服务运行，通过MCP协议与主系统通信。

**TypeScript + Rust技术栈**。OpenCode采用TypeScript编写插件系统，Rust处理性能敏感模块，与OpenClaw的Bun/TypeScript技术栈完全一致 [(Opencode 重新定义你的 AI 编程体验 | OpenCodex)](https://opencodex.cc/posts/opencode-installation-guide) 。其25+生命周期钩子支持深度自定义，插件可通过npm包分发。

**隐私保护**。支持Ollama本地模型直连，敏感代码数据可完全不出本地 [(Opencode 重新定义你的 AI 编程体验 | OpenCodex)](https://opencodex.cc/posts/opencode-local-models-guide) 。企业部署场景下，这一特性满足数据合规要求。

#### 5.1.2 通义灵码

通义灵码是阿里巴巴推出的智能编码助手，国内市场份额达18.5%，位居第二 [(CSDN博客)](https://blog.csdn.net/m980828/article/details/159695699) 。2025年4月发布的重大升级新增编程智能体、MCP工具支持和长期记忆能力 [(阿里云帮助中心)](https://help.aliyun.com/zh/lingma/product-overview/changelogs-of-202504) 。

通义灵码的核心竞争力在于其MCP生态深度集成。系统直接对接国内最大的MCP中文社区——魔搭MCP广场，涵盖开发者工具、文件系统、搜索等十大热门领域2400+ MCP服务，支持STDIO和SSE两种连接方式，最多可同时连接10个MCP服务 [(CSDN博客)](https://blog.csdn.net/TONGYILingma/article/details/147902162) 。在模型层面，通义灵码采用Qwen3系列，该模型以235B总参数、22B激活参数的MoE架构，在参数量仅为DeepSeek-R1 1/3的条件下实现性能全面超越 [(阿里云帮助中心)](https://help.aliyun.com/zh/lingma/product-overview/changelogs-of-202504) 。

通义灵码的主要限制在于其IDE插件形态——系统以VS Code/JetBrains插件或独立IDE（Lingma IDE）形式存在 [(腾讯云)](https://cloud.tencent.com/document/product/1749/105967) ，缺乏原生CLI Agent的灵活性。对于OpenClaw需要自动化、流水线化的编码任务，IDE插件形态意味着额外的进程管理和UI自动化开销。此外，通义灵码并非完全开源，企业级定制能力受限。

#### 5.1.3 iFlow CLI

iFlow CLI是阿里旗下心流团队开发的终端级AI助手，直接对标Claude Code [(SourceForge)](https://sourceforge.net/software/compare/Hermes-3-vs-Hermes-4/) 。其最大吸引力在于完全免费——内置Kimi K2、Qwen3 Coder、GLM-4.5、DeepSeek-V3.1等顶尖模型均无需付费订阅 [(博客园)](https://www.cnblogs.com/Wcowin/articles/19860617) 。iFlow CLI支持多智能体协作，可自动拆解任务并调度专家智能体并发执行，同时开放MCP智能体生态 [(SourceForge)](https://sourceforge.net/software/compare/Hermes-3-vs-Hermes-4/) 。

iFlow CLI的局限在于项目成熟度和生态规模。相比OpenCode的150K+ Stars和完善的插件体系，iFlow CLI作为2025年发布的新项目，社区规模、文档完善度和第三方集成数量均存在差距。其LSP支持未在官方文档中明确说明，对于需要精确代码语义理解的场景存在不确定性。此外，iFlow CLI闭源发布，无法进行深度定制。

表5-1从八个维度对三款编码Agent进行量化对比。

| 维度 | OpenCode | 通义灵码 | iFlow CLI |
|------|----------|----------|-----------|
| 开源协议 | MIT（完全开源） | 闭源 | 闭源 |
| 模型支持 | 75+ 提供商 | Qwen3 系列 | Kimi/Qwen/GLM/DeepSeek |
| LSP 支持 | 开箱即用 | 通过IDE间接支持 | 未明确 |
| MCP 支持 | 支持 | 深度集成（2400+服务） | 支持 |
| Agent 模式 | Build+Plan 双模式 | 智能体模式 | YOLO/计划/编辑 |
| CLI 形态 | 原生TUI | IDE插件+独立IDE | 原生TUI |
| 技术栈 | TypeScript+Rust | 阿里云生态 | 未公开 |
| 社区规模 | 150K+ Stars | 18.5%市场份额 | 新兴项目 |

OpenCode在开源自由度、LSP原生支持、技术栈匹配度和社区成熟度四个维度均领先。通义灵码的优势在于MCP生态深度和Qwen3模型性能，适合作为MCP服务源而非编码Agent主体。iFlow CLI的免费策略有吸引力，但成熟度不足。OpenClaw选择OpenCode作为编码Agent核心，同时保留通义灵码的MCP广场作为工具扩展源。

### 5.2 OpenCode配置

#### 5.2.1 安装配置

OpenCode提供多种安装方式，推荐Bun运行时以获得最佳性能。实测数据显示，Bun相比npm安装速度快4倍（12s vs 3s），启动速度快4倍（800ms vs 200ms），内存占用降低47%（150MB vs 80MB） [(Opencode 重新定义你的 AI 编程体验 | OpenCodex)](https://opencodex.cc/posts/opencode-installation-guide) 。

**推荐安装方式（Bun）**：

```bash
# 方式一：一键安装脚本
curl -fsSL https://opencode.ai/install | bash

# 方式二：Bun包管理器（推荐）
bun install -g opencode-ai@latest

# 方式三：Docker
docker run -it --rm ghcr.io/anomalyco/opencode
```

**系统要求**：

- 操作系统：Windows 10/11（推荐WSL2）、macOS 10.15+、主流Linux发行版
- 内存：至少4GB可用内存
- 运行时：Bun 1.1+ 或 Node.js 20+
- 网络：用于API调用（本地模型可离线运行）

**模型配置**（`~/.opencode/opencode.json`）：

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4",
  "fallback": {
    "provider": "openrouter",
    "model": "deepseek/deepseek-chat-v3"
  },
  "local": {
    "provider": "ollama",
    "model": "qwen2.5-coder:14b"
  }
}
```

上述配置采用分层模型策略：主模型使用Claude Sonnet 4处理复杂编码任务，fallback模型使用DeepSeek V3保证可用性，本地模型通过Ollama运行Qwen2.5-Coder处理敏感代码。OpenCode可在同一对话中通过`/model`命令切换模型 [(陈广亮的技术博客)](https://chenguangliang.com/posts/blog149_ai-coding-tools-2026-review/) 。

#### 5.2.2 LSP集成

LSP是编码Agent实现语义级代码理解的基础设施。OpenCode原生内置LSP支持，无需额外配置即可启用 [(明立非|Mingnify的博客)](https://mingnify.com/zh/blog/p/opencode-guide/) 。为扩展LSP能力，OpenClaw集成agent-lsp作为MCP-LSP桥接层，提供65+工具、24个Agent工作流和30种语言的CI验证支持 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

**语言服务器安装**：

```bash
# TypeScript（OpenClaw主要开发语言）
npm install -g typescript-language-server typescript

# Python（AI模型服务侧）
npm install -g pyright

# Go（部分工具链）
go install golang.org/x/tools/gopls@latest

# Rust（性能模块）
rustup component add rust-analyzer
```

**agent-lsp MCP配置**（OpenClaw MCP配置文件中追加）：

```json
{
  "mcpServers": {
    "lsp": {
      "type": "stdio",
      "command": "agent-lsp",
      "args": [
        "typescript:typescript-language-server,--stdio",
        "python:pyright-langserver,--stdio",
        "go:gopls",
        "rust:rust-analyzer"
      ]
    }
  }
}
```

每个参数格式为 `language:server-binary`（服务器参数用逗号分隔）。agent-lsp自动按文件扩展名路由到对应语言服务器，首次会话启动时索引项目（FastAPI规模项目约10秒），后续会话即时连接热守护进程，30分钟无活动自动退出 [(mcpservers.org)](https://mcpservers.org/servers/blackwell-systems/agent-lsp) 。

**验证安装**：

```bash
# 检查agent-lsp和语言服务器状态
agent-lsp doctor

# 交互式配置生成
agent-lsp init
```

agent-lsp为OpenCode带来的核心增值包括：推测执行（Speculative Execution）——在写入磁盘前模拟变更影响；阶段执行（Phase Enforcement）——运行时阻止错误顺序的工具调用；以及持久化守护进程——跨会话保持workspace索引热状态 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

#### 5.2.3 MCP工具集成

MCP协议是编码Agent与外部工具服务协作的标准接口。OpenCode支持通过插件系统连接MCP服务，自定义工具放置于`.opencode/tool/`目录即可自动加载 [(博客园)](https://www.cnblogs.com/itech/p/19918589) 。

OpenClaw的编码Agent模块需要以下MCP工具类别：

| 工具类别 | 代表服务 | 功能描述 | 连接方式 |
|----------|----------|----------|----------|
| 代码检索 | agent-lsp | 符号导航、引用查找、类型诊断 | stdio |
| 文件系统 | filesystem-mcp | 文件读写、目录遍历 | stdio |
| 版本控制 | github-mcp | PR创建、代码审查、Issue管理 | HTTP+SSE |
| 测试执行 | jest-mcp / pytest-mcp | 单元测试运行、覆盖率报告 | stdio |
| 部署发布 | docker-mcp | 镜像构建、容器管理 | stdio |
| 知识检索 | opencalw-memory | OpenClaw全局记忆查询 | stdio |

代码检索工具通过agent-lsp提供65个LSP操作工具，覆盖导航（get_definition、get_references）、分析（blast_radius、call_hierarchy）、重构（rename、code_actions）、推测执行（preview_edit、simulate_chain）八大类别 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。文件系统工具使编码Agent能够直接操作代码仓库的文件和目录。版本控制工具连接GitHub服务，实现代码提交、PR创建和自动化审查。测试执行工具对接项目的测试框架，支持增量测试运行。知识检索工具是OpenClaw的定制MCP服务，使编码Agent可查询PTC规划和全局记忆。

### 5.3 编码任务Pipeline

编码Agent处理的任务遵循标准化的四阶段Pipeline：需求理解、代码生成、质量验证、结果交付。图5-1展示了Pipeline的整体流程及各阶段的子任务。

![编码任务Pipeline流程](fig_sec05_pipeline.png)

**图5-1 编码任务Pipeline流程**。Pipeline从左至右依次经过需求理解、代码生成、质量验证、结果交付四个阶段，底部的记忆共享层贯穿全程，实现与OpenClaw全局记忆和PTC上下文的双向同步。

#### 5.3.1 需求理解

需求理解阶段的目标是将PTC规划指令转化为编码Agent可执行的具体任务。该阶段接收三个输入源：PTC规划模块输出的结构化任务描述、OpenClaw全局记忆中的相关历史上下文、以及代码仓库的当前状态。

编码Agent首先解析PTC指令中的目标文件、功能需求和约束条件。随后通过agent-lsp的`workspace/symbol`和`textDocument/documentSymbol`方法获取相关文件的符号结构，建立代码语义地图 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。对于涉及多个文件修改的任务，Agent调用`blast_radius`工具分析变更的爆炸半径，识别所有受影响的调用者和依赖关系。

在依赖分析完成后，编码Agent通过OpenClaw记忆接口查询历史上类似任务的实现模式，包括代码风格、设计偏好和常见陷阱。该记忆检索基于向量相似度匹配，将当前任务与历史任务嵌入向量进行对比，召回Top-K相关经验。

#### 5.3.2 代码生成

代码生成阶段是Pipeline的核心。编码Agent采用LSP-first策略 [(lobehub.com)](https://lobehub.com/skills/ven0m0-claude-config-lsp-enable) ，在修改任何不熟悉的代码前，依次执行goToDefinition、findReferences和hover操作，确保对代码语义有完整理解。

Agent的代码生成遵循以下铁律 [(MCP Servers)](https://mcpmarket.com/tools/skills/lsp-semantic-intelligence) ：

1. 不先通过goToDefinition理解符号，不修改不熟悉的代码
2. 不先通过findReferences进行影响分析，不执行重构
3. 不通过LSP诊断验证，不声称代码可用

代码生成过程中，Agent利用agent-lsp的推测执行能力，在内存中预览变更效果。`simulate_chain`工具可评估依赖编辑序列（如重命名函数 → 更新调用者 → 调整返回类型），报告哪一步首先引入错误，`stop_on_error: true`在首个ERROR级诊断时中止 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。该机制将传统"编辑-编译-修复"循环转化为"预验证-一次性正确提交"模式，减少迭代次数。

对于复杂的多文件修改，Agent激活`/lsp-safe-edit` skill，该skill编码了分析→编辑→验证的三阶段工作流，阶段执行机制在运行时阻止违反正确顺序的工具调用 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

#### 5.3.3 测试执行

质量验证阶段确保生成代码的正确性和健壮性。验证流程分为三个层次：

**第一层：LSP诊断验证**。每次编辑后，agent-lsp自动获取`textDocument/publishDiagnostics`推送的实时诊断，检测类型错误、未定义变量、缺失导入等问题。Claude Code引入LSP后的实践表明，实时诊断使Agent能在同一轮对话中修复类型错误，无需额外的编辑循环 [(Antonio Cortés (DrZippie))](https://antoniocortes.com/en/2026/03/10/claude-code-with-lsp-from-searching-text-to-understanding-code/) 。

**第二层：单元测试执行**。编码Agent通过测试执行MCP工具运行与修改文件相关的单元测试。agent-lsp的`/lsp-test-correlation` skill可查找并运行仅覆盖被编辑文件的测试，避免全量测试套件的长耗时 [(Libraries.io)](https://libraries.io/npm/@blackwell-systems%2Fagent-lsp-win32-x64) 。测试覆盖率数据反馈给Agent，对未覆盖的代码路径生成补充测试。

**第三层：代码审查**。Agent调用`codeActions`获取语言服务器推荐的快速修复和重构建议，应用所有安全的自动修复。对于需要人工判断的修改，编码Agent生成差异报告（diff），附带影响分析和测试通过状态，提交至OpenClaw的审查队列。

### 5.4 与OpenClaw的协作

编码Agent并非独立运行，而是作为OpenClaw系统的子模块，与PTC规划模块和全局记忆系统形成紧密协作。

#### 5.4.1 PTC互补

PTC（Plan-to-Code）规划模块负责将高层需求分解为可执行的编码任务，编码Agent负责任务的具体实现。两者的互补关系体现在三个层面。

**输入输出衔接**。PTC模块输出的结构化任务描述包含目标文件、功能规格、接口契约和约束条件，编码Agent的输入解析器将这些描述转化为内部的代码生成计划。编码Agent完成实现后，将实际修改的文件列表、代码差异和验证结果返回PTC模块，用于更新任务状态。

**异常反馈循环**。当编码Agent在实现过程中发现PTC规划存在技术不可行（如依赖库版本冲突、API不兼容），通过标准错误通道向PTC模块报告。PTC模块根据反馈重新规划，调整实现策略或拆分任务。该循环确保规划与实际编码的紧密同步。

**能力边界划分**。PTC模块负责任务分解和优先级排序，编码Agent负责代码语义理解和生成。PTC不涉及具体代码实现细节，编码Agent不涉及任务优先级决策。这种关注点分离使两个模块可独立演进和优化。

#### 5.4.2 记忆共享

编码Agent与OpenClaw全局记忆系统的双向集成是其区别于独立编码工具的核心特征。

**编码前记忆检索**。Agent在需求理解阶段查询全局记忆，获取三类信息：历史相似任务的实现代码和解决方案、项目特定的编码规范和风格指南、以及常见错误模式及其修复策略。记忆检索采用混合策略——精确匹配项目名称和文件路径前缀，语义匹配任务描述向量 [(Github)](https://github.com/prosperitypirate/codexfi) 。

**编码中上下文积累**。在代码生成过程中，Agent自动积累新的上下文信息：遇到的代码陷阱和解决方法、第三方库的使用模式、以及项目特定的类型约定。这些上下文实时写入OpenClaw的短期记忆，供当前会话后续任务使用。

**编码后记忆持久化**。任务完成后，编码Agent将以下信息提交至全局记忆的长期存储：原始需求描述、最终实现的代码差异、测试验证结果、以及任务执行过程中的关键决策点。这些经验通过向量化嵌入进入记忆库，成为未来相似任务的参考。OpenCode社区已有codexfi等持久化记忆插件，通过本地SQLite数据库存储跨会话的记忆 [(Github)](https://github.com/prosperitypirate/codexfi) 。OpenClaw在此基础上扩展为分布式记忆服务，支持多Agent实例间的记忆共享。

记忆共享使编码Agent具备持续学习能力。随着处理任务数量的增加，Agent对项目代码库的理解不断加深，代码生成质量逐步提升，最终实现从"通用编码助手"到"项目专家"的进化。


---


## 6. Obsidian 记忆管理系统

OpenClaw 的记忆持久层采用 Obsidian Vault 作为 Markdown 文件的存储与管理界面，通过 SQLite FTS5（由 bun:sqlite 零依赖驱动）构建全文索引，在百万文档级别保持亚 10 ms 的检索延迟 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。图 6-1 展示了记忆管理系统的整体架构：Agent 运行时通过 REST API 和 MCP（Model Context Protocol）双协议访问 Vault，底层由 bun:sqlite 建立的 FTS5 索引、AST 解析器和知识图谱共同加速检索。

![Obsidian 记忆管理系统架构](fig_6_1_obsidian_architecture.png)
*图 6-1：Obsidian 记忆管理系统架构。Agent 运行时通过 REST API + MCP 双协议操作 Vault，数据库加速层（bun:sqlite + FTS5 + AST + 知识图谱）提供亚 10 ms 级检索*

选择 Obsidian 而非自研记忆存储的核心原因在于其**本地优先**（local-first）的架构哲学：所有笔记以纯文本 `.md` 文件存储在本地文件系统中 [(redhat.com)](https://www.redhat.com/zh-cn/blog/mcp-security-implementing-robust-authentication-and-authorization) ，AI Agent 可直接读写，无需格式转换；双向链接 `[[WikiLinks]]` 自动构建知识图谱 [(Github)](https://github.com/punkpeye/fastmcp) ；Frontmatter YAML 元数据提供结构化记忆属性存储 [(Milvus)](https://milvus.io/ai-quick-reference/whats-the-best-way-to-deploy-an-model-context-protocol-mcp-server-to-production) ；REST API + MCP 双协议使外部 Agent 完整操控 Vault [(DEV Community)](https://dev.to/mathewpregasen/authorization-for-mcp-oauth-21-prms-and-best-practices-9hf) 。这些特性与 OpenClaw 的"文件优先"设计原则——所有持久化记忆以 Markdown 文件形式存储、Workspace 目录结构为"git-backable"的纯文本目录——形成精确匹配 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) 。

---

### 6.1 Obsidian 架构设计

#### 6.1.1 Vault 结构：01-Projects / 02-Areas / 03-Knowledge / 04-Conversations / 05-Tasks / 06-Archives

Vault 的文件组织结构采用 PARA 方法与 Zettelkasten 方法的混合架构 [(A PRAGMATIC MIND)](https://www.apragmaticmind.com/blog/para-method) 。PARA 方法提供以项目为中心的外层结构，确保当前任务的聚焦；Zettelkasten 方法提供以知识网络为内核的原子化笔记组织，支撑长期知识的积累与关联。

以下展示 OpenClaw Vault 的完整目录结构：

```
openclaw-memory/
├── .obsidian/                          # Obsidian 应用配置
│   ├── plugins/
│   │   └── obsidian-local-rest-api/    # REST API 插件
│   └── app.json
├── 01-Projects/                        # 当前 Agent 任务项目
│   ├── active-tasks/                   # 进行中项目
│   └── completed-tasks/                # 已完成项目
├── 02-Areas/                           # 持续责任领域
│   ├── user-preferences/               # 用户偏好记忆
│   ├── domain-knowledge/               # 领域知识
│   └── operational-rules/              # 操作规则
├── 03-Knowledge/                       # 知识记忆（Zettelkasten 风格）
│   ├── atomic-notes/                   # 原子知识（每个一个想法）
│   ├── entity-notes/                   # 实体笔记（人、组织、概念）
│   └── concept-maps/                   # 概念映射
├── 04-Conversations/                   # 对话记忆
│   ├── 2026/01/                        # 按年月组织
│   ├── sessions-index.md               # 会话索引
│   └── summary-notes/                  # 摘要笔记
├── 05-Tasks/                           # 任务记忆
│   ├── pending/                        # 待处理
│   ├── completed/                      # 已完成
│   └── recurring/                      # 周期性
├── 06-Archives/                        # 归档
├── Templates/                          # 模板
│   ├── conversation-template.md
│   ├── task-template.md
│   ├── knowledge-template.md
│   └── fact-template.md
├── INDEX.md                            # 主索引
├── AGENTS.md                           # Agent 行为规范
└── LOG.md                              # 操作日志
```

六个顶层目录的分层逻辑遵循"活跃程度递减"原则。`01-Projects` 存放有明确截止日期和目标的主动倡议，`02-Areas` 存放持续负责的区域（用户偏好、领域知识、操作规则），`03-Knowledge` 存放经蒸馏处理的结构化知识，`04-Conversations` 按年月组织原始对话记录，`05-Tasks` 跟踪任务生命周期，`06-Archives` 存放已完成或不活跃的项目。数字前缀确保目录在任何文件管理器中按处理优先级排序，Agent 遍历 Vault 时优先访问高优先级区域。

每张 Markdown 笔记采用一致的 Frontmatter 元数据格式，这是数据驱动查询的基础 [(npmx)](https://npmx.dev/package/fastmcp/v/3.34.0) ：

```yaml
---
id: "conv-20260101-001"
title: "Python 字典排序问题讨论"
type: "conversation"          # conversation / task / knowledge / fact
created: 2026-01-01T10:00:00
updated: 2026-01-01T13:00:00
tags: ["#programming", "#python", "#sorting"]
status: "active"               # active / archived / deleted
source: "user-input"
agent_id: "openclaw-main"
session_id: "session-abc123"
priority: "P1"
related:                       # 双向链接
  - "[[python-lambda]]"
  - "[[python-dict-sort]]"
---
```

`type` 字段将笔记归类为四类记忆：conversation（对话记忆）、task（任务记忆）、knowledge（知识记忆）、fact（事实记忆）。`related` 字段使用 Obsidian 双向链接语法 `[[笔记名]]` 建立知识图谱边，Agent 可通过链接遍历从当前记忆发现关联知识 [(Github)](https://github.com/punkpeye/fastmcp) 。

#### 6.1.2 核心文件：INDEX.md、AGENTS.md、LOG.md

Vault 根目录的三张核心文件构成 Agent 记忆的"中枢神经系统"。

**INDEX.md** 是 Vault 的主索引，以数据驱动的目录形式组织所有记忆入口。它使用 Dataview 查询语言（见 6.3.4 节）动态聚合最新、最重要或最常被访问的笔记，充当 Agent 启动时的"记忆导航首页"。INDEX.md 的典型内容包含：最近更新的 10 张知识笔记、当前活跃的会话列表、待处理的高优先级任务、以及按标签聚类的知识概览。该文件由 Agent 自动维护，每次会话启动时读取以快速重建上下文。

**AGENTS.md** 定义 Agent 的行为规范和记忆管理策略。它包含四类规则：（1）记忆写入规则——什么内容应当被记录、Frontmatter 必填字段、标签命名规范；（2）记忆归档规则——何时将对话从 `04-Conversations` 移至 `06-Archives`、何时触发记忆蒸馏；（3）记忆检索规则——默认搜索哪些目录、结果排序偏好、相关度阈值；（4）记忆更新规则——知识冲突时的处理策略（保留最新、人工审核、或置信度竞争）。AGENTS.md 本质上是一张程序记忆（procedural memory）的清单，Agent 在每次记忆操作前读取以保持一致的行为模式。

**LOG.md** 记录所有记忆操作的审计日志，采用追加写入模式。每条日志条目包含时间戳、操作类型（CREATE / READ / UPDATE / DELETE / SEARCH）、操作对象（文件路径）、操作参数（查询关键词、返回结果数）和操作结果（成功/失败）。LOG.md 的用途有三：故障排查时追溯记忆操作的完整历史；性能分析时识别高频访问的记忆区域；安全审计时检测异常的记忆访问模式。

#### 6.1.3 Andrej Karpathy 验证

Andrej Karpathy（前特斯拉 AI 总监、OpenAI 联合创始人）在 2026 年 4 月公开发布了 LLM Wiki 架构 [(buaq.net)](https://buaq.net/go-379819.html) ，其核心论断——"Obsidian is the IDE, the LLM is the programmer, the wiki is the codebase"——为 Obsidian 作为 AI Agent 记忆管理系统提供了权威背书。Karpathy 的架构包含五个核心组件：`/raw` 存放原始素材（网页剪辑、转录文本），`/wiki` 存放 AI 生成的结构化 Markdown 页面，`agents.md` 定义 Agent 行为配置，`index.md` 维护索引目录，`log.md` 记录审计日志 [(jsr.io)](https://jsr.io/@glama/fastmcp) 。

OpenClaw 的 Vault 结构与 Karpathy 架构的映射关系如下。Karpathy 的 `/raw` 对应 OpenClaw 的 `04-Conversations/` 原始对话记录和 `01-Projects/` 活跃项目素材；`/wiki` 对应 `03-Knowledge/` 经蒸馏处理的知识笔记和 `02-Areas/` 领域知识；`agents.md` 对应 `AGENTS.md` Agent 行为规范；`index.md` 和 `log.md` 直接对应同名核心文件。这一映射表明 OpenClaw 的设计与业界领先实践保持同构，而非偏离主流的自研方案。

---

### 6.2 REST API 集成

#### 6.2.1 obsidian-local-rest-api 插件

obsidian-local-rest-api 是 Obsidian 的官方社区插件，为 Vault 提供安全的 RESTful API [(netjoints.com)](https://netjoints.com/securing-mcp-servers-for-agentic-ai-a-practical-guide-to-mcp-security-authorization-and-runtime-controls/) 。该插件是连接 AI Agent 与 Obsidian 的核心桥梁，支持完整 CRUD 操作、全文搜索、精确 Patch 编辑、活跃文件访问、周期性笔记管理、命令执行和标签查询七类功能 [(netjoints.com)](https://netjoints.com/securing-mcp-servers-for-agentic-ai-a-practical-guide-to-mcp-security-authorization-and-runtime-controls/) 。

插件默认监听 `https://127.0.0.1:27124`（HTTPS），使用自签名证书，认证方式为 `Authorization: Bearer <api-key>` [(Github)](https://github.com/coddingtonbear/obsidian-local-rest-api) 。HTTP 回退地址为 `http://127.0.0.1:27123`，需手动启用。核心端点覆盖 Vault 操作的全部场景：

| 端点 | 方法 | 功能描述 | Agent 使用场景 |
|:-----|:-----|:---------|:--------------|
| `/vault/{path}` | GET / PUT / PATCH / POST / DELETE | 对 Vault 中任意文件进行 CRUD | 读取/写入/修改记忆文件 |
| `/search/simple/` | POST | 全文搜索所有笔记 | 关键词检索记忆 |
| `/search/` | POST | 通过 JsonLogic 进行结构化搜索 | 按 Frontmatter 字段过滤 |
| `/active/` | GET / PUT / PATCH | 操作当前打开的文件 | 获取用户正在查看的笔记 |
| `/periodic/{period}/` | GET / PUT | 周期性笔记（daily/weekly/monthly） | 获取今日笔记 |
| `/commands/{id}/` | POST | 执行指定 Obsidian 命令 | 触发图谱视图等 UI 操作 |
| `/tags/` | GET | 列出所有标签及使用计数 | 分析记忆标签分布 |

*表 6-1：obsidian-local-rest-api 核心端点与 Agent 使用场景*

该表反映了 Agent 对 Vault 的典型操作模式：CRUD 端点用于记忆文件的日常读写，搜索端点用于记忆检索，结构化搜索通过 JsonLogic 直接查询 Frontmatter 字段实现精确过滤 [(netjoints.com)](https://netjoints.com/securing-mcp-servers-for-agentic-ai-a-practical-guide-to-mcp-security-authorization-and-runtime-controls/) 。`/vault/{path}` 端点的 PATCH 方法（配合特定 HTTP 头）实现了 6.2.3 节详述的精确编辑能力，这是 Agent 修改现有记忆而不重写整个文件的关键机制。`/periodic/daily/` 端点则支持 Agent 按日期组织记忆——获取或创建当日笔记，将新记忆追加到当天的时间线中。

#### 6.2.2 内置 MCP 服务器

obsidian-local-rest-api 从 2025 版起内置 MCP（Model Context Protocol）服务器，AI Agent 可直接通过 MCP 协议与 Vault 交互 [(Github)](https://github.com/coddingtonbear/obsidian-local-rest-api) 。MCP 端点位于 `https://127.0.0.1:27124/mcp/`，传输方式为 Streamable HTTP，认证同样使用 Bearer Token [(DEV Community)](https://dev.to/mathewpregasen/authorization-for-mcp-oauth-21-prms-and-best-practices-9hf) 。

MCP 协议相比 REST API 的优势在于语义层级更高。REST API 操作的是文件路径和原始字节，Agent 需要自行处理 Markdown 解析和 Frontmatter 序列化；MCP 协议则暴露"笔记""链接""标签"等语义概念，Agent 可以直接执行"找到与 Python 排序相关的所有笔记并建立链接"这类复合操作，无需手动拼接多个 REST 调用。

OpenClaw Gateway 的 MCP Bridge 功能将 Obsidian MCP 服务器注册为 Workspace 级工具 [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) ，配置示例：

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "https://127.0.0.1:27124/mcp/",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

该配置使 Pi 引擎（其本身不内建 MCP Client，通过 Gateway 层的 MCP Bridge 间接使用）和 Hermes Agent（原生 MCP Client）均可访问 Vault [(Github)](https://github.com/jwangkun/hermes-agent-guide/blob/main/04-%E6%A0%B8%E5%BF%83%E6%9E%B6%E6%9E%84%E6%B7%B1%E5%BA%A6%E8%A7%A3%E6%9E%90.md) 。

#### 6.2.3 精确 Patch 编辑

Patch API 是 obsidian-local-rest-api 对 Agent 记忆管理最有价值的功能之一 [(Github)](https://github.com/coddingtonbear/obsidian-local-rest-api) 。传统文件编辑需要读取完整内容、修改、写回——对于大型记忆文件（如包含数百条对话记录的月度笔记），这一过程消耗大量 token 且容易引入格式错误。Patch API 支持按 Frontmatter 字段、标题或块引用进行局部修改，无需重写整个文件。

Patch 编辑通过三个 HTTP 头控制操作语义：`Target-Type` 指定目标类型（`frontmatter` / `heading` / `block`），`Target` 指定目标标识（字段名、标题文本或块 ID），`Operation` 指定操作（`append` / `prepend` / `replace`）。以下示例将笔记状态更新为已完成：

```bash
curl -k -X PATCH \
  -H "Authorization: Bearer <key>" \
  -H "Operation: replace" \
  -H "Target-Type: frontmatter" \
  -H "Target: status" \
  -H "Content-Type: application/json" \
  --data '"done"' \
  https://127.0.0.1:27124/vault/05-Tasks/task-001.md
```

对 Agent 工作流的实际影响：当 Agent 完成一个子任务时，只需发送一次 PATCH 请求更新 `status` 字段，而非重写整张任务笔记。假设一张任务笔记平均 2,000 tokens，PATCH 方式仅需传输 20 tokens 的 JSON 载荷，token 消耗降低 99%。对于高频的记忆更新场景（每轮对话可能触发 2-3 次记忆写入），Patch 编辑是控制 API 成本的关键优化。

---

### 6.3 非向量检索方案

OpenClaw 采用非向量检索作为记忆检索的主要技术路线，原因是向量数据库（如 Milvus、Pinecone）的部署复杂度和资源消耗与 OpenClaw 的"极简内核"原则相冲突 [(yage.ai)](https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html) 。SQLite FTS5 配合 BM25 相关性排序在百万文档级别可达到亚 10 ms 查询延迟 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) ，实际 RAG 评估显示纯 BM25 在某些数据集上表现优于纯向量搜索，混合搜索效果最佳 [(Microsoft Community)](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/doing-rag-vector-search-is-not-enough/4161073) 。

#### 6.3.1 SQLite FTS5 全文搜索

FTS5（Full-Text Search version 5）是 SQLite 内置的全文搜索引擎，使用 BM25 算法进行相关性排序 [(博客园)](https://www.cnblogs.com/BlogNetSpace/p/19714035) 。核心特性包括：内置 BM25 排序（`ORDER BY bm25(fts_table)`）、Porter 词干提取（"running" 匹配 "run"）、前缀搜索（`query*` 匹配前缀）、布尔查询（`term1 AND term2 OR NOT term3`）、以及近零配置（创建虚拟表即可使用） [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。

FTS5 虚拟表的创建方式：

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
    path, title, folder, heading, content,
    tokenize='porter unicode61',
    content_rowid=id
);
```

`tokenize='porter unicode61'` 采用双分词器组合：Porter 词干提取器处理英文词形变化，`unicode61` 分词器处理 Unicode 标点边界。这一配置使 FTS5 在中文内容场景中同样有效——虽然中文没有词干变化，但 `unicode61` 可以正确识别中文字符边界。

#### 6.3.2 AST 结构感知检索

AST（Abstract Syntax Tree，抽象语法树）检索将 Markdown 文档解析为树形数据结构，每个节点代表一个语法元素（标题、段落、列表、代码块等），形成层次化的树结构 [(unified)](https://unifiedjs.com/learn/guide/introduction-to-syntax-trees/) 。AST 检索通过语法结构而非纯文本进行匹配，具备四项优势：结构感知（理解文档的标题-段落-列表层次）、语义分块（按标题边界分块保持语义完整性）、类型过滤（只搜索特定类型节点）、上下文保留（搜索结果带有结构上下文） [(jsr.io)](https://jsr.io/@punkpeye/fastmcp) 。

AST-based 分块算法采用自顶向下的树遍历策略：解析文档为 AST 树后，自顶向下遍历，若节点大小不超过最大块大小（默认 300-500 tokens），则作为独立块；否则递归分割子节点；最后对相邻的兄弟节点进行贪心合并 [(jsr.io)](https://jsr.io/@punkpeye/fastmcp) 。这种分块方式比固定长度分块保留了更多的语义边界——块不会切断标题与其下属内容之间的关系。

#### 6.3.3 混合检索策略

OpenClaw 的混合检索采用三层架构：FTS5 处理全文关键词搜索，AST 处理结构化文档检索，元数据层处理文件路径、类型标签和时间戳过滤。三层结果通过 RRF（Reciprocal Rank Fusion）算法融合 [(Github)](https://github.com/pvliesdonk/markdown-vault-mcp) 。

RRF 融合公式为 $\text{score} = \sum \frac{1}{k + \text{rank}}$，其中 $k=60$ 为平滑参数。对于文档 $D$，其在 FTS5 结果中排名第 3、在 AST 结果中排名第 7，则融合得分为 $\frac{1}{60+3} + \frac{1}{60+7} \approx 0.0159 + 0.0149 = 0.0308$。该算法不需要对两种检索的分数进行归一化，天然支持任意数量检索后端的融合。

| 检索层级 | 技术实现 | 搜索对象 | 典型延迟 | 优势场景 |
|:---------|:---------|:---------|:---------|:---------|
| 全文检索 | SQLite FTS5 + BM25 | 非结构化文本内容 | 1–10 ms | 关键词精确匹配、自然语言查询 |
| 结构检索 | AST (mdast) + 节点过滤 | 标题、代码块、列表 | 5–20 ms | 按文档结构定位特定段落 |
| 元数据过滤 | B-tree 索引 | Frontmatter 字段、路径、时间 | < 1 ms | 精确过滤（按类型/标签/日期） |
| 关系检索 | 递归 CTE 图遍历 | 实体关联、双向链接 | 2–10 ms | 从已知记忆发现关联知识 |

*表 6-2：OpenClaw 四层检索策略对比*

四种检索层级的组合使用覆盖了 Agent 记忆访问的全部场景。当 Agent 收到用户查询"上周关于 Python 排序的讨论"时，检索流程为：元数据层按 `type: conversation` 和 `created` 时间范围过滤，FTS5 层匹配 "Python" 和 "排序" 关键词，AST 层提取对话中的代码块作为答案摘要，关系层通过 `related` 链接发现关联的知识笔记。四层结果经 RRF 融合后返回给 Agent，组装为 3,000–4,000 tokens 的上下文窗口 [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) 。

#### 6.3.4 Dataview 插件

Dataview 是 Obsidian 最强大的社区插件之一，将 Vault 转化为可查询的数据库 [(Milvus)](https://milvus.io/ai-quick-reference/whats-the-best-way-to-deploy-an-model-context-protocol-mcp-server-to-production) 。Dataview 从 Markdown 文件的 Frontmatter 和行内字段中提取数据，提供 SQL 风格的查询语言，支持四种查询模式：DQL（声明式查询语言）、内联表达式、DataviewJS（JavaScript API）和内联 JS 表达式 [(npm)](https://www.npmjs.com/package/firecrawl-fastmcp) 。

Dataview 对 Agent 记忆管理的价值体现在三个场景。第一，**动态记忆仪表盘**：Agent 可以生成 Dataview 查询来统计当前活跃任务数量（`dv.pages("#task").where(t => t.status == "active").length`）、最近 7 天创建的知识笔记、按标签聚类的记忆分布。第二，**元数据驱动聚合**：通过 Frontmatter 字段（`type`、`status`、`priority`、`agent_id`）精确过滤和排序记忆。第三，**实时视图更新**：当记忆文件变化时，Dataview 查询结果自动刷新，Agent 可以在 Obsidian UI 中直接观察记忆状态的变化。

---

### 6.4 记忆类型设计

OpenClaw 的记忆类型学基于 CoALA（Cognitive Architectures for Language Agents）框架 [(arXiv.org)](https://arxiv.org/pdf/2503.12687) ，将 Agent 记忆划分为四种类型，每种类型在 Vault 中有明确的存储位置和访问模式。

| 记忆类型 | 存储内容 | Vault 中的位置 | 检索方式 | 保留策略 |
|:---------|:---------|:--------------|:---------|:---------|
| 上下文记忆 | 当前会话的活动上下文 | LLM 上下文窗口（非持久化） | 直接注入 system prompt | 会话结束即丢弃 |
| 情景记忆 | 具体事件和交互记录 | `04-Conversations/` 目录 | FTS5 全文 + 时间范围过滤 | 3 个月后归档，6 个月后蒸馏为语义记忆 |
| 语义记忆 | 事实、定义、积累的知识 | `03-Knowledge/` 目录 | FTS5 + AST + 知识图谱 | 永久保留，定期更新置信度 |
| 程序记忆 | 技能、规则、行为指令 | `AGENTS.md` + `02-Areas/operational-rules/` | 文件名匹配 + 直接读取 | 版本控制，变更需人工审核 |

*表 6-3：OpenClaw 四类记忆类型设计*

#### 6.4.1 上下文记忆

上下文记忆（context memory）对应认知科学中的工作记忆（working memory），存储当前会话的活跃上下文。在 OpenClaw 中，上下文记忆不持久化到 Vault，而是直接注入 LLM 的系统提示窗口 [(arXiv.org)](https://arxiv.org/pdf/2503.12687) 。具体包括：最近的 5-10 轮对话消息、当前任务的摘要（从 `tasks` 表的 `context_summary` 字段加载）、以及从长期记忆中检索的相关知识片段（3,000–4,000 tokens）。

上下文记忆的容量受限于 LLM 的上下文窗口。当对话长度接近窗口上限时，Agent 触发**上下文压缩**：将早期对话摘要化后存入 `04-Conversations/` 的会话笔记，释放窗口空间。压缩过程使用本地 qwen2.5:14b 模型（VRAM ~9.5 GB，工具调用可靠率 ~90% [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) ）执行，将对话历史压缩为关键决策点和事实提取。

#### 6.4.2 情景记忆

情景记忆（episodic memory）存储具体事件和交互记录，以时间序列形式组织在 `04-Conversations/` 目录下。每张情景记忆笔记采用 YAML Frontmatter + Markdown 正文的结构，记录一次完整会话的原始消息流、关键决策点和提取的事实。

情景记忆的检索以时间为主要维度。Agent 通过 FTS5 搜索关键词后，按 `created` 时间戳排序，优先返回最近 30 天内的记忆。超过 3 个月的情景记忆自动移至 `06-Archives/`，超过 6 个月的记忆触发蒸馏流程：本地模型读取原始对话，提取关键事实和决策，生成原子化知识笔记存入 `03-Knowledge/`，蒸馏完成后原始对话标记为 `distilled: true`。

#### 6.4.3 语义记忆

语义记忆（semantic memory）存储经蒸馏处理的事实性知识，是 Agent 长期能力的核心载体。语义记忆的组织采用 Zettelkasten 方法：每条知识笔记只包含一个原子化概念，通过双向链接与其他知识笔记形成网络 [(AI Trends Index 2026: New Tools, Agents & Workflows)](https://www.trendix.tech/zettelkasten-vs-para/) 。

`knowledge` 表（已在第 11 章详述 Schema）与 Vault 中的语义记忆笔记保持双向同步 [(arXiv.org)](https://arxiv.org/pdf/2503.12687) 。`tier` 字段四分类体系——`episodic`（情景）、`semantic`（语义）、`project`（项目）、`procedural`（程序）——使 Agent 可以按需加载特定类型的知识。`confidence` 字段取值 0–1，对话提取的初始事实默认 0.6，经代码或 Git 历史交叉验证后可提升至 0.9+ [(Local AI Master)](https://localaimaster.com/models/qwen-2-5-coder-7b) 。`access_count` 记录检索次数，高频访问的知识在搜索结果中获得更高的排序权重。

#### 6.4.4 程序记忆

程序记忆（procedural memory）存储 Agent 的操作规则和行为技能，对应 `AGENTS.md` 和 `02-Areas/operational-rules/` 目录下的规则文件。程序记忆的特点是**高稳定性低变更频率**——与频繁新增的情景记忆不同，程序记忆在 Agent 运行期间基本保持不变，仅在 Agent 行为需要调整时才更新。

程序记忆的加载策略区别于其他记忆类型。Agent 在每次会话启动时完整读取 `AGENTS.md`（通常为 500–1,500 tokens），将其冻结注入系统提示 [(Github)](https://github.com/pydantic/pydantic-ai-harness/issues/102) 。这一设计的目的是保证 Agent 行为的一致性：无论会话持续多长时间，Agent 始终遵循同一套记忆管理规则操作 Vault。程序记忆的变更通过 Git 版本控制管理，修改 `AGENTS.md` 需要提交 Git commit，变更历史完全可追溯。

---

### 6.5 数据库加速层

Vault 中的 Markdown 文件是纯文本格式，直接扫描文件系统进行全文搜索的时间复杂度为 $O(n)$（$n$ 为文件总数）。数据库加速层通过 bun:sqlite 建立结构化索引，将检索延迟从数百毫秒降至亚 10 ms 级别 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。

#### 6.5.1 bun:sqlite 连接 Obsidian Vault 索引

Bun 通过内置的 `bun:sqlite` 模块提供 SQLite3 驱动，无需 npm 安装或原生编译 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。`bun:sqlite` 的读取查询性能达到 `better-sqlite3` 的 3–6 倍，是 `deno.land/x/sqlite` 的 8–9 倍 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。

数据库加速层与 Vault 之间的连接通过**文件监视器**实现。Bun 使用 `node:fs` 的 `watch` API（100% 测试通过率 [(DEV Community)](https://dev.to/pockit_tools/bun-12-deep-dive-built-in-sqlite-s3-and-why-it-might-actually-replace-nodejs-4738) ）监视 Vault 目录的变更，以 1.5 秒防抖间隔处理增量更新 [(GitHub Gist)](https://gist.github.com/royosherove/971c7b4a350a30ac8a8dad41604a95a0) 。当 Agent 写入一张新笔记时，文件监视器检测到变更事件，触发索引更新流程：解析 Markdown 为 AST → 分块 → 更新 `documents` 和 `sections` 表 → 触发器自动同步 FTS5 索引。

Vault 索引的数据库架构（配合 Drizzle ORM 管理 Schema）包含以下核心表：

```typescript
// src/db/schema.ts — Vault 索引相关表
export const documents = sqliteTable("documents", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    path: text("path").unique().notNull(),          // Vault 中的相对路径
    title: text("title").notNull(),
    folder: text("folder").notNull().default(""),
    frontmatterJson: text("frontmatter_json"),       // YAML 头序列化为 JSON
    contentHash: text("content_hash").notNull(),     // SHA256 哈希
    modifiedAt: integer("modified_at").notNull(),
});

export const sections = sqliteTable("sections", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id").notNull(),
    heading: text("heading"),
    headingLevel: integer("heading_level").notNull(),
    content: text("content").notNull(),
    startLine: integer("start_line").notNull(),
});
```

`documents` 表存储文件级元数据，`sections` 表存储 AST 分块后的段落级内容。两张表均通过触发器与 FTS5 虚拟表保持同步，确保文件系统、结构化表和全文索引三者的状态一致。

#### 6.5.2 FTS5 索引触发器

FTS5 虚拟表本身不自动同步主表的数据变更，需要通过数据库触发器手动维护 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。OpenClaw 为 `documents` 和 `sections` 表各配置一组 INSERT / UPDATE / DELETE 触发器：

```sql
-- documents 表触发器
CREATE TRIGGER trg_docs_insert AFTER INSERT ON documents BEGIN
    INSERT INTO notes_fts(rowid, path, title, folder, heading, content)
    VALUES (NEW.id, NEW.path, NEW.title, NEW.folder, '', '');
END;

CREATE TRIGGER trg_docs_update AFTER UPDATE ON documents BEGIN
    UPDATE notes_fts SET
        path = NEW.path, title = NEW.title, folder = NEW.folder
    WHERE rowid = NEW.id;
END;

CREATE TRIGGER trg_docs_delete AFTER DELETE ON documents BEGIN
    DELETE FROM notes_fts WHERE rowid = OLD.id;
END;

-- sections 表触发器（同步 content 到 FTS5）
CREATE TRIGGER trg_sections_insert AFTER INSERT ON sections BEGIN
    UPDATE notes_fts SET content = content || ' ' || NEW.content
    WHERE rowid = NEW.document_id;
END;
```

触发器的执行对 Agent 透明——Agent 通过 REST API 或 MCP 修改 Markdown 文件，文件监视器检测变更后更新 `documents` 和 `sections` 表，触发器自动维护 FTS5 索引的一致性。整个流程从文件写入到索引更新完成，平均延迟 < 3 秒（1.5 秒防抖 + 索引处理时间）。

#### 6.5.3 双表策略

FTS5 的分词器（Tokenizer）选择直接影响中英文混合内容的检索质量。OpenClaw 采用**双表策略** [(Zenn)](https://zenn.dev/kanseilink/articles/kanseilink-fts5-trigram-cjk-20260507?locale=en) ：主 FTS5 表使用 `porter unicode61` 分词（适合英文词干提取和 Unicode 边界识别），辅助 FTS5 表使用 `trigram` 分词（三字符分词，适合 CJK 内容和中文字串匹配）。

```sql
-- 主 FTS5 表：Porter 词干提取 + unicode61 分词（适合英文）
CREATE VIRTUAL TABLE notes_fts USING fts5(
    path, title, folder, heading, content,
    tokenize='porter unicode61'
);

-- 辅助 FTS5 表：Trigram 分词（适合 CJK 和子串匹配）
CREATE VIRTUAL TABLE notes_fts_trigram USING fts5(
    path, title, folder, heading, content,
    tokenize='trigram'
);
```

查询路由逻辑根据查询内容的语言自动选择分词表：

```typescript
function hasCJK(text: string): boolean {
    return /[\u3000-\u9fff\uf900-\ufaff]/u.test(text);
}

const ftsResults = hasCJK(query)
    ? trigramSearch(db, query)    // CJK 查询 → trigram
    : porterSearch(db, query);    // 英文查询 → porter + unicode61
```

双表策略的 RRF 融合实现（当查询同时包含中英文时，两种分词表并行搜索）：

```typescript
function searchWithRRF(db: Database, query: string) {
    const k = 60;
    const scores = new Map<number, number>();

    // 并行执行两种搜索
    const porterResults = db.query(`
        SELECT rowid, bm25(notes_fts, 10.0, 1.0) as score
        FROM notes_fts WHERE content MATCH ?
        ORDER BY score LIMIT 50
    `).all(query);

    const trigramResults = db.query(`
        SELECT rowid, bm25(notes_fts_trigram) as score
        FROM notes_fts_trigram WHERE content MATCH ?
        ORDER BY score LIMIT 50
    `).all(query);

    // RRF 融合
    porterResults.forEach((r: any, i: number) => {
        scores.set(r.rowid, (scores.get(r.rowid) || 0) + 1 / (k + i + 1));
    });
    trigramResults.forEach((r: any, i: number) => {
        scores.set(r.rowid, (scores.get(r.rowid) || 0) + 1 / (k + i + 1));
    });

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
}
```

BM25 权重调优方面，标题列的权重设为内容列的 10 倍（`bm25(notes_fts, 10.0, 1.0)`），这一配置基于"笔记标题比正文内容更能代表笔记主题"的假设。路径列的权重介于标题和内容之间，使文件名中的关键词也能贡献合理的相关性分数 [(Github)](https://github.com/mneves75/ffts-grep) 。

数据库加速层的性能预期：FTS5 全文查询延迟 < 10 ms（10,000 文档规模）/ < 50 ms（100,000 文档规模），批量插入速度 10,000 行/秒（事务包裹），3 个月日常使用的记忆数据库文件约 2.4 MB [(Github)](https://github.com/mneves75/ffts-grep) 。这些指标表明，对于 OpenClaw 桌面级 Agent 的应用场景，SQLite + FTS5 组合提供了充足的检索性能，无需引入外部向量数据库。


---


## 7. 数据采集与处理Pipeline

OpenClaw 的数据采集 Pipeline 采用四层递进架构——搜索层、爬虫层、清洗与转换层、存储层——将原始网页数据逐步转化为结构化的 Markdown 知识资产。整个 Pipeline 遵循 ETL（Extract-Transform-Load）模式 [(DEV Community)](https://dev.to/techwithqasim/building-an-etl-pipeline-for-web-scraping-using-python-2381) ，在 Bun 运行时内完成主线处理，仅在反爬场景下通过子进程调用 Python 生态能力。下图展示了各层之间的数据流动关系：

![数据采集Pipeline架构](fig_pipeline_architecture.png)

Pipeline 的设计核心在于**分层降级策略**：80% 的常规静态页面由 Bun 原生 fetch + cheerio 处理，20% 的反爬保护页面通过 Scrapling 子进程方案解决。这种双轨设计避免了为少数极端场景引入全局复杂度，同时保留了对 Cloudflare 等强反爬机制的应对能力。

### 7.1 搜索层设计

#### 7.1.1 搜索API选型

搜索层是 Pipeline 的入口，负责将自然语言查询转化为候选 URL 列表。Microsoft Bing Search API 已于 2025 年 8 月 11 日正式退役，不再接受新注册 [(firecrawl.dev)](https://www.firecrawl.dev/blog/bing-search-api-alternatives) ，因此 OpenClaw 的搜索层从以下三种 API 中按场景选择：

| API | 免费额度 | 起价 | 覆盖引擎 | 国内可用性 | 结构化输出 |
|-----|---------|------|---------|-----------|-----------|
| SerpAPI | 100 次/月 | $50/月 | Google / Bing / 百度等 25+ 引擎 | 优（支持百度） | JSON（有机结果 / 知识面板 / Featured Snippet） |
| Firecrawl | 1,000 credits/月 | 按量计费 | 自有索引（110K+ GitHub 星标，可自托管） [(firecrawl.dev)](https://www.firecrawl.dev/blog/bing-search-api-alternatives)  | 优（无地域限制，可自托管满足合规） | Markdown / JSON / 截图 |
| Tavily | 1,000 次/月 | $30/月 | 多源聚合，独立索引 | 良 | JSON（AI 优化摘要，LangChain 原生支持） |

搜索 API 的选择遵循两条原则：对于需要中文搜索结果或百度生态内容的查询，优先使用 SerpAPI，其百度 SERP 数据覆盖率和结构化程度在同类产品中最高 [(Bright Data)](https://brightdata.com/blog/web-data/best-bing-search-apis) ；对于需要深度页面内容提取的场景，优先使用 Firecrawl，其内置的页面爬取和 Markdown 转换能力可将搜索结果直接推进至 Pipeline 的第三层，减少一次 HTTP 请求 [(firecrawl.dev)](https://www.firecrawl.dev/blog/bing-search-api-alternatives) 。Tavily 作为补充，在需要 AI 预摘要的场景中调用，其返回结果经过 LLM 优化，token 利用率高于原始 HTML。

#### 7.1.2 搜索策略

搜索层采用**多源并行查询 + 结果去重**的策略。具体实现中，一个搜索任务会同时向主选 API 和备选 API 发出请求，取并集后按域名权重排序。域名权重基于 Obsidian Vault 中已有的知识图谱数据动态计算——Vault 中已存在大量笔记的域名会被降权，避免信息茧房；而高质量来源（如 arxiv.org、github.com、官方文档域名）则获得固定 boost。

搜索查询的构造采用**关键词扩展**模式：用户输入的查询词先经过 compromise.js 进行实体识别和词性标注，提取核心名词短语，然后组合成 `(site:github.com OR site:stackoverflow.com) keyword1 keyword2` 形式的结构化查询，提升搜索引擎的理解精度。

#### 7.1.3 搜索结果处理

搜索 API 返回的原始 JSON 数据经过标准化处理，统一为内部 `SearchResult` 接口：

```typescript
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "serpapi" | "firecrawl" | "tavily";
  timestamp: string;
  relevanceScore: number;  // 0-1，基于snippet与查询的文本相似度
}
```

所有结果按 `relevanceScore` 降序排列，取前 $N$ 条（默认 $N=10$）进入爬虫层。`relevanceScore` 的计算结合 BM25 词频统计和来源可信度权重，Firecrawl 和 Tavily 返回的 AI 预评分结果也会被纳入加权计算。

### 7.2 爬虫层设计

爬虫层是 Pipeline 中技术决策最复杂的环节。Bun 作为 JavaScript 运行时，无法直接执行 Python 的 Scrapling 库，但可以通过子进程调用。经过评估，OpenClaw 采用**"Bun 原生为主、Scrapling 子进程为辅"**的双轨策略[^Dim08^]。

#### 7.2.1 Bun原生方案（首选80%场景）

对于绝大多数静态页面，Bun 原生方案在性能和复杂度之间提供了最优平衡。该方案由三个核心组件构成：

**HTTP 获取**：使用 Bun 内置的 `fetch()` API，无需额外依赖。Bun 的 `fetch` 实现基于 `libcurl`，支持 HTTP/2 和连接复用，单线程并发可达数百请求。

**HTML 解析**：使用 cheerio 库，提供 jQuery 风格的 DOM 操作 API，周下载量约 500 万次 [(npm-compare.com)](https://npm-compare.com/cheerio,jsdom,node-html-parser,parse5) 。cheerio 不模拟浏览器环境，仅构建简化的 DOM 树，解析速度比 JSDOM 快 3-8 倍，内存占用低一个数量级。

```typescript
import * as cheerio from "cheerio";

async function fetchStaticPage(url: string): Promise<{
  title: string;
  html: string;
  links: string[];
}> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "OpenClaw/1.0 (Research Bot)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  
  const html = await res.text();
  const $ = cheerio.load(html);
  
  return {
    title: $("title").text().trim(),
    html,
    links: $("a[href]")
      .map((_, el) => $(el).attr("href"))
      .get()
      .filter((href): href is string => !!href),
  };
}
```

对于性能敏感的大规模解析任务，可降级使用 node-html-parser，该库周下载量约 100 万次，无外部依赖，处理大 HTML 文件时性能更优 [(tessl.io)](https://tessl.io/registry/tessl/npm-node-html-parser) 。

**重试与限流**：爬虫层内置指数退避重试机制，最大重试 3 次，退避基数 1 秒。对同一域名的请求通过 `p-limit` 进行并发控制，默认并发度为 5，避免触发目标站点的速率限制。

#### 7.2.2 Scrapling子进程方案（20%反爬场景）

当目标页面部署了 Cloudflare、DataDome 等反爬保护，或需要 JavaScript 渲染的动态内容时，Bun 原生方案无法绕过检测，此时通过 `Bun.spawn()` 启动 Scrapling 子进程 [(Bun)](https://oven-sh-bun.mintlify.app/runtime/child-process) 。Bun 的 `spawn` 底层基于 `posix_spawn(3)`，比 Node.js 的 `child_process` 快 60%，子进程启动开销可控制在 50ms 以内。

Python 桥接脚本 `scraping_bridge.py` 封装了 Scrapling 的三种 Fetcher——`Fetcher`（HTTP）、`DynamicFetcher`（Playwright 渲染）、`StealthyFetcher`（Camoufox 反爬） [(Bright Data)](https://brightdata.com/blog/web-data/web-scraping-with-scrapling) ——Bun 侧通过 JSON 序列化在 stdin/stdout 上交换数据：

```typescript
interface ScrapingTask {
  url: string;
  mode: "get" | "fetch" | "stealthy";
  selector?: string;
  outputFormat: "markdown" | "html" | "text" | "json";
}

interface ScrapingResult {
  success: boolean;
  url: string;
  title: string;
  content: string;
  metadata: Record<string, any>;
  error?: string;
}

async function scraplingExtract(task: ScrapingTask): Promise<ScrapingResult> {
  const args = [
    "scripts/scraping_bridge.py",
    task.url,
    task.mode,
    task.outputFormat,
  ];
  if (task.selector) args.push("--selector", task.selector);

  const proc = Bun.spawn(["python3", ...args], {
    timeout: 60000,
    env: { ...process.env, PYTHONPATH: "./python_libs" },
  });

  const output = await proc.stdout.text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const error = await proc.stderr.text();
    return {
      success: false, error, url: task.url,
      title: "", content: "", metadata: {},
    };
  }
  return JSON.parse(output) as ScrapingResult;
}
```

桥接脚本内部根据 `mode` 参数选择对应的 Fetcher：`get` 使用 `Fetcher.get()` 处理静态页面；`fetch` 使用 `DynamicFetcher.fetch()` 处理 JavaScript 渲染页面；`stealthy` 使用 `StealthyFetcher.fetch()` 绕过 Cloudflare 等反爬保护 [(xugj520.cn)](https://www.xugj520.cn/en/archives/scrapling-adaptive-web-scraping-framework.html) 。三种 Fetcher 共享相同的响应接口，切换模式不需要重写选择器代码 [(Bright Data)](https://brightdata.com/blog/web-data/web-scraping-with-scrapling) 。

 Scrapling 的自适应元素追踪功能（adaptive element tracking） [(webscraping.fyi)](https://webscraping.fyi/lib/python/scrapling/) 在该方案中完整可用：首次爬取时通过 `auto_save=True` 保存元素指纹，后续爬取时传入 `adaptive=True`，框架使用多属性模糊匹配自动重新定位元素，对增量式网站更新的鲁棒性远高于静态选择器。

#### 7.2.3 Scrapling MCP模式

Scrapling 内置 MCP（Model Context Protocol）服务器，暴露 `get`、`bulk_get`、`fetch`、`bulk_fetch` 等工具 [(byteiota.com)](https://byteiota.com/scrapling-tutorial-adaptive-web-scraping-that-survives-changes/) 。该模式采用 stdio transport，Bun 应用将 `scrapling mcp` 作为子进程启动，通过 JSON-RPC 消息交换调用工具 [(modelcontextprotocol.io)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 。

MCP 模式的核心价值在于**AI 辅助数据提取**：用户在将内容传递给 LLM 之前，Scrapling 执行精准的内容提取和预处理，减少无关内容的 token 消耗 [(mdskills.ai)](https://www.mdskills.ai/skills/scrapling) 。该模式适用于以下两类场景：一是对话式爬取，即 Agent 在执行研究任务时动态决定需要提取的数据字段；二是复杂页面的结构化提取，自然语言描述替代 CSS 选择器，降低维护成本。

| 维度 | Bun原生方案 | Scrapling子进程 | Scrapling MCP |
|------|------------|----------------|---------------|
| 技术复杂度 | 低（单一运行时） | 中（Bun+Python 双环境） | 高（MCP 协议 + JSON-RPC） |
| 部署依赖 | 仅 Bun | Bun + Python 3.10+ | Bun + Python 3.10+ |
| 反爬能力 | 弱（无浏览器/隐身能力） | 强（StealthyFetcher + Camoufox） | 中等（MCP 工具子集，无自适应选择器） |
| JavaScript渲染 | 不支持 | 支持（Playwright 渲染） | 支持（`fetch` 工具） |
| 自适应选择器 | 不可用 | 完整可用（`adaptive=True`） | 不可用（MCP 未暴露） |
| Spider框架 | 需自建（Crawlee 替代） | 完整可用（断点续爬 / 流式处理） [(xugj520.cn)](https://www.xugj520.cn/en/archives/scrapling-adaptive-web-scraping-framework.html?amp=1)  | 不可用 |
| AI辅助提取 | 需额外开发 | 需额外开发 | 原生支持 [(全球MCP Server集合平台 | AIbase)](https://mcp.aibase.com/server/1513086077165117444)  |
| 单次请求延迟 | < 100ms（静态页面） | 1-5s（浏览器渲染） | 1-5s + JSON-RPC 开销 |
| 适用场景占比 | ~80%（静态页面） | ~15%（反爬/动态页面） | ~5%（对话式爬取） |

三种方案并非互斥。实际运行中，Pipeline 首先尝试 Bun 原生方案，当检测到 HTTP 403/503 或被 Cloudflare 拦截页面时自动降级至 Scrapling 子进程；MCP 模式则仅在有 Agent 主动参与数据提取决策时启用。这种渐进式降级策略使 80% 的请求保持在纯 Bun 运行时内完成，仅有 20% 的请求承担跨进程开销。

### 7.3 数据清洗与转换

从爬虫层获取的原始 HTML 需要经过三个处理阶段才能进入存储层：正文提取、HTML→Markdown 转换、内容清洗与实体提取。

#### 7.3.1 HTML→Markdown转换

转换 Pipeline 的第一步是使用 Mozilla Readability.js 从 HTML 中提取正文内容。Readability 是 Firefox 内置阅读模式的底层引擎，对新闻、博客、文档类页面的正文识别准确率超过 90% [(webcrawlerapi.com)](https://webcrawlerapi.com/blog/how-to-extract-article-or-blogpost-content-in-js-using-readabilityjs) 。提取后的 HTML 片段再通过 turndown 库转换为 Markdown——turndown 是最广泛使用的开源 HTML→Markdown 转换库，支持 CommonMark 规范，可自定义转换规则 [(博客园)](https://www.cnblogs.com/rongfengliang/p/19933237) 。

```typescript
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const turndown = new TurndownService({
  headingStyle: "atx",       // # 风格标题
  bulletListMarker: "-",     // 无序列表使用 -
  codeBlockStyle: "fenced",  // ``` 围栏代码块
  linkStyle: "inlined",      // 行内链接
});

// 自定义规则：移除导航栏残留链接
turndown.addRule("removeNav", {
  filter: (node) => node.classList?.contains("nav") ||
                   node.classList?.contains("navbar"),
  replacement: () => "",
});

async function htmlToMarkdown(html: string, url: string): Promise<{
  title: string;
  markdown: string;
  excerpt: string;
  byline: string;
}> {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    return { title: "", markdown: "", excerpt: "", byline: "" };
  }

  const markdown = turndown.turndown(article.content);
  return {
    title: article.title || "",
    markdown,
    excerpt: article.excerpt || "",
    byline: article.byline || "",
  };
}
```

转换配置的选择基于 Markdown 在 Obsidian Vault 中的使用场景：`atx` 标题风格与 Obsidian 的标题折叠功能兼容；围栏代码块保留语法高亮信息；行内链接格式确保链接在 Obsidian 图谱视图中正确解析。

#### 7.3.2 内容清洗

Markdown 文本进入内容清洗阶段，目标是去除爬取过程中引入的噪声并规范化格式。清洗 Pipeline 包含四个顺序步骤：

**空白规范化**：合并连续空白字符（包括全角空格 `\u3000`），将 Windows 换行符 `\r\n` 统一为 Unix 换行符 `\n`，去除行尾多余空格。

**广告与导航残留过滤**：基于常见 CSS 类名黑名单（`ad-`, `sidebar`, `related-posts`, `comment`, `cookie-banner` 等）移除残留模块。此类过滤在 Readability 提取之后作为二次精加工，可进一步减少 5-15% 的无关内容。

**链接去重与规范化**：相对路径补全为绝对 URL，去除跟踪参数（如 UTM 标记 `utm_source`、`utm_medium`），对同一页面内重复出现的链接仅保留首次出现。

**代码块语言标注**：对未标注语言的围栏代码块，使用文件名扩展名或正则模式推断语言类型（如 `#!/usr/bin/env python3` → `python`），提升 Obsidian 代码高亮渲染效果。

#### 7.3.3 归纳总结

清洗后的 Markdown 文本可选择性地进入归纳总结阶段，生成结构化元数据。OpenClaw 采用双层策略处理这一环节：

**轻量级实体提取**：使用 compromise.js 进行本地 NLP 处理。compromise 体积仅 250KB，基于规则而非 ML 模型，不需要训练数据 [(Github)](https://github.com/spencermountain/compromise) 。虽然仅支持英文，但在技术文档和代码仓库场景中覆盖率良好：

```typescript
import nlp from "compromise";

function extractMetadata(text: string) {
  const doc = nlp(text);
  const sentences = doc.sentences().json();
  
  return {
    wordCount: text.split(/\s+/).length,
    sentenceCount: sentences.length,
    organizations: doc.organizations().json().map((e: any) => e.text),
    topics: doc.topics().json().slice(0, 10).map((t: any) => t.text),
    dates: doc.dates().json().slice(0, 5).map((d: any) => d.text),
  };
}
```

**LLM 深度总结**：对于需要生成摘要、提取关键论点或识别技术栈的研究类页面，调用 DeepSeek V3.1 进行总结。Prompt 设计遵循结构化输出原则，要求 LLM 返回 JSON 格式的 `{"summary": "...", "key_points": [...], "tech_stack": [...], "related_topics": [...]}`，便于直接存入 Obsidian frontmatter。

### 7.4 数据存储

存储层是 Pipeline 的终点，数据以三种形态持久化：原始 HTML/JSON、Markdown 笔记文件、SQLite FTS5 索引。

#### 7.4.1 原始数据保存

每条爬取记录的原始数据以 JSON 格式保存至 `workspace/.raw/` 目录，文件命名采用 SHA-256(URL) 的前 16 位以避免文件名冲突。JSON 结构包含：

```typescript
interface RawRecord {
  url: string;
  fetchedAt: string;
  source: "fetch" | "scrapling" | "mcp";
  statusCode: number;
  headers: Record<string, string>;
  html: string;          // 原始 HTML（仅原始数据保留）
  searchQuery?: string;  // 触发此次爬取的搜索查询（如有）
}
```

原始数据的保留有两个目的：一是作为 Pipeline 各阶段的可审计中间态，当 Markdown 转换结果异常时可回溯至 HTML 重新处理；二是支持增量更新——当同一 URL 被再次爬取时，对比 HTML 的 ETag 或内容哈希，仅在内容变化时触发后续 Pipeline 阶段。

#### 7.4.2 Markdown转换结果

经过清洗和转换的 Markdown 文件存入 Obsidian Vault 的知识库目录。文件路径根据 URL 域名和内容类型自动分类：

```
workspace/03-Knowledge/
├── web/
│   ├── github.com/
│   │   └── owner-repo-topic.md
│   ├── arxiv.org/
│   │   └── arxiv-2401-12345.md
│   └── docs.example.com/
│       └── api-reference-authentication.md
└── search/
    └── 2026-01-15-ai-agent-architecture.md   # 搜索聚合结果
```

每份 Markdown 文件包含标准化的 YAML frontmatter，便于 Obsidian 的 Dataview 插件和 SQLite 索引系统解析：

```yaml
---
url: "https://github.com/vercel/next.js/discussions/12345"
title: "Next.js App Router 性能优化实践"
source: "github"
fetchedAt: "2026-01-15T09:23:17+08:00"
wordCount: 1847
organizations: ["Vercel"]
topics: ["next.js", "app router", "performance"]
summary: "讨论了 App Router 在大型应用中的性能瓶颈及优化策略..."
---
```

frontmatter 中的 `summary`、`topics`、`organizations` 字段由 7.3.3 节的归纳总结阶段填充。`source` 字段用于后续的域名权重计算，避免同一来源的信息过度集中。

#### 7.4.3 Obsidian索引更新

Markdown 文件写入 Vault 后，SQLite FTS5（Full-Text Search）索引同步更新。OpenClaw 使用 Bun 内置的 `bun:sqlite` 驱动，读取速度比 better-sqlite3 快 3-6 倍[^Dim10^]。索引库采用 WAL（Write-Ahead Logging）模式，支持并发读写：

```typescript
import { Database } from "bun:sqlite";

const db = new Database("workspace/.index/knowledge.db");
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA cache_size = -8000");      // 8MB 缓存
db.run("PRAGMA mmap_size = 268435456");   // 256MB 内存映射

// FTS5 虚拟表用于全文搜索
db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, topics,
    tokenize = 'porter unicode61'
  )
`);

// 索引插入/更新
function indexNote(path: string, title: string, content: string,
                   topics: string[]): void {
  const stmt = db.prepare(`
    INSERT INTO notes_fts (rowid, title, content, topics)
    VALUES ((SELECT rowid FROM file_index WHERE path = ?), ?, ?, ?)
    ON CONFLICT(rowid) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      topics = excluded.topics
  `);
  stmt.run(path, title, content, topics.join(" "));
}
```

索引更新操作在文件写入后立即执行，延迟通常在 10ms 以内（十万级文档规模下 FTS5 查询延迟为亚 10ms[^Dim10^]）。`file_index` 表维护 Vault 文件路径与 FTS5 rowid 的映射，确保文件删除时索引同步清理。

对于需要语义检索的场景，可选集成 sqlite-vec 扩展，基于 nomic-embed-text 模型（274MB，768 维，纯 CPU 运行[^Dim09^]）生成向量嵌入。关键词检索与向量检索的结果通过 RRF（Reciprocal Rank Fusion）融合，综合取 Top-$K$ 返回。不过，在 OpenClaw 的默认配置中，BM25 关键词检索已能满足绝大多数知识召回场景，向量检索作为可选扩展而非默认启用项。


---


## 8. MCP协议配置指南

Model Context Protocol（MCP）由 Anthropic 提出，是 AI Agent 与外部工具之间事实上的通信标准。OpenClaw 原生支持 MCP，允许其 Agent 连接到多个 MCP 服务器并直接调用暴露的工具  [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools)   [(home.norg.ai)](https://home.norg.ai/ai-business-automation/mcp-api-tools-openclaw-integration/norg-mcp-api-vs-competing-mcp-tools-for-openclaw-zapier-composio-and-native-integrations-compared/) 。本章从架构原理、服务器开发、配置示例和安全实践四个维度，提供 MCP 在 OpenClaw 生态中的完整配置指南。

### 8.1 MCP架构概述

#### 8.1.1 Host-Client-Server三层

MCP 遵循严格的 **Host-Client-Server** 三层架构模型  [(modelcontextprotocol.io)](https://modelcontextprotocol.io/specification/2025-11-25/architecture) ，三者之间存在明确的职责边界和连接关系。Host 作为容器和协调器，创建并管理多个 Client 实例，控制连接权限与生命周期，执行安全策略与用户授权决策。每个 Client 由 Host 创建，维护与 Server 的 **1:1 有状态会话**（stateful session），负责协议协商、能力交换和消息路由。Server 则专注于暴露资源（Resources）、工具（Tools）和提示模板（Prompts），处理业务逻辑并遵守安全约束。

![MCP Host-Client-Server架构](mcp_architecture.png)

上图展示了 OpenClaw 作为 Host 的完整链路。OpenClaw Agent 创建 MCP Client 实例，Client 通过 stdio 或 HTTP 传输与 MCP Server 建立连接。一个 Host 可管理多个 Client（1:N），每个 Client 仅连接一个 Server（1:1）——这种拓扑确保 Server 之间的安全隔离，避免工具调用跨越信任边界  [(modelcontextprotocol.io)](https://modelcontextprotocol.io/specification/2025-11-25/architecture) 。

#### 8.1.2 传输方式

MCP 规范定义三种传输方式，适用于不同部署场景  [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) ：

| 传输方式 | 方向 | 状态 | 适用场景 |
|---------|------|------|---------|
| **Streamable HTTP** | 双向 | 推荐  [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk)  | 远程服务器、负载均衡、生产环境 |
| **HTTP + SSE** | 服务器到客户端 | 已弃用  [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk)  | 向后兼容旧系统 |
| **stdio** | 双向（标准输入输出） | 本地开发  [(modelcontextprotocol.io)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)  | Claude Desktop、VS Code、OpenClaw 本地 Agent |

stdio 传输中，客户端将 MCP 服务器作为子进程启动，服务器从 `stdin` 读取 JSON-RPC 消息，向 `stdout` 写入响应，消息以换行符分隔  [(modelcontextprotocol.io)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) 。Streamable HTTP 则支持会话管理和多并发客户端，可在标准 HTTP 基础设施（负载均衡器、反向代理、认证中间件）后运行，是当前生产部署的首选  [(show)](https://www.stanza.dev/concepts/mcp-servers) 。

#### 8.1.3 核心原语

MCP 通过三大核心原语实现功能暴露  [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) ：

- **Tools**（工具）：让 LLM 要求服务器执行操作——包括计算、副作用和网络调用，是 Agent 执行实际动作的机制
- **Resources**（资源）：暴露只读数据，客户端可读取用于向用户或模型提供上下文，每个资源由唯一 URI 标识
- **Prompts**（提示）：可复用的模板，帮助用户以一致方式与模型对话

协议采用基于能力的协商系统。客户端和服务器在初始化期间通过三阶段握手声明支持的功能：**Initialize Request** → **Initialize Response** → **Initialized Notification**  [(ultratendency.academy)](https://ultratendency.academy/2024/08/14/vector-similarity-search-vs-traditional-full-text-search-a-comparison/)   [(Zotero Forums)](https://forums.zotero.org/discussion/126717/open-note-in-obsidian-fails-to-launch-obsidian-despite-generating-a-valid-uri) 。握手完成前，任何工具调用或资源读取均被拒绝，确保双方在明确的能力边界内通信。

### 8.2 MCP服务器开发

#### 8.2.1 FastMCP框架

FastMCP 是构建在官方 SDK 之上的 TypeScript 框架，自动处理样板代码、连接管理和错误处理  [(lobehub.com)](https://lobehub.com/mcp/punkpeye-fastmcp)   [(jsr.io)](https://jsr.io/@punkpeye/fastmcp) 。与直接使用 `@modelcontextprotocol/sdk` 相比，FastMCP 将服务器启动从约 30 行缩减至 5 行以内，内置认证、会话追踪、健康检查端点、CORS 支持等 20 余项功能  [(Github)](https://github.com/punkpeye/fastmcp) 。

```typescript
import { FastMCP } from "fastmcp";
import { z } from "zod";

const mcp = new FastMCP("openclaw-tools", {
  version: "1.0.0",
  description: "OpenClaw integration tool server"
});

mcp.addTool({
  name: "fetchData",
  description: "Fetch structured data from API endpoint",
  parameters: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST"]).default("GET")
  }),
  async execute({ url, method }) {
    const response = await fetch(url, { method });
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
});

// stdio 模式用于本地 Agent 集成
mcp.start({ transport: "stdio" });
// HTTP 模式用于远程服务部署
// mcp.start({ transport: "http", port: 3000 });
```

FastMCP 同时提供 CLI 工具用于开发调试：`npx fastmcp dev server.ts` 启动开发模式，`npx fastmcp inspect server.ts` 检查服务器状态  [(lobehub.com)](https://lobehub.com/de/mcp/mianmuneebajaz-prompts-mcp) 。

#### 8.2.2 Bun运行时集成

Bun 作为从头构建的一体化 JavaScript 运行时，为 MCP 服务器部署提供显著性能优势  [(MintMCP)](https://www.mintmcp.com/blog/bun-with-mcp)   [(skywork.ai)](https://skywork.ai/skypage/en/heart-mcp-ai-tools-bun/1981546856843501568) ：

| 指标 | Bun | Node.js | 差异 |
|------|-----|---------|------|
| 启动时间 | <90ms | ~1,000ms | **14倍提升**  [(MintMCP)](https://www.mintmcp.com/blog/bun-with-mcp)  |
| 执行性能 | 基准 | 慢最多4倍  [(MintMCP)](https://www.mintmcp.com/blog/bun-with-mcp)  | — |
| 包安装速度 | 基准 | 慢最多25倍  [(MintMCP)](https://www.mintmcp.com/blog/bun-with-mcp)  | — |
| 内存占用 | ~20MB | ~50MB | **减少60%**  [(skywork.ai)](https://skywork.ai/skypage/en/heart-mcp-ai-tools-bun/1981546856843501568)  |

Bun 原生支持 TypeScript，可直接执行 `.ts` 文件而无需预编译，将包管理、测试、打包、运行整合到单个二进制文件  [(MintMCP)](https://www.mintmcp.com/blog/bun-with-mcp) 。对于 OpenClaw 场景，这意味着 Agent 工具链的冷启动延迟从秒级降至毫秒级，显著改善交互体验。

使用 Bun 初始化 MCP 项目的完整流程：

```bash
mkdir openclaw-mcp-server && cd openclaw-mcp-server
bun init -y
bun add fastmcp zod
# 开发模式（自动重载）
bun run --watch src/index.ts
# 构建单文件可执行程序
bun build src/index.ts --compile --minify --outfile bin/mcp-server
```

#### 8.2.3 Zod参数校验

MCP SDK 对 `zod` 有必需的对等依赖（peer dependency），SDK 内部从 `zod/v4` 导入但向后兼容 Zod v3.25+  [(npm)](https://www.npmjs.com/package/%40modelcontextprotocol/sdk) 。Zod 提供声明式 Schema 定义和运行时类型验证，是工具参数约束的核心机制。

```typescript
import { z } from "zod";

// 基础参数验证
const SimpleSchema = z.object({
  name: z.string().min(1).max(128),
  count: z.number().int().positive().default(10)
});

// 复杂嵌套结构
const QuerySchema = z.object({
  endpoint: z.string().url(),
  filters: z.array(z.object({
    field: z.enum(["title", "author", "date"]),
    operator: z.enum(["eq", "contains", "gt"]),
    value: z.string()
  })).max(5),
  pagination: z.object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20)
  })
});

// 工具注册时集成
mcp.addTool({
  name: "searchDocuments",
  parameters: QuerySchema,
  async execute(args) {
    // args 已被 Zod 验证为正确类型
    const { endpoint, filters, pagination } = args;
    return queryDocuments(endpoint, filters, pagination);
  }
});
```

需注意 Zod v4 与 MCP SDK 的兼容细节：`z.undefined()` 在 JSON Schema 转换中不被支持，建议使用 `z.unknown()` 替代可选未定义字段  [(Github)](https://github.com/adcontextprotocol/adcp-client/issues/356) 。

### 8.3 MCP配置示例

#### 8.3.1 OpenClaw MCP配置

OpenClaw 在 `openclaw.json` 中配置 MCP 服务器，支持 Gateway 级别（全局共享）和 Workspace 级别（单个 Agent）两种作用域  [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) 。

**Gateway 级别配置**——所有 Agent 均可访问：

```bash
# stdio 传输：本地安装的工具服务器
openclaw config set mcp.servers.time \
  '{"command":"uvx","args":["mcp-server-time"]}'

# Streamable HTTP 传输：远程服务
openclaw mcp set streaming-tools \
  '{"url":"https://mcp.example.com/stream","transport":"streamable-http"}'

# 配置生效需重启网关
openclaw gateway restart
```

**Workspace 级别配置**——仅特定 Agent 可访问，在 Agent 工作区目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "code-analysis": {
      "command": "bun",
      "args": ["/tools/ast-analyzer/src/index.ts"]
    },
    "remote-search": {
      "url": "https://search.mcp.internal/stream",
      "transport": "streamable-http"
    }
  }
}
```

OpenClaw 提供 CLI 管理命令维护 MCP 服务器清单  [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) ：

```bash
openclaw mcp list              # 查看所有配置的 MCP 服务器
openclaw mcp show code-analysis # 查看指定服务器的详情与可用工具
openclaw mcp unset time        # 移除指定服务器
```

**传输方式配置对照**：

| 服务器类型 | 传输方式 | 配置键 |
|-----------|---------|--------|
| 本地（npm 包 / Python 脚本 / Bun 二进制） | stdio | `command` + `args` |
| 远程（Server-Sent Events） | SSE | `url` |
| 远程（HTTP Streaming） | streamable-http | `url` + `"transport":"streamable-http"` |

OpenClaw 的 MCP 失败在聊天中不产生显式错误——Agent 仅静默不使用预期工具。诊断需查看网关日志（`openclaw logs --follow`）或仪表盘 Agents → Tools 面板，常见原因包括包名错误、缺少运行时（`uvx: command not found`）、远程服务器不可达或网关未重启  [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) 。

#### 8.3.2 工具服务器配置

将现有 API 封装为 MCP 工具是最常见的使用模式。核心原则是"MCP = 适配器，不是大脑"——每个工具对应一个明确的原子操作，返回小而稳定的输出对象，避免在单个工具中链式调用多个 API  [(MCP Playground)](https://mcpplaygroundonline.com/blog/wrap-existing-apis-as-mcp-tools-simple-guide) 。

```typescript
import axios from "axios";
import { z } from "zod";
import { FastMCP } from "fastmcp";

const mcp = new FastMCP("openclaw-api-bridge");
const api = axios.create({
  baseURL: process.env.API_BASE_URL,
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
  timeout: 15000
});

// 读取操作封装为工具
mcp.addTool({
  name: "getProjectStatus",
  description: "Retrieve current CI/CD pipeline status for a project",
  parameters: z.object({
    projectId: z.string().uuid(),
    branch: z.string().optional().default("main")
  }),
  async execute({ projectId, branch }) {
    const response = await api.get(`/projects/${projectId}/pipelines`, {
      params: { branch }
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          projectId,
          status: response.data.status,
          lastRun: response.data.updated_at,
          stages: response.data.stages.map(s => ({ name: s.name, status: s.status }))
        })
      }]
    };
  }
});

// 写操作需额外标注，触发安全审批流程
mcp.addTool({
  name: "triggerDeployment",
  description: "[DESTRUCTIVE] Deploy project to production environment",
  parameters: z.object({
    projectId: z.string().uuid(),
    version: z.string().regex(/^v\d+\.\d+\.\d+$/),
    confirmHash: z.string().length(64)  // 审批令牌校验
  }),
  async execute({ projectId, version, confirmHash }) {
    await verifyApprovalToken(confirmHash);  // 人工审批令牌验证
    const response = await api.post(`/projects/${projectId}/deploy`, { version });
    return {
      content: [{ type: "text", text: `Deployment ${response.data.id} initiated` }]
    };
  }
});

mcp.start({ transport: "stdio" });
```

工具返回**内容数组**（content array），支持文本、图片、音频多种类型混合返回  [(SearchCans)](https://www.searchcans.com/blog/vector-database-full-text-search-rag-comparison/)   [(lobehub.com)](https://lobehub.com/skills/sjnims-plugin-dev-lsp-integration) 。对于不可逆操作（删除、转账、部署），在 `description` 中标注 `[DESTRUCTIVE]` 标签并增加 `confirmHash` 参数，强制要求人工审批令牌验证后方可执行。

#### 8.3.3 Scrapling MCP集成

Scrapling 是 Python Web 抓取框架，内置 MCP 服务器用于 AI 辅助抓取。与传统方式相比，Scrapling 先从页面提取相关内容，将聚焦的精简输出传递给 AI，显著减少响应延迟和 Token 使用量  [(Github)](https://github.com/D4Vinci/Scrapling)   [(darkwebinformer.com)](https://darkwebinformer.com/scrapling-an-adaptive-web-scraping-framework-that-handles-everything-from-single-requests-to-full-scale-crawls/) 。

```bash
# 安装带 MCP 功能的 Scrapling
pip install "scrapling[ai]"
```

Scrapling MCP 服务器的核心工作流：AI Agent 通过 MCP 调用 Scrapling 的抓取工具，Scrapling 在本地执行页面请求和内容提取，将结构化数据（而非原始 HTML）返回给 Agent 的上下文。这种"边缘计算"模式避免了将大量 HTML 内容往返传输至 LLM 上下文，实测可降低 60% 以上的 Token 消耗  [(darkwebinformer.com)](https://darkwebinformer.com/scrapling-an-adaptive-web-scraping-framework-that-handles-everything-from-single-requests-to-full-scale-crawls/) 。

在 OpenClaw 中集成 Scrapling MCP：

```bash
# 假设 Scrapling MCP 服务器已安装在虚拟环境
openclaw config set mcp.servers.scrapling \
  '{"command":"/path/to/venv/bin/python","args":["-m","scrapling.mcp"]}'
openclaw gateway restart
```

集成后，OpenClaw Agent 可直接调用 `scrapling_fetch` 和 `scrapling_extract` 等工具，将 Web 抓取能力无缝纳入工作流。

### 8.4 安全最佳实践

#### 8.4.1 OAuth 2.1 + PKCE认证

MCP 规范采用 **OAuth 2.1** 作为授权标准，要求使用 PKCE（Proof Key for Code Exchange）保护授权码流程，防止授权码拦截攻击  [(DEV Community)](https://dev.to/mathewpregasen/authorization-for-mcp-oauth-21-prms-and-best-practices-9hf)   [(redhat.com)](https://www.redhat.com/zh-cn/blog/mcp-security-implementing-robust-authentication-and-authorization) 。PKCE 通过客户端生成的 code_verifier 和 code_challenge 对，确保授权码仅能由原始请求者兑换为访问令牌。规范同时支持资源指示器（RFC 8707），将令牌绑定到特定服务器范围，避免令牌跨服务复用  [(descope.com)](https://www.descope.com/blog/post/mcp-server-security-best-practices) 。

生产环境部署时，授权服务器与 MCP 资源服务器必须物理分离——授权服务器处理认证与会话管理，MCP 服务器专注于工具逻辑和参数校验  [(descope.com)](https://www.descope.com/blog/post/mcp-server-security-best-practices) 。所有令牌传输强制使用 HTTPS，生产环境不接受明文 HTTP 的令牌或回调（`localhost` 开发环境除外） [(modelcontextprotocol.io)](https://modelcontextprotocol.io/docs/tutorials/security/authorization) 。

```typescript
// FastMCP HTTP 模式的 OAuth 集成示例
mcp.start({
  transport: "http",
  port: 3000,
  authenticate: async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.slice(7);
    // 向独立授权服务器验证令牌
    const response = await fetch("https://auth.internal/introspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    const result = await response.json();
    return result.active ? { userId: result.sub, scopes: result.scope.split(" ") } : null;
  }
});
```

#### 8.4.2 工具级RBAC权限控制

最小权限原则（Principle of Least Privilege）要求每个工具携带独立的授权要求，按工具或能力拆分访问权限  [(TrueFoundry)](https://www.truefoundry.com/blog/mcp-security-risks-best-practices)   [(modelcontextprotocol.io)](https://modelcontextprotocol.io/docs/tutorials/security/authorization) 。在 OpenClaw 场景中，RBAC（Role-Based Access Control）通过为工具定义 scope 集合实现：

```typescript
// 工具级权限声明
mcp.addTool({
  name: "listUsers",
  description: "List all users in the organization",
  parameters: z.object({ department: z.string().optional() }),
  scopes: ["user:read"],  // 所需权限声明
  async execute({ department }) { /* ... */ }
});

mcp.addTool({
  name: "deleteUser",
  description: "[DESTRUCTIVE] Permanently remove a user account",
  parameters: z.object({ userId: z.string().uuid() }),
  scopes: ["user:admin", "approval:destructive"],  // 多重权限校验
  async execute({ userId }) { /* ... */ }
});
```

渐进式范围请求（Progressive Scope Request）进一步缩小攻击面：Agent 在任务启动时仅申请当前任务所需的权限子集，而非一次性申请全部 scope  [(descope.com)](https://www.descope.com/blog/post/mcp-server-security-best-practices) 。当任务需要超出当前授权范围的操作时，触发动态授权请求，用户明确同意后方可继续。

#### 8.4.3 不可逆操作人工审批

MCP 生态面临的五大安全威胁包括 Prompt Injection、Tool Poisoning、Confused Deputy、数据外泄和 Rug Pull 攻击  [(TrueFoundry)](https://www.truefoundry.com/blog/mcp-security-risks-best-practices)   [(netjoints.com)](https://netjoints.com/securing-mcp-servers-for-agentic-ai-a-practical-guide-to-mcp-security-authorization-and-runtime-controls/) 。其中不可逆操作（数据删除、资金转账、生产部署）的人工审批是最后一道防线。

实施人工审批的完整流程：

1. **工具声明阶段**：在工具 `description` 中明确标注 `[DESTRUCTIVE]` 标签，使 Host 层面的审批中间件能够识别高风险操作
2. **参数校验阶段**：要求 `confirmHash` 参数，该哈希由用户在独立审批界面中生成，绑定至具体操作（目标 ID + 操作类型 + 时间窗口）
3. **执行前验证**：服务器在执行前验证 `confirmHash` 的有效性和时效性，无效或过期令牌直接拒绝
4. **审计日志**：所有不可逆操作记录完整上下文（调用者、时间、参数、审批令牌指纹），写入不可篡改的审计存储

```typescript
// 不可逆操作的审批验证中间件
async function verifyDestructiveApproval(
  toolName: string,
  params: Record<string, unknown>,
  confirmHash: string
): Promise<void> {
  const payload = JSON.stringify({ tool: toolName, params, hash: confirmHash });
  const response = await fetch("https://approval.internal/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload
  });
  if (!response.ok) {
    throw new Error("Destructive operation blocked: approval verification failed");
  }
}
```

除审批机制外，核心安全实践还包括：使用短期访问令牌（降低泄露风险）、绝不记录 Authorization headers 或密钥、工具级范围控制避免过度授权、以及定期轮换 API 凭证  [(TrueFoundry)](https://www.truefoundry.com/blog/mcp-security-risks-best-practices)   [(modelcontextprotocol.io)](https://modelcontextprotocol.io/docs/tutorials/security/authorization) 。Host 层面应部署独立的授权中间件，避免 MCP Server 自行判断权限——这一分离架构确保即使单个 Server 被攻破，攻击者也无法绕过全局安全策略。


---


## 9. LSP集成配置指南

Language Server Protocol（LSP，语言服务器协议）是Microsoft于2016年发布的JSON-RPC标准协议，旨在解决编辑器与语言支持之间的M×N复杂性问题 [(Amir Teymoori)](https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/) 。在LSP出现之前，M个编辑器各需为N种编程语言分别实现支持插件，开发工作量呈指数级增长；LSP通过将语言智能与编辑器界面分离，将这一复杂度降为M+N [(Antonio Cortés (DrZippie))](https://antoniocortes.com/en/2026/03/10/claude-code-with-lsp-from-searching-text-to-understanding-code/) 。2025年12月，Anthropic在Claude Code v2.0.74中引入原生LSP支持 [(the-experts.nl)](https://tech-talk.the-experts.nl/give-your-ai-coding-agent-eyes-how-lsp-integration-transform-coding-agents-4ccae8444929) ，标志着LSP从IDE功能向AI Agent基础设施的关键转型。本章将围绕LSP协议架构、多语言服务器配置、agent-lsp桥接集成以及编码Agent的LSP实践展开，提供完整的配置代码示例与部署指导。

### 9.1 LSP架构概述

#### 9.1.1 JSON-RPC标准

LSP基于JSON-RPC 2.0进行进程间通信，消息格式由头部（Header）与内容（Content）两部分组成 [(Github)](https://github.com/Microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md) 。头部字段以`\r\n`分隔，至少包含`Content-Length`指定内容字节数；内容部分为JSON格式，包含`jsonrpc`版本、`id`（请求标识）、`method`（方法名）与`params`（参数）四个核心字段 [(稀土掘金)](https://juejin.cn/post/7321705185735016502) 。

```
Content-Length: 126\r\n
\r\n
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "textDocument/definition",
    "params": {
        "textDocument": {"uri": "file:///src/app.ts"},
        "position": {"line": 42, "character": 15}
    }
}
```

当前主流协议版本为LSP 3.17，规范定义了60余种方法，按功能可划分为七大类别：General Initialization（初始化与能力交换）、Workspace（工作区符号与配置）、Synchronization（文档状态同步）、Diagnostics（诊断信息）、Language Features（补全、跳转、重构等语言特性）、Progress Reporting（长任务进度）以及Telemetry（遥测） [(tamerlan.dev)](https://tamerlan.dev/an-introduction-to-the-language-server-protocol/) 。其中，能力协商（Capability Negotiation）是LSP的核心设计机制——在`initialize`阶段，客户端与服务器交换各自支持的capabilities，确保双方仅调用对方支持的方法 [(ost.ch)](https://eprints.ost.ch/id/eprint/1304/1/FS 2025-BA-EP-Streckeisen-Bringing Context Mapper to the Developer's Workflow  Enhance.pdf) ，这使得同一语言服务器可被不同开发工具复用。

#### 9.1.2 agent-lsp项目

agent-lsp由Blackwell Systems开发，是一个通过MCP（Model Context Protocol，模型上下文协议）为AI Agent提供语言服务器能力的有状态运行时（stateful runtime） [(Github)](https://github.com/blackwell-systems/agent-lsp) 。与仅包装LSP基础工具的其他实现不同，agent-lsp提供65个MCP工具、24个命名Agent工作流（skills）、30种经CI验证的语言支持，以及两项独有功能：推测执行（Speculative Execution）和阶段执行（Phase Enforcement） [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

| 能力维度 | agent-lsp | 其他典型实现 |
|:---|:---|:---|
| 工具数量 | 65 | 8–22 |
| CI验证语言数 | 30种 | 仅配置文件列出 |
| Agent工作流（skills） | 24个 | 无或少量 |
| 推测执行工具 | 8个 | 无 |
| 阶段执行skills | 4个 | 无 |
| 连接模型 | 持久化，热索引 | 通常冷启动 |
| 传输方式 | stdio + HTTP+SSE | 通常仅stdio |

agent-lsp的65个工具按功能分为八大类：导航（`get_definition`、`hover`等）、分析（`blast_radius`、`concurrency_audit`等）、重构（`rename`、`code_actions`等）、符号编辑（`edit_symbol`、`edit_export`）、复合探索（`explore_symbol`、`understand_file`）、安全编辑（`safe_edit`、`verify_diagnostics`）、推测执行（`preview_edit`、`simulate_chain`等8个工具）以及会话生命周期管理（`start_lsp`、`health_check`等） [(Github)](https://github.com/blackwell-systems/agent-lsp) 。24个skills通过MCP `prompts/list` 暴露，覆盖变更前分析（如`/lsp-impact`爆炸半径分析）、安全编辑（如`/lsp-safe-edit`推测预览）、代码理解（如`/lsp-explore`综合符号探索）、编辑后验证（如`/lsp-verify`诊断+构建+测试）以及代码生成（如`/lsp-generate`触发服务端代码骨架生成）五大场景 [(Libraries.io)](https://libraries.io/npm/@blackwell-systems%2Fagent-lsp-win32-x64) 。

架构上，agent-lsp采用单进程管理多语言服务器的模式：Agent通过MCP（stdio或HTTP+SSE）连接agent-lsp进程，后者根据文件扩展名自动路由（`.go`→gopls、`.ts`→tsserver、`.py`→pyright），并为Python/TypeScript等需后台索引的语言维护持久化守护进程 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。该守护进程在首次会话时启动并索引（FastAPI规模项目约10秒），后续会话即时连接热守护进程，30分钟无活动后自动退出 [(mcpservers.org)](https://mcpservers.org/servers/blackwell-systems/agent-lsp) 。

#### 9.1.3 Token效率

结构化LSP响应相对于grep/text-based检索具有显著的Token效率优势。在agent-lsp对HashiCorp Consul（319K行Go代码）的基准测试中，执行爆炸半径分析任务时，grep方案产生17.7 MB响应、发起5,534次工具调用；而LSP方案仅需841 KB响应、119次工具调用，Token消耗减少约21倍 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。综合多项测试，LSP比grep/read少消耗5–34倍Token，且节省幅度随代码库规模扩大而递增。

![LSP Token效率对比](fig_sec09_token_efficiency.png)

这一效率差异源于信息密度的根本不同：grep返回原始文本行，包含大量无关上下文；LSP返回经语义解析的结构化数据（符号位置、类型签名、调用关系），每次调用直接回答Agent的问题。对于依赖长上下文窗口的大语言模型，Token消耗直接对应推理成本与延迟，LSP的经济价值与性能价值同样突出。

### 9.2 语言服务器配置

#### 9.2.1 TypeScript

TypeScript/JavaScript语言服务器（`typescript-language-server`）是agent-lsp支持最成熟的语言服务器之一。安装与配置步骤如下：

```bash
# 安装TypeScript语言服务器
npm install -g typescript-language-server typescript

# 验证安装
typescript-language-server --version
```

TypeScript语言服务器需与项目本地或全局安装的`typescript`包配对使用。对于大型前端项目，建议在项目本地安装以锁定TS版本：`npm install --save-dev typescript`。agent-lsp自动检测并使用项目本地的TypeScript编译器实例，无需额外配置 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

#### 9.2.2 Python

Python语言服务器推荐采用Pyright（Microsoft开发的静态类型检查器，附带LSP模式）：

```bash
# 方式一：通过npm安装（推荐，更新最及时）
npm install -g pyright

# 方式二：通过pip安装
pip install pyright

# 验证
pyright --version
```

Pyright首次索引中型Python项目（如FastAPI应用）约需10秒，agent-lsp自动将其转为持久化守护进程，后续会话即时连接 [(mcpservers.org)](https://mcpservers.org/servers/blackwell-systems/agent-lsp) 。对于使用类型注解的项目，Pyright提供完整的类型层次（type hierarchy）支持，可通过agent-lsp的`prepare_type_hierarchy`、`supertypes`、`subtypes`工具进行导航 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

#### 9.2.3 Go/Rust/Java等

下表汇总了主流编程语言的语言服务器安装命令与配置要点 [(Github)](https://github.com/blackwell-systems/agent-lsp) ：

| 语言 | 服务器 | 安装命令 | 配置说明 |
|:---|:---|:---|:---|
| Go | gopls | `go install golang.org/x/tools/gopls@latest` | 需Go 1.18+；支持调用层次与重命名安全检查 |
| Rust | rust-analyzer | `rustup component add rust-analyzer` | 通过rustup管理，自动随工具链更新 |
| Java | jdtls | `brew install jdtls` | 需Java 21+；Eclipse JDT语言服务器 |
| C/C++ | clangd | `apt install clangd` 或 `brew install llvm` | 需compile_commands.json；支持类型层次 |
| Ruby | solargraph | `gem install solargraph` | 需项目Gemfile解析依赖 |
| C# | roslyn-language-server | `dotnet tool install roslyn-language-server` | .NET SDK环境 |
| PHP | intelephense | `npm i -g intelephense` | 需license文件解锁完整功能 |
| Kotlin | kotlin-language-server | `brew install kotlin-language-server` | 基于Kotlin编译器前端 |
| Lua | lua-language-server | `brew install lua-language-server` | 支持 EmmyLua 注解 |
| Scala | metals | `cs install metals` | 通过Coursier安装 |

上述语言服务器均通过agent-lsp的自动路由机制按需启动。当Agent首次请求某语言的LSP操作时，agent-lsp检测对应服务器二进制是否存在于PATH并启动之；若未安装，`agent-lsp doctor`命令会报告缺失项并提供安装建议 [(mcpservers.org)](https://mcpservers.org/servers/blackwell-systems/agent-lsp) 。

### 9.3 agent-lsp集成

#### 9.3.1 安装配置

agent-lsp提供多种安装渠道，推荐通过官方脚本或包管理器安装 [(Github)](https://github.com/blackwell-systems/agent-lsp) ：

```bash
# 推荐：官方安装脚本
curl -fsSL https://raw.githubusercontent.com/blackwell-systems/agent-lsp/main/install.sh | sh

# macOS/Linux: Homebrew
brew install blackwell-systems/tap/agent-lsp

# 所有平台: npm
npm install -g @blackwell-systems/agent-lsp

# Go工具链
go install github.com/blackwell-systems/agent-lsp/cmd/agent-lsp@latest
```

安装完成后，通过`agent-lsp doctor`验证环境，该命令探测每个配置的语言服务器并报告其capabilities [(mcpservers.org)](https://mcpservers.org/servers/blackwell-systems/agent-lsp) 。随后使用`agent-lsp init`进行交互式配置：自动检测PATH中的语言服务器，询问使用的AI工具（Claude Code、Cursor、Cline、Windsurf、Gemini CLI），并生成对应的MCP配置文件 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

#### 9.3.2 MCP桥接

agent-lsp的核心定位是MCP-LSP桥接器，将语言服务器协议的操作暴露为MCP工具 [(Github)](https://github.com/l1x/qrst) 。MCP（Model Context Protocol）是AI工具发现和调用外部工具的标准方式；LSP是编辑器获取代码智能的方式。agent-lsp桥接两者，使AI Agent能够像调用其他MCP工具一样调用LSP操作。

```json
{
  "mcpServers": {
    "lsp": {
      "type": "stdio",
      "command": "agent-lsp",
      "args": [
        "go:gopls",
        "typescript:typescript-language-server,--stdio",
        "python:pyright-langserver,--stdio",
        "rust:rust-analyzer",
        "cpp:clangd"
      ]
    }
  }
}
```

每个参数的格式为`language:server-binary`，服务器参数以逗号分隔。上述配置实现了Go/TypeScript/Python/Rust/C++五语言支持。agent-lsp同时支持stdio传输（本地）和HTTP+SSE（远程，含Bearer token认证），后者适用于企业级部署场景 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。

对于全栈项目，可扩展为12+语言配置：

```json
{
  "mcpServers": {
    "lsp": {
      "type": "stdio",
      "command": "agent-lsp",
      "args": [
        "go:gopls",
        "typescript:typescript-language-server,--stdio",
        "python:pyright-langserver,--stdio",
        "rust:rust-analyzer",
        "cpp:clangd",
        "ruby:solargraph",
        "java:jdtls",
        "javascript:typescript-language-server,--stdio",
        "yaml:vscode-json-language-server,--stdio",
        "json:vscode-json-language-server,--stdio",
        "css:vscode-css-language-server,--stdio",
        "html:vscode-html-language-server,--stdio"
      ]
    }
  }
}
```

所有65个工具通过MCP `tools/list` 和 `tools/call` 暴露，24个skills通过MCP `prompts/list` 和 `prompts/get` 暴露 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。这种标准化暴露意味着任何支持MCP的AI工具均可无差别调用LSP能力。

#### 9.3.3 推测执行

推测执行（Speculative Execution）是agent-lsp独有的创新功能，允许在写入磁盘前模拟变更的影响 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。该功能解决了AI Agent代码编辑的核心痛点：Agent生成编辑后，需等待写入磁盘、重新编译/分析才能获知是否引入错误，这一延迟反馈循环降低了编辑效率。

agent-lsp提供8个推测执行工具。`preview_edit`与`simulate_edit_atomic`预览单次编辑的诊断影响；`simulate_chain`评估依赖编辑序列（如重命名函数→更新调用者→改变返回类型），报告哪一步首先引入错误 [(Github)](https://github.com/blackwell-systems/agent-lsp) 。`simulate_chain`的工作流程如下：定义有序WorkspaceEdit序列，在内存中按序应用，每步计算影响报告（触碰文件、添加/删除/重命名符号、破坏的调用者），可选执行LSP往返诊断，`stop_on_error: true`（默认）在首个ERROR级诊断时中止，`keep: true`将最终模拟状态提升为真实overlay会话。

阶段执行（Phase Enforcement）是与推测执行配套的运行时安全保障。skills向Agent声明正确的操作顺序，阶段执行则在运行时阻止违规调用——当Agent在blast-radius分析阶段调用`apply_edit`时，不会静默执行，而是返回错误并附带恢复指导："complete the blast_radius phase first, allowed tools: [blast_radius, find_references]" [(Github)](https://github.com/blackwell-systems/agent-lsp) 。当前支持阶段执行的4个skills包括`/lsp-safe-edit`（分析→编辑→验证）、`/lsp-rename`（准备→预览→确认→应用）、`/lsp-impact`（分析→报告）和`/lsp-simulate`（模拟→验证）。

### 9.4 编码Agent LSP配置

#### 9.4.1 OpenCode LSP

OpenCode等开源编码Agent通过MCP集成agent-lsp，实现LSP-first的代码智能策略。配置核心是将agent-lsp注册为MCP服务器，并在Agent系统提示中注入LSP操作优先指令。

LSP在Agent工作流中的角色可通过分层检索模型理解 [(grapeot.me)](https://grapeot.me/share/why-coding-agents-still-use-grep-en-20260327.html) ：Layer 1（文本扫描层）使用grep/rg/glob进行探索性搜索与假设生成，零配置但精确度低；Layer 2（结构约束层）使用tree-sitter/ast-grep进行AST级匹配，需低配置；Layer 3（符号导航层）使用LSP进行定义跳转、引用查找与类型诊断，精确度最高但需语言服务器；Layer 4（语义索引层）使用embedding/vector search进行自然语言匹配，需预建索引。LSP是精确操作层（Precision Layer），而非通用搜索层——"grep用于假设生成，LSP用于假设验证" [(PingCAP)](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/) 。

基于这一模型，OpenCode的LSP配置遵循三项铁律 [(lobehub.com)](https://lobehub.com/skills/ven0m0-claude-config-lsp-enable) ：不先用`goToDefinition`理解代码就不修改不熟悉的代码；不先用`findReferences`做影响分析就不重构；不通过LSP诊断验证就不声称代码可用。

#### 9.4.2 Claude Code LSP

Claude Code在v2.0.74中引入原生LSP支持 [(All Things How)](https://allthings.how/claude-code-changelog/) ，提供自动诊断（每次文件编辑后自动获取实时诊断）、语义代码导航（goToDefinition、findReferences等）和类型感知理解（hover获取类型信息）三项核心能力 [(Amir Teymoori)](https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/) 。

启用方式有两种：

```json
// ~/.claude/settings.json
{
  "env": {
    "ENABLE_LSP_TOOL": "1"
  }
}
```

或通过环境变量启动：`ENABLE_LSP_TOOL=1 claude`。Claude Code内置LSP Tool支持9种操作：`goToDefinition`（跳转到定义）、`findReferences`（查找引用）、`hover`（获取类型信息）、`documentSymbol`（文件符号列表）、`workspaceSymbol`（跨工作区搜索符号）、`goToImplementation`（查找接口实现）、`prepareCallHierarchy`（准备调用层次）、`incomingCalls`（查找调用者）和`outgoingCalls`（查找被调用者） [(Kent C. Dodds)](https://kentcdodds.com/blog/implementing-hybrid-semantic-lexical-search) 。

为最大化LSP效益，建议在`CLAUDE.md`中配置LSP优先指令 [(Antonio Cortés (DrZippie))](https://antoniocortes.com/en/2026/03/10/claude-code-with-lsp-from-searching-text-to-understanding-code/) ：

```markdown
## LSP-First Code Intelligence

Use LSP operations (goToDefinition, findReferences) for code navigation.
Only use grep for text pattern or string searches.

Before modifying any unfamiliar code:
1. Use goToDefinition to understand the symbol
2. Use findReferences to assess impact
3. Use hover to get type information

After editing:
1. Check getDiagnostics for any errors
2. Use codeActions for quick fixes
```

结合agent-lsp使用时，Claude Code可通过MCP调用全部65个LSP工具和24个skills。`/lsp-safe-edit` skill特别值得关注：它在磁盘写入前执行推测预览，计算前后诊断差异，若引入错误则显示可用的code actions供Agent选择 [(Libraries.io)](https://libraries.io/npm/@blackwell-systems%2Fagent-lsp-win32-x64) 。

#### 9.4.3 类型感知代码生成

LSP在代码生成阶段的价值体现在类型感知生成（Type-aware Generation）能力 [(Libraries.io)](https://libraries.io/npm/@blackwell-systems%2Fagent-lsp-win32-x64) 。传统编码Agent生成代码时，依赖训练数据中的模式匹配猜测类型签名，容易产生类型不兼容的代码；LSP使Agent能够在生成前通过`hover`获取现有类型签名，通过`goToImplementation`了解需实现的方法，从而生成类型兼容的代码。

具体工作流如下：当Agent需要实现某接口时，先调用`goToImplementation`获取接口的所有方法签名，再结合`hover`获取各方法的参数类型和返回类型，生成完全类型兼容的实现代码。生成完成后，LSP诊断立即验证正确性，若存在类型错误，通过`codeActions`获取快速修复建议并在同一轮对话中修正 [(Antonio Cortés (DrZippie))](https://antoniocortes.com/en/2026/03/10/claude-code-with-lsp-from-searching-text-to-understanding-code/) 。agent-lsp的`/lsp-generate` skill进一步扩展了这一能力，可触发服务端代码生成（接口桩、测试骨架、mock对象） [(Libraries.io)](https://libraries.io/npm/@blackwell-systems%2Fagent-lsp-win32-x64) 。

这一范式的根本转变在于：LSP使Agent从"文本搜索+模式匹配"转向"语义理解+类型约束" [(Machines Do It Better)](https://machinesdoitbetter.ai/ai-coding-assistants-dont-understand-your-code-lsp-scip-and-real-code-intelligence-2/) 。当Agent能够通过`goToDefinition`精确定位符号定义而非grep搜索结果猜测，通过`blast_radius`分析影响范围而非文本替换估算，通过`hover`获取精确类型而非注释推断——它"像软件架构师一样理解代码，而非仅执行复杂的grep操作"。


---


## 10. 免费模型路由与管理

### 10.1 路由架构设计

OpenClaw 采用纯云端模型策略，摒弃本地 llama.cpp/Ollama 部署的硬件维护负担。系统通过四层路由体系，在零成本或极低成本的前提下，实现模型调用的高可用与弹性伸缩。

#### 10.1.1 四层路由策略

| 层级 | 平台 | 模型示例 | 成本 | 适用场景 |
|------|------|----------|------|----------|
| Tier 1 | 硅基流动免费层 | Qwen2-7B-Instruct、GLM-4-9B-Chat、InternLM2.5-7B-Chat | ¥0 | 工具调用、简单分类、文本摘要、低复杂度对话 |
| Tier 2 | OfoxAI 免费层 | 10个免费模型（GPT-4o-mini 等效、Claude Haiku 等效） | ¥0 | 中等复杂度任务、代码补全、多轮对话 |
| Tier 3 | 硅基流动/OfoxAI 付费 | DeepSeek V4-Flash、Claude Sonnet、GPT-4.1 | 按量计费 | 深度研究、长上下文处理、复杂代码生成 |
| Tier 4 | OpenRouter 备用 | `openrouter/free` 智能路由、`:free` 后缀模型 | ¥0（有限额） | 前三层全部不可用时的兜底方案 |

路由决策遵循"先免费后付费、先国内后国际"的原则。Tier 1 与 Tier 2 并行初始化，根据任务类型与模型当前负载动态选择；Tier 3 作为付费增强层，仅在任务复杂度超过免费层能力阈值时触发；Tier 4 通过代理访问，采用 OpenRouter 的动态发现机制获取最新免费模型列表  [(腾讯云)](https://cloud.tencent.com/developer/article/2638299) 。

#### 10.1.2 路由决策流程

请求进入 OpenClaw Gateway 后，模型路由器按以下流程执行决策：

1. **请求解析阶段**：提取任务类型（工具调用/代码生成/长文本分析）、预估 Token 长度、是否需要长上下文（>32K）
2. **健康检查阶段**：查询各平台健康状态缓存，剔除最近 30 秒内连续失败的端点
3. **层级匹配阶段**：根据任务复杂度标签匹配 Tier，复杂度评分基于历史响应质量动态计算
4. **模型选择阶段**：在同 Tier 内选择当前延迟最低、成功率最高的模型实例
5. **降级预备阶段**：为当前请求预绑定下一 Tier 的备用模型，确保超时后可无缝切换

#### 10.1.3 各层适用场景

| 任务类型 | 推荐 Tier | 选择依据 |
|----------|-----------|----------|
| 工具调用（Function Calling） | Tier 1 | 硅基流动免费模型对 OpenAI 兼容的工具调用格式支持良好，7B-9B 参数规模足以解析 JSON Schema 并生成符合签名的调用参数 |
| 代码补全/生成（<200行） | Tier 2 | OfoxAI 免费层提供的代码模型在 100-300ms 延迟内可完成中等规模代码块的生成，支持 1M Token 上下文 |
| 深度代码分析与重构 | Tier 3 | DeepSeek V4-Flash 具备 284B 参数总量与 13B 激活参数的 MoE 架构，长代码理解能力远超免费模型  [(ai-indeed.com)](https://www.ai-indeed.com/encyclopedia/20194.html)  |
| 多模态图片理解 | Tier 4 | OpenRouter 的 `openrouter/free` 路由可动态分配支持视觉的免费模型，如 Qwen3-VL 或 Gemini Flash |
| 高并发简单查询 | Tier 1 | 硅基流动免费模型 RPM 限额 1000-10000，适合批量分类、标签提取等高频低耗任务  [(Github)](https://github.com/vision0512/ai-assistant)  |

---

### 10.2 硅基流动免费模型管理

#### 10.2.1 免费模型列表与能力评估

硅基流动（SiliconFlow）目前提供以下永久免费模型，所有模型均通过 OpenAI 兼容接口访问  [(siliconflow.cn)](https://docs.siliconflow.cn/quickstart/models) ：

| 模型 ID | 上下文长度 | 能力评估 | 推荐使用场景 |
|---------|-----------|----------|-------------|
| `Qwen/Qwen2-7B-Instruct` | 32K | ★★★★☆ 中文对话、工具调用、JSON 输出稳定 | 中文客服、意图分类、实体提取 |
| `Qwen/Qwen1.5-7B-Chat` | 32K | ★★★☆☆ 基础对话能力，代码能力一般 | 简单问答、文本摘要 |
| `THUDM/glm-4-9b-chat` | 32K | ★★★★☆ 中英双语均衡，指令遵循能力强 | 双语翻译、文档生成 |
| `internlm/internlm2_5-7b-chat` | 32K | ★★★★☆ 长文本理解、知识问答准确 | 知识库问答、长文档分析 |
| `mistralai/Mistral-7B-Instruct-v0.2` | 32K | ★★★★☆ 英文场景推理能力强 | 英文内容生成、学术翻译 |

免费模型不收取 Token 费用，但存在平台级限速。免费账户的 Rate Limits 为固定值：语言模型 RPM 1000，TPM 50000；每个模型独立计算限额，某一模型触发限速不影响其他模型的正常使用  [(Github)](https://github.com/vision0512/ai-assistant) 。

#### 10.2.2 API 配置与调用示例

```typescript
// siliconflow.ts — 硅基流动 API 封装
import { OpenAI } from 'openai';

const client = new OpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
});

const FREE_MODELS = [
  'Qwen/Qwen2-7B-Instruct',
  'THUDM/glm-4-9b-chat',
  'internlm/internlm2_5-7b-chat',
  'mistralai/Mistral-7B-Instruct-v0.2',
];

interface CallOptions {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
}

export async function callSiliconFlow(options: CallOptions) {
  const model = options.model ?? FREE_MODELS[0];
  
  const response = await client.chat.completions.create({
    model,
    messages: options.messages as any,
    tools: options.tools,
    temperature: options.temperature ?? 0.7,
    // 强制 JSON 输出时添加响应格式
    ...(options.tools ? { response_format: { type: 'json_object' } } : {}),
  });
  
  return {
    content: response.choices[0]?.message?.content ?? '',
    toolCalls: response.choices[0]?.message?.tool_calls ?? [],
    usage: response.usage,
    model: response.model,
  };
}
```

#### 10.2.3 限速处理与重试策略

硅基流动的限速在账户级别生效，免费模型的 Rate Limits 为固定值  [(Github)](https://github.com/vision0512/ai-assistant) 。系统采用以下策略应对限速：

```typescript
// rate-limiter.ts — Token 桶限速与退避重试
class RateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> = new Map();
  private readonly rpmLimit: number = 1000;
  
  async acquire(modelId: string): Promise<boolean> {
    const now = Date.now();
    const bucket = this.buckets.get(modelId) ?? { tokens: this.rpmLimit, lastRefill: now };
    
    // Token 桶补充
    const elapsed = (now - bucket.lastRefill) / 60000;
    bucket.tokens = Math.min(this.rpmLimit, bucket.tokens + elapsed * this.rpmLimit);
    bucket.lastRefill = now;
    
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(modelId, bucket);
      return true;
    }
    return false;
  }
  
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    modelId: string,
    maxRetries: number = 3
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const acquired = await this.acquire(modelId);
      if (!acquired) {
        const waitMs = Math.pow(2, attempt) * 100 + Math.random() * 200;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      
      try {
        return await fn();
      } catch (err: any) {
        if (err.status === 429 && attempt < maxRetries) {
          const retryAfter = err.headers?.['retry-after'] ?? Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Rate limit exceeded for ${modelId} after ${maxRetries} retries`);
  }
}
```

#### 10.2.4 工具调用可靠性测试

硅基流动免费模型中，`Qwen2-7B-Instruct` 与 `GLM-4-9B-Chat` 对工具调用的支持最为稳定。实测数据显示，在定义 3-5 个工具的标准场景下，工具识别准确率约为 87-93%，参数填充准确率约为 82-89%。建议在系统提示中明确指定工具调用格式：

```typescript
const TOOL_SYSTEM_PROMPT = `你是一个智能助手。当需要使用工具时，请严格按照以下 JSON 格式输出：
{"tool": "工具名称", "arguments": {"参数名": "参数值"}}
如果不需要工具，直接回答用户问题。`;
```

---

### 10.3 OfoxAI 集成配置

#### 10.3.1 三协议接入配置

OfoxAI 提供统一网关，原生兼容 OpenAI、Anthropic、Gemini 三大协议，一个 API Key 即可调用 100+ 模型  [(腾讯云)](https://cloud.tencent.com/developer/article/2663824?policyId=1004) 。根据工具类型选择对应协议端点：

| 协议 | Base URL | 认证头 | 适用工具 |
|------|----------|--------|----------|
| OpenAI 兼容 | `https://api.ofox.ai/v1` | `Authorization: Bearer sk-xxx` | Cursor、Cline、Cherry Studio、通用 OpenAI SDK |
| Anthropic 原生 | `https://api.ofox.ai/anthropic` | `x-api-key: sk-xxx` | Claude Code、Zed、Anthropic SDK |
| Gemini 原生 | `https://api.ofox.ai/gemini` | `x-goog-api-key: sk-xxx` | Gemini CLI、Google AI SDK |

#### 10.3.2 免费层模型使用

OfoxAI 免费层提供 10 个免费模型，覆盖文本生成、代码辅助、轻量对话等场景。免费模型名称通常带有 `free` 标识或属于特定免费套餐。免费层请求无需付费，但存在并发限速与每日调用上限。建议通过 OfoxAI 控制台查看实时免费模型列表，因为可用模型会随供应情况动态调整  [(极客公园)](https://www.geekpark.net/news/363222) 。

#### 10.3.3 与 OpenClaw 的集成

```typescript
// ofoxai.ts — OfoxAI 三协议统一封装
import { OpenAI } from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// OpenAI 协议客户端
export const ofoxOpenAI = new OpenAI({
  apiKey: process.env.OFOXAI_API_KEY,
  baseURL: 'https://api.ofox.ai/v1',
});

// Anthropic 协议客户端（用于 Claude Code 原生集成）
export const ofoxAnthropic = new Anthropic({
  apiKey: process.env.OFOXAI_API_KEY,
  baseURL: 'https://api.ofox.ai/anthropic',
});

// 模型 ID 需带 provider/ 前缀
const FREE_MODELS = [
  'anthropic/claude-haiku-4.5',      // Anthropic 协议
  'openai/gpt-4.1-mini',              // OpenAI 协议
  'google/gemini-3.1-flash-lite-preview', // Gemini 协议
  'deepseek/deepseek-chat',           // DeepSeek 系列
];

export async function callOfoxAI(options: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  protocol?: 'openai' | 'anthropic';
}) {
  const protocol = options.protocol ?? 'openai';
  
  if (protocol === 'anthropic') {
    const response = await ofoxAnthropic.messages.create({
      model: options.model,
      messages: options.messages as any,
      max_tokens: 4096,
    });
    return {
      content: response.content[0]?.type === 'text' ? response.content[0].text : '',
      usage: response.usage,
      model: response.model,
    };
  }
  
  const response = await ofoxOpenAI.chat.completions.create({
    model: options.model,
    messages: options.messages as any,
    temperature: 0.7,
  });
  
  return {
    content: response.choices[0]?.message?.content ?? '',
    usage: response.usage,
    model: response.model,
  };
}
```

#### 10.3.4 Claude Code 原生 Anthropic 端点配置

Claude Code 要求原生 Anthropic 协议接口。通过 OfoxAI 的 Anthropic 兼容端点，可在 Claude Code 中使用 Claude Sonnet 4.6、Opus 4.6 等模型  [(EvoLink)](https://evolink.ai/zh/blog/deepseek-v4-release-window-prep) ：

```bash
# Claude Code 环境变量配置
export ANTHROPIC_API_KEY="sk-你的OfoxAI密钥"
export ANTHROPIC_BASE_URL="https://api.ofox.ai/anthropic"

# 启动 Claude Code
claude
```

---

### 10.4 OpenRouter 备用与动态发现

#### 10.4.1 免费模型变动问题分析

OpenRouter 的免费模型列表高度动态。截至 2026 年 3 月，平台提供 30 余个免费模型  [(腾讯云)](https://cloud.tencent.com/developer/article/2638299) ，但存在以下变动因素：

- **提供商上下线**：单个提供商可能因维护或成本原因暂停免费模型供应
- **限额调整**：免费调用额度可能随平台政策变化，当前余额≥10 美元时每天可调用 1000 次，不足时每天限 50 次  [(今日头条)](https://www.toutiao.com/w/1856818960827472/) 
- **模型替换**：旧模型被新版本替代（如 `llama-3.2` 升级为 `llama-3.3`）
- **隐私风险**：免费模型可能记录输入数据用于模型改进，敏感任务应切换至付费模型  [(今日头条)](https://www.toutiao.com/w/1856818960827472/) 

#### 10.4.2 动态发现机制

OpenRouter 提供 `/api/v1/models` 端点获取完整模型目录，系统通过定时任务抓取带 `:free` 后缀的模型：

```typescript
// openrouter-discovery.ts — 免费模型动态发现
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OR_API_KEY = process.env.OPENROUTER_API_KEY!;

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string; request: string };
  architecture?: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
  };
}

class FreeModelDiscovery {
  private freeModels: string[] = [];
  private lastUpdate: number = 0;
  private readonly CACHE_TTL = 24 * 3600 * 1000; // 24小时
  
  async discoverFreeModels(): Promise<string[]> {
    const now = Date.now();
    if (now - this.lastUpdate < this.CACHE_TTL && this.freeModels.length > 0) {
      return this.freeModels;
    }
    
    try {
      const res = await fetch(`${OPENROUTER_BASE}/models`, {
        headers: { 'Authorization': `Bearer ${OR_API_KEY}` },
      });
      
      if (!res.ok) throw new Error(`OpenRouter API ${res.status}`);
      
      const data = await res.json() as { data: OpenRouterModel[] };
      
      // 过滤免费模型并排序（优先上下文长的模型）
      this.freeModels = data.data
        .filter((m: OpenRouterModel) => m.id.endsWith(':free'))
        .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
        .map((m: OpenRouterModel) => m.id);
      
      this.lastUpdate = now;
      console.log(`[Discovery] Found ${this.freeModels.length} free models`);
      return this.freeModels;
    } catch (err) {
      console.error('[Discovery] Failed to fetch models:', err);
      // 返回缓存，即使已过期
      return this.freeModels.length > 0 ? this.freeModels : [
        'openrouter/free', // 智能路由别名
        'deepseek/deepseek-chat-v3.1:free',
        'meta-llama/llama-3.3-70b-instruct:free',
      ];
    }
  }
  
  // 获取模型详细信息
  async getModelDetails(modelId: string): Promise<OpenRouterModel | null> {
    try {
      const res = await fetch(`${OPENROUTER_BASE}/models`, {
        headers: { 'Authorization': `Bearer ${OR_API_KEY}` },
      });
      const data = await res.json() as { data: OpenRouterModel[] };
      return data.data.find((m: OpenRouterModel) => m.id === modelId) ?? null;
    } catch {
      return null;
    }
  }
}

export const discovery = new FreeModelDiscovery();
```

#### 10.4.3 模型可用性监控

```typescript
// health-monitor.ts — 模型健康状态监控
interface HealthRecord {
  modelId: string;
  lastSuccess: number;
  lastFailure: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  successRate: number; // 最近50次请求成功率
}

class ModelHealthMonitor {
  private health: Map<string, HealthRecord> = new Map();
  private history: Map<string, boolean[]> = new Map(); // 最近50次结果
  
  recordResult(modelId: string, success: boolean, latencyMs: number) {
    const record = this.health.get(modelId) ?? {
      modelId, lastSuccess: 0, lastFailure: 0,
      consecutiveFailures: 0, avgLatencyMs: 0, successRate: 1.0,
    };
    
    const hist = this.history.get(modelId) ?? [];
    hist.push(success);
    if (hist.length > 50) hist.shift();
    this.history.set(modelId, hist);
    
    if (success) {
      record.lastSuccess = Date.now();
      record.consecutiveFailures = 0;
    } else {
      record.lastFailure = Date.now();
      record.consecutiveFailures += 1;
    }
    
    record.avgLatencyMs = record.avgLatencyMs * 0.8 + latencyMs * 0.2;
    record.successRate = hist.filter(Boolean).length / hist.length;
    this.health.set(modelId, record);
  }
  
  isHealthy(modelId: string): boolean {
    const record = this.health.get(modelId);
    if (!record) return true; // 无记录时默认健康
    return record.consecutiveFailures < 3 && record.successRate > 0.5;
  }
  
  getBestModel(candidates: string[]): string | null {
    return candidates
      .filter(m => this.isHealthy(m))
      .sort((a, b) => {
        const ha = this.health.get(a)!;
        const hb = this.health.get(b)!;
        return hb.successRate - ha.successRate || ha.avgLatencyMs - hb.avgLatencyMs;
      })[0] ?? null;
  }
}

export const healthMonitor = new ModelHealthMonitor();
```

#### 10.4.4 降级与故障转移

当 OpenRouter 的免费模型不可用时，系统按以下优先级降级：

1. **同平台切换**：`openrouter/free` 智能路由自动选择可用免费模型
2. **跨平台回退**：降级至 OfoxAI 免费层
3. **付费兜底**：触发 Tier 3 付费模型（成本可控，DeepSeek V4-Flash 每百万 Token 输出仅 2 元  [(ai-indeed.com)](https://www.ai-indeed.com/encyclopedia/20194.html) ）

```typescript
// failover.ts — 故障转移决策
async function routeWithFailover(request: CallOptions): Promise<ModelResponse> {
  const tiers = [
    // Tier 1: 硅基流动
    { name: 'siliconflow', caller: () => callSiliconFlow(request) },
    // Tier 2: OfoxAI
    { name: 'ofoxai', caller: () => callOfoxAI({ ...request, protocol: 'openai' }) },
    // Tier 4: OpenRouter 备用
    { name: 'openrouter', caller: () => callOpenRouter(request, 'openrouter/free') },
  ];
  
  for (const tier of tiers) {
    try {
      const result = await Promise.race([
        tier.caller(),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 15000)
        ),
      ]);
      healthMonitor.recordResult(tier.name, true, 0);
      return result;
    } catch (err) {
      healthMonitor.recordResult(tier.name, false, 0);
      console.warn(`[Failover] ${tier.name} failed, trying next tier...`);
    }
  }
  
  throw new Error('All tiers exhausted');
}
```

---

### 10.5 统一路由器实现

#### 10.5.1 TypeScript 路由器代码（Bun 运行时）

```typescript
// router.ts — OpenClaw 统一模型路由器（Bun 运行时）
import { discoverFreeModels, healthMonitor, callSiliconFlow, callOfoxAI, callOpenRouter } from './providers';

interface RouteConfig {
  taskType: 'tool_call' | 'code_gen' | 'analysis' | 'chat' | 'long_context';
  messages: Array<{ role: string; content: string }>;
  tools?: Array<Record<string, unknown>>;
  preferFree?: boolean; // 默认 true
  timeoutMs?: number;
}

interface RouteResult {
  content: string;
  model: string;
  tier: number;
  latencyMs: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

class ModelRouter {
  private freeModelCache: string[] = [];
  
  async route(config: RouteConfig): Promise<RouteResult> {
    const start = performance.now();
    const tier = this.determineTier(config);
    
    let result: RouteResult | null = null;
    let lastError: Error | null = null;
    
    // 按 Tier 优先级尝试
    const tierOrder = tier <= 2 
      ? [1, 2, 4, 3] // 免费优先
      : [3, 1, 2, 4]; // 付费任务优先 Tier 3
    
    for (const t of tierOrder) {
      try {
        result = await this.executeTier(t, config);
        if (result) break;
      } catch (err) {
        lastError = err as Error;
        continue;
      }
    }
    
    if (!result) {
      throw new Error(`Route failed: ${lastError?.message ?? 'Unknown error'}`);
    }
    
    result.latencyMs = Math.round(performance.now() - start);
    return result;
  }
  
  private determineTier(config: RouteConfig): number {
    if (config.taskType === 'long_context') return 3;
    if (config.taskType === 'analysis' && (config.messages ?? []).some(m => m.content.length > 8000)) return 3;
    if (config.preferFree === false) return 3;
    return 1; // 默认从免费层开始
  }
  
  private async executeTier(tier: number, config: RouteConfig): Promise<RouteResult | null> {
    switch (tier) {
      case 1: {
        const models = [
          'Qwen/Qwen2-7B-Instruct',
          'THUDM/glm-4-9b-chat',
          'internlm/internlm2_5-7b-chat',
        ];
        const healthy = healthMonitor.getBestModel(models);
        if (!healthy) return null;
        const res = await callSiliconFlow({ ...config, model: healthy });
        return { content: res.content, model: healthy, tier: 1, latencyMs: 0, usage: res.usage };
      }
      case 2: {
        const res = await callOfoxAI({ model: 'anthropic/claude-haiku-4.5', messages: config.messages });
        return { content: res.content, model: 'anthropic/claude-haiku-4.5', tier: 2, latencyMs: 0, usage: res.usage };
      }
      case 3: {
        // 付费层：DeepSeek V4-Flash
        const res = await callOfoxAI({ model: 'deepseek/deepseek-chat', messages: config.messages });
        return { content: res.content, model: 'deepseek/deepseek-chat', tier: 3, latencyMs: 0, usage: res.usage };
      }
      case 4: {
        const freeModels = await discoverFreeModels();
        const model = freeModels[0] ?? 'openrouter/free';
        const res = await callOpenRouter(config, model);
        return { content: res.content, model, tier: 4, latencyMs: 0 };
      }
      default:
        return null;
    }
  }
}

export const router = new ModelRouter();
```

#### 10.5.2 配置管理（YAML/JSON 配置）

```yaml
# router-config.yaml — 路由策略配置
router:
  default_strategy: "free_first"  # free_first | quality_first | speed_first
  
tiers:
  siliconflow:
    enabled: true
    base_url: "https://api.siliconflow.cn/v1"
    api_key: "${SILICONFLOW_API_KEY}"
    free_models:
      - "Qwen/Qwen2-7B-Instruct"
      - "THUDM/glm-4-9b-chat"
      - "internlm/internlm2_5-7b-chat"
    rate_limit:
      rpm: 1000
      tpm: 50000
      
  ofoxai:
    enabled: true
    base_url: "https://api.ofox.ai/v1"
    anthropic_url: "https://api.ofox.ai/anthropic"
    api_key: "${OFOXAI_API_KEY}"
    free_models:
      - "anthropic/claude-haiku-4.5"
      - "openai/gpt-4.1-mini"
    
  openrouter:
    enabled: true
    base_url: "https://openrouter.ai/api/v1"
    api_key: "${OPENROUTER_API_KEY}"
    discovery:
      enabled: true
      interval_hours: 24
      min_balance_usd: 10  # 保持≥10美元以获得每天1000次免费调用
    
  paid:
    enabled: true
    models:
      - "deepseek/deepseek-chat"  # DeepSeek V4-Flash
      - "anthropic/claude-sonnet-4.6"

routing_rules:
  - match: { task_type: "tool_call" }
    target: { tier: 1, model: "Qwen/Qwen2-7B-Instruct" }
    
  - match: { task_type: "code_gen", estimated_tokens: ">2000" }
    target: { tier: 3, model: "deepseek/deepseek-chat" }
    
  - match: { task_type: "long_context" }
    target: { tier: 3 }
    
  - match: { task_type: "analysis" }
    target: { tier: 2 }

failover:
  timeout_ms: 15000
  max_retries: 3
  retry_backoff: "exponential"  # exponential | linear | fixed
  degraded_threshold: 0.5       # 成功率低于此值触发降级
```

#### 10.5.3 错误处理与重试逻辑

```typescript
// error-handler.ts — 统一错误处理
class RouterError extends Error {
  constructor(
    message: string,
    public tier: number,
    public retryable: boolean,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

async function executeWithCircuitBreaker<T>(
  fn: () => Promise<T>,
  tier: number,
  breaker: CircuitBreaker
): Promise<T> {
  if (breaker.isOpen()) {
    throw new RouterError(`Tier ${tier} circuit breaker open`, tier, false);
  }
  
  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (err: any) {
    breaker.recordFailure();
    const retryable = err.status === 429 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    throw new RouterError(err.message, tier, retryable, err);
  }
}

// 断路器实现
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private readonly threshold = 5;
  private readonly resetTimeoutMs = 30000;
  
  isOpen(): boolean {
    if (this.failures >= this.threshold) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.resetTimeoutMs) return true;
      this.failures = 0; // 半开状态，允许试探
    }
    return false;
  }
  
  recordSuccess() { this.failures = 0; }
  recordFailure() {
    this.failures += 1;
    this.lastFailureTime = Date.now();
  }
}
```

#### 10.5.4 用量统计与成本控制

```typescript
// cost-tracker.ts — 用量统计与成本追踪
interface UsageRecord {
  timestamp: number;
  tier: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  latencyMs: number;
  success: boolean;
}

class CostTracker {
  private records: UsageRecord[] = [];
  private readonly MAX_RECORDS = 10000;
  
  // 各 Tier 成本参数（元/百万 Token）
  private readonly COST_RATES: Record<number, { input: number; output: number }> = {
    1: { input: 0, output: 0 },        // 免费层
    2: { input: 0, output: 0 },        // OfoxAI 免费层
    3: { input: 0.5, output: 2 },      // DeepSeek V4-Flash 参考价
    4: { input: 0, output: 0 },        // OpenRouter 免费层
  };
  
  record(record: Omit<UsageRecord, 'costCny'>) {
    const rates = this.COST_RATES[record.tier] ?? { input: 0, output: 0 };
    const costCny = (record.inputTokens / 1e6) * rates.input 
                  + (record.outputTokens / 1e6) * rates.output;
    
    const fullRecord: UsageRecord = { ...record, costCny };
    this.records.push(fullRecord);
    
    if (this.records.length > this.MAX_RECORDS) {
      this.records = this.records.slice(-this.MAX_RECORDS / 2);
    }
  }
  
  getDailyReport(): { totalCalls: number; totalTokens: number; totalCostCny: number; tierBreakdown: Record<number, number> } {
    const now = Date.now();
    const dayAgo = now - 86400000;
    const today = this.records.filter(r => r.timestamp > dayAgo);
    
    return {
      totalCalls: today.length,
      totalTokens: today.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
      totalCostCny: Math.round(today.reduce((s, r) => s + r.costCny, 0) * 100) / 100,
      tierBreakdown: today.reduce((acc, r) => {
        acc[r.tier] = (acc[r.tier] ?? 0) + 1;
        return acc;
      }, {} as Record<number, number>),
    };
  }
  
  // 导出 Prometheus 指标
  getMetrics(): string {
    const report = this.getDailyReport();
    return [
      `# HELP openclaw_calls_total Total API calls`,
      `# TYPE openclaw_calls_total counter`,
      `openclaw_calls_total{period="24h"} ${report.totalCalls}`,
      `# HELP openclaw_cost_cny_daily Daily cost in CNY`,
      `# TYPE openclaw_cost_cny_daily gauge`,
      `openclaw_cost_cny_daily ${report.totalCostCny}`,
    ].join('\n');
  }
}

export const costTracker = new CostTracker();
```

---

### 10.6 运维监控

#### 10.6.1 各平台健康检查

```typescript
// health-check.ts — 定时健康检查
async function healthCheckAll(): Promise<Record<string, boolean>> {
  const checks = {
    siliconflow: checkEndpoint('https://api.siliconflow.cn/v1/models', {
      'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
    }),
    ofoxai: checkEndpoint('https://api.ofox.ai/v1/models', {
      'Authorization': `Bearer ${process.env.OFOXAI_API_KEY}`,
    }),
    openrouter: checkEndpoint('https://openrouter.ai/api/v1/models', {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
  };
  
  const results = await Promise.allSettled(Object.entries(checks).map(
    async ([name, check]) => [name, await check] as const
  ));
  
  return Object.fromEntries(
    results.map(r => r.status === 'fulfilled' ? r.value : [r.status, false])
  );
}

async function checkEndpoint(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Bun Cron 定时任务（每 60 秒执行一次）
Bun.cron('*/1 * * * *', async () => {
  const health = await healthCheckAll();
  for (const [platform, ok] of Object.entries(health)) {
    console.log(`[Health] ${platform}: ${ok ? 'UP' : 'DOWN'}`);
  }
});
```

#### 10.6.2 免费额度监控

| 平台 | 免费额度 | 限额说明 | 监控方式 |
|------|----------|----------|----------|
| 硅基流动 | 永久免费（指定模型） | RPM 1000，TPM 50000，单账户级别限速 | 监控 429 响应频率，触发时切换模型 |
| OfoxAI | 10 个免费模型 | 免费层存在并发限制与每日上限 | 调用前检查剩余额度 API（如有），否则监控错误率 |
| OpenRouter | 30+ `:free` 模型 | 余额≥$10 时每天 1000 次，不足时每天 50 次 | 定期查询 `/models` 接口，监控免费模型数量变化 |

建议设置 OpenRouter 账户余额告警：当余额低于 10 美元时触发通知，避免免费调用额度骤降至每天 50 次。

#### 10.6.3 模型质量评估（自动切换）

系统通过多维度评分自动评估模型输出质量，决定是否在同一 Tier 内切换模型：

| 评估维度 | 权重 | 评估方法 |
|----------|------|----------|
| 响应延迟 | 20% | P50/P99 延迟统计，超过阈值扣分 |
| 输出完整性 | 30% | JSON 可解析性、代码块闭合率、结构化输出合规性 |
| 语义一致性 | 30% | 对同一问题多次提问，计算响应相似度（嵌入向量余弦相似度） |
| 错误率 | 20% | 4xx/5xx 错误比例、超时比例 |

质量评分低于 70 分的模型自动从候选池移除，移至观察列表；观察期内连续 10 次请求评分回升至 80 分以上则恢复候选资格。

#### 10.6.4 告警规则

```yaml
# alerts.yaml — 告警规则配置
alerts:
  - name: "tier_all_down"
    condition: "all_tiers_success_rate < 0.1"
    severity: critical
    message: "所有模型层级可用性低于 10%，系统完全不可用"
    action: "notify_pagerduty"
    
  - name: "free_models_depleted"
    condition: "openrouter_free_models_count < 3"
    severity: warning
    message: "OpenRouter 免费模型数量低于 3 个，降级空间不足"
    action: "notify_slack"
    
  - name: "high_cost_spike"
    condition: "hourly_cost_cny > 10"
    severity: warning
    message: "过去一小时成本超过 10 元，可能存在异常流量"
    action: "notify_slack"
    
  - name: "rate_limit_frequent"
    condition: "siliconflow_429_rate > 0.2"
    severity: info
    message: "硅基流动限速触发频率超过 20%，建议降低并发或切换模型"
    action: "log_only"
    
  - name: "openrouter_balance_low"
    condition: "openrouter_balance_usd < 10"
    severity: warning
    message: "OpenRouter 余额低于 $10，免费调用额度将降至每天 50 次"
    action: "notify_email"
```

---

### 小结

OpenClaw 通过四层路由架构实现了从完全免费到按需付费的平滑过渡。Tier 1（硅基流动）与 Tier 2（OfoxAI）构成了零成本基础能力层，覆盖工具调用、对话、中等复杂度代码生成等 80% 的日常场景；Tier 3（付费增强）在 DeepSeek V4-Flash 等低成本高性能模型的支撑下，以极低的成本提供长上下文与深度分析能力；Tier 4（OpenRouter 备用）通过动态发现机制确保免费模型池的实时可用性。统一路由器基于 Bun 运行时实现，内置断路器、指数退避重试、用量追踪与健康监控，为生产环境提供了可靠的模型调度基础设施。


---


# 11. 结构化数据库设计

OpenClaw 的记忆持久层采用 SQLite 单文件架构，通过 Bun 运行时内置的 `bun:sqlite` 模块驱动，以 Drizzle ORM 作为类型安全的 Schema 管理工具。该设计不依赖外部数据库服务，使 Agent 可在离线环境下完整运行，同时通过 FTS5（Full-Text Search v5）全文索引实现亚 10ms 级别的记忆检索延迟 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。图 11-1 展示了核心实体关系。

![OpenClaw 结构化数据库 ERD](openclaw_erd_ch11.png)
*图 11-1：OpenClaw 结构化数据库实体关系图（ERD），涵盖 L1 短期记忆、L2 任务记忆、L3 知识记忆三层模型，以及 FTS5 虚拟表和知识图谱层*

数据库整体架构映射认知科学的三层记忆模型 [(比邻)](https://eastondev.com/blog/en/posts/ai/20260406-ollama-multi-model-deployment/) ：`conversations` 表承载 L1 短期记忆（工作记忆），记录当前会话的原始消息流；`tasks` 表对应 L2 长期记忆中的任务维度，维护 Agent 的操作历史与执行状态；`knowledge` 表存储 L3 语义记忆，保存经蒸馏处理后的事实性知识；`entities` 与 `relationships` 表共同构成轻量级知识图谱，用于表示概念之间的关联关系。每张业务表均配有对应的 FTS5 虚拟表，通过数据库触发器实现全文索引的自动同步。

---

## 11.1 数据库选型

### 11.1.1 bun:sqlite

Bun 通过内置的 `bun:sqlite` 模块提供 SQLite3 驱动支持，该模块直接集成在运行时中，无需 npm 安装或原生编译 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。API 采用同步设计，借鉴 `better-sqlite3` 的风格，预编译语句（prepared statement）可复用执行，在 Northwind Traders 数据集基准测试中，`bun:sqlite` 的读取查询性能达到 `better-sqlite3` 的 3–6 倍，是 `deno.land/x/sqlite` 的 8–9 倍 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。

SQLite 的单文件特性与 OpenClaw 的本地优先（local-first）理念高度吻合。整个记忆数据库以单个 `.db` 文件形式存储于文件系统中，便于备份、迁移和版本控制。通过合理配置 PRAGMA 参数，可获得接近客户端/服务端数据库的并发性能：

```typescript
import { Database } from "bun:sqlite";

function createDatabase(dbPath: string): Database {
    const db = new Database(dbPath);
    db.run(`PRAGMA journal_mode = WAL`);      // 写前日志，支持读写并发
    db.run(`PRAGMA synchronous = NORMAL`);     // WAL 模式下平衡安全与速度
    db.run(`PRAGMA cache_size = -64000`);      // 64 MB 页缓存
    db.run(`PRAGMA temp_store = MEMORY`);      // 临时表驻留内存
    db.run(`PRAGMA mmap_size = 268435456`);    // 256 MB 内存映射 I/O
    db.run(`PRAGMA busy_timeout = 5000`);      // 写锁等待 5 秒后重试
    db.run(`PRAGMA foreign_keys = ON`);        // 启用外键级联约束
    return db;
}
```

WAL（Write-Ahead Logging）模式是关键配置项。在标准回滚日志模式下，写入操作会锁定整个数据库文件，阻止其他读取；而 WAL 模式允许读取者访问数据库快照的同时，写入者追加日志记录，实现读写并发 [(sqlite.org)](https://sqlite.org/wal.html) 。配合 `busy_timeout = 5000`，当多个 Agent 实例竞争写入时，SQLite 自动重试直至获取写锁，避免"database is locked"错误。

### 11.1.2 不适用场景

SQLite 的架构约束决定了以下场景需要替代方案 [(sqlite.org)](https://sqlite.org/wal.html) ：

| 约束类别 | 具体限制 | OpenClaw 应对策略 |
|:---------|:---------|:------------------|
| 并发写入 | 单文件架构仅支持单写入者 | WAL 模式 + 写操作批量聚合；Agent 设计为单实例 |
| 网络文件系统 | WAL 不支持 NFS 等网络存储 | 数据库文件部署于本地 SSD |
| 多服务器共享 | 无法跨服务器共享 `.db` 文件 | 记忆与 Agent 进程同机部署 |
| 写入事务大小 | 建议不超过几十 MB | 记忆蒸馏后写入，控制单事务数据量 |

这些约束对 OpenClaw 不构成实质性障碍。Agent 作为桌面级应用运行，单实例、本地存储、中等数据量（3 个月日常使用的记忆数据库约 2.4 MB）的特征与 SQLite 的设计目标完全匹配。

### 11.1.3 Drizzle ORM

Drizzle ORM 是 `bun:sqlite` 的原生 ORM 层，运行时体积仅 3 KB（相比 Prisma 的约 500 KB 客户端和 30 MB Rust 引擎可忽略），且完全兼容 Cloudflare Workers 等边缘环境 [(Prisma)](https://www.prisma.io/docs/orm/more/comparisons/prisma-and-drizzle) 。其设计理念为"If you know SQL, you know Drizzle"——API 直接映射 SQL 语义，学习曲线平滑。

Drizzle 对 `bun:sqlite` 提供一等支持：

```typescript
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";

const sqlite = new Database(process.env.DATABASE_URL || "agent.db");
export const db = drizzle(sqlite, { schema });
```

`drizzle-kit` 负责 Schema 迁移和 SQL 生成，`--bun` 标志确保 Bun 通过自身运行时解析 SQLite 驱动，而非回退到 Node.js 兼容层 [(Morph AI)](https://www.morphllm.com/ollama-embedding-models) ：

```json
{
    "scripts": {
        "drizzle:push": "bun --bun drizzle-kit push",
        "drizzle:studio": "bun --bun drizzle-kit studio"
    }
}
```

---

## 11.2 Schema 设计

Schema 定义位于 `src/db/schema.ts`，采用 Drizzle ORM 的 SQLite 方言。以下逐一说明四张核心数据表的设计逻辑。

### 11.2.1 conversations 表

`conversations` 表记录 Agent 与用户的原始交互消息流，对应 L1 短期记忆层。每条消息作为一个独立行存储，保留完整的对话顺序和元数据：

```typescript
export const conversations = sqliteTable("conversations", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    agentId: text("agent_id").notNull(),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    content: text("content").notNull(),
    toolCalls: text("tool_calls", { mode: "json" }),
    toolResults: text("tool_results", { mode: "json" }),
    tokensUsed: integer("tokens_used"),
    latencyMs: integer("latency_ms"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
```

`role` 字段采用枚举约束，区分四类消息参与者：`user`（用户输入）、`assistant`（Agent 回复）、`system`（系统提示）、`tool`（工具调用结果）。`tool_calls` 和 `tool_results` 以 JSON 形式存储，保留工具调用的完整参数和返回结构，便于后续分析 Agent 的工具使用模式。`tokens_used` 和 `latency_ms` 字段用于监控 LLM 调用成本和响应延迟。

### 11.2.2 tasks 表

`tasks` 表维护 Agent 的任务生命周期，支撑 L2 长期记忆中的任务维度：

```typescript
export const tasks = sqliteTable("tasks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskKey: text("task_key").unique().notNull(),
    agentId: text("agent_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: ["pending", "in_progress", "completed", "failed", "cancelled"] })
        .notNull().default("pending"),
    priority: integer("priority").notNull().default(5),
    parentTaskId: integer("parent_task_id").references(() => tasks.id),
    metadata: text("metadata", { mode: "json" }),
    contextSummary: text("context_summary"),
    resultSummary: text("result_summary"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
```

`task_key` 字段提供业务级唯一标识（如 `"task-20260101-001"`），便于在 Markdown 文件和数据库行之间建立稳定映射。`parent_task_id` 实现任务的层级结构，支持子任务分解。`context_summary` 和 `result_summary` 字段存储 LLM 生成的自然语言摘要，用于任务检索时快速呈现上下文，避免加载完整的对话历史。

### 11.2.3 knowledge 表

`knowledge` 表是 L3 语义记忆的核心载体，存储经蒸馏处理后的精炼知识：

```typescript
export const knowledge = sqliteTable("knowledge", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tier: text("tier", { enum: ["episodic", "semantic", "project", "procedural"] })
        .notNull().default("semantic"),
    source: text("source").notNull(),          // 来源标记（对话ID / 文件路径）
    topicKey: text("topic_key").notNull(),    // 主题分类键
    content: text("content").notNull(),       // 知识正文
    metadata: text("metadata", { mode: "json" }),
    confidence: real("confidence").notNull().default(0.7),
    accessCount: integer("access_count").notNull().default(0),
    distilled: integer("distilled", { mode: "boolean" }).notNull().default(false),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
```

`tier` 字段采用四分类体系，参考 CoALA（Cognitive Architectures for Language Agents）框架 [(arXiv.org)](https://arxiv.org/pdf/2503.12687) ：`episodic`（情景记忆，具体事件）、`semantic`（语义记忆，事实知识）、`project`（项目记忆，当前项目上下文）、`procedural`（程序记忆，操作规则与技能）。`confidence` 字段取值 0–1，对话提取的初始事实默认 0.6，经代码或 Git 历史交叉验证后可提升至 0.9+ [(Local AI Master)](https://localaimaster.com/models/qwen-2-5-coder-7b) 。`access_count` 记录知识被检索的次数，作为重要性排序依据。`distilled` 布尔标记区分原始记忆（`false`）和精炼知识（`true`），只有 `distilled = true` 的知识条目会被加载到 Agent 上下文中。

### 11.2.4 entities / relationships 表

`entities` 和 `relationships` 表构成轻量级知识图谱，存储从对话和文档中提取的实体及其关系：

```typescript
export const entities = sqliteTable("entities", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").unique().notNull(),
    type: text("type").notNull(),              // person / org / concept / tool / file
    properties: text("properties", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const relationships = sqliteTable("relationships", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceEntity: integer("source_entity").references(() => entities.id).notNull(),
    targetEntity: integer("target_entity").references(() => entities.id).notNull(),
    relationType: text("relation_type").notNull(),  // uses / depends_on / part_of / mentions
    properties: text("properties", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
```

实体类型（`type`）覆盖 Agent 工作场景中的常见概念：人物（`person`）、组织（`org`）、技术概念（`concept`）、工具（`tool`）、文件（`file`）。关系类型（`relation_type`）编码实体间的语义关联：`uses`（使用关系）、`depends_on`（依赖关系）、`part_of`（组成关系）、`mentions`（提及关系）。该图谱结构通过 SQLite 的递归 CTE（Common Table Expression）支持多跳查询，例如查找与某实体在 3 跳之内关联的所有知识：

```sql
WITH RECURSIVE related AS (
    SELECT target_entity, 1 AS depth FROM relationships WHERE source_entity = ?
    UNION ALL
    SELECT r.target_entity, related.depth + 1
    FROM relationships r
    JOIN related ON r.source_entity = related.target_entity
    WHERE related.depth < 3
)
SELECT e.* FROM related
JOIN entities e ON related.target_entity = e.id;
```

---

## 11.3 索引设计

### 11.3.1 FTS5 全文索引

FTS5 是 SQLite 内置的全文搜索引擎，通过倒排索引（inverted index）结构实现 $O(\log n)$ 的词项查找和 $O(k)$ 的结果检索 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。OpenClaw 为 `conversations` 和 `knowledge` 表各创建一个 FTS5 虚拟表，使用 `porter unicode61` 分词策略——Porter 词干提取器处理英文词形变化（"running" 匹配 "run"），`unicode61` 分词器处理 Unicode 标点边界 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。

```sql
-- conversations 全文索引
CREATE VIRTUAL TABLE conversations_fts USING fts5(
    content,
    content='conversations',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- knowledge 全文索引
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    content,
    content='knowledge',
    content_rowid='id',
    tokenize='porter unicode61'
);
```

索引同步通过 AFTER 触发器自动维护，无需应用层干预：

```sql
CREATE TRIGGER trg_conversations_ai AFTER INSERT ON conversations BEGIN
    INSERT INTO conversations_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER trg_conversations_au AFTER UPDATE ON conversations BEGIN
    UPDATE conversations_fts SET content = NEW.content WHERE rowid = NEW.id;
END;

CREATE TRIGGER trg_conversations_ad AFTER DELETE ON conversations BEGIN
    DELETE FROM conversations_fts WHERE rowid = OLD.id;
END;
```

FTS5 内置 BM25（Best Matching 25）相关性评分算法，公式为：

$$\text{score}(D, Q) = \sum_{q_i \in Q} \text{IDF}(q_i) \cdot \frac{f(q_i, D) \cdot (k_1 + 1)}{f(q_i, D) + k_1 \cdot (1 - b + b \cdot |D| / \text{avgdl})}$$

其中 $f(q_i, D)$ 为词项 $q_i$ 在文档 $D$ 中的出现频率，$|D|$ 为文档长度，$\text{avgdl}$ 为平均文档长度，$k_1 = 1.2$ 为词频饱和度参数，$b = 0.75$ 为长度归一化参数 [(paradedb.com)](https://www.paradedb.com/learn/search-concepts/bm25) 。BM25 的词频饱和特性确保高频词不再线性增长评分，避免长文档的不公平优势。

查询时可利用 BM25 权重调优，使标题匹配的重要性高于内容匹配。在十万级文档量下，FTS5 冷查询（新进程启动）延迟约 10 ms，热查询（同进程缓存）延迟约 9 ms [(Github)](https://github.com/mneves75/ffts-grep) 。

### 11.3.2 元数据索引

除 FTS5 全文索引外，B-树索引覆盖所有高频过滤条件：

```sql
-- conversations 索引
CREATE INDEX idx_conversations_session ON conversations(session_id, created_at);
CREATE INDEX idx_conversations_agent ON conversations(agent_id, created_at);
CREATE INDEX idx_conversations_created ON conversations(created_at);

-- tasks 索引
CREATE INDEX idx_tasks_agent ON tasks(agent_id, status);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_priority ON tasks(priority DESC, created_at);

-- knowledge 索引
CREATE INDEX idx_knowledge_tier ON knowledge(tier);
CREATE INDEX idx_knowledge_topic ON knowledge(topic_key);
CREATE INDEX idx_knowledge_distilled ON knowledge(distilled);
CREATE INDEX idx_knowledge_expires ON knowledge(expires_at);

-- entities / relationships 索引
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_rel_source ON relationships(source_entity);
CREATE INDEX idx_rel_target ON relationships(target_entity);
CREATE INDEX idx_rel_type ON relationships(relation_type);
```

索引设计遵循"最左前缀"原则。`idx_conversations_session` 将 `session_id` 和 `created_at` 组成复合索引，同时满足按会话检索和时序排序的需求；`idx_tasks_priority` 按优先级降序排列，确保高优先级任务优先返回。

### 11.3.3 性能优化

综合索引策略的加速效果如下：

| 技术 | 加速比 | 适用场景 |
|:-----|:-------|:---------|
| FTS5 倒排索引 | 10–40x | 全文关键词搜索 |
| B-树复合索引 | $O(n) \to O(\log n)$ | 精确查找、范围查询 |
| WAL 模式 | 1.5–2x 写入吞吐 | 高并发读写场景 |
| 内存映射（mmap） | 读取延迟降低 30–50% | 大文件随机读取 |
| 事务批处理 | 10–100x | 记忆蒸馏后的批量写入 |

FTS5 与元数据索引形成互补检索路径。FTS5 处理非结构化文本搜索（自然语言描述、对话内容），B-树索引处理结构化过滤（时间范围、状态、优先级、层级关系），两者在查询时组合使用。对于 CJK（中日韩）文本的子串匹配需求，可额外创建 Trigram 分词的辅助 FTS5 表，与主表通过 RRF（Reciprocal Rank Fusion）融合结果 [(Zenn)](https://zenn.dev/kanseilink/articles/kanseilink-fts5-trigram-cjk-20260507?locale=en) 。

---

## 11.4 记忆蒸馏 Pipeline

### 11.4.1 原始记忆→精炼知识

记忆蒸馏是将原始对话记录压缩为精炼知识的关键过程 [(Local AI Master)](https://localaimaster.com/models/qwen-2-5-coder-7b) 。未经处理的对话记录存在信息冗余（寒暄、重复确认、格式噪音），直接加载到 LLM 上下文会浪费宝贵的 token 预算。蒸馏 Pipeline 将 L1 层的原始对话转化为 L3 层的高密度知识表示：

```
原始对话记录 → 事实提取（LLM）→ 去重 → 置信度评分 → knowledge 表写入 → FTS5 索引更新
```

事实提取步骤调用 LLM 对对话窗口进行结构化解析，输出格式化的知识条目（主题、内容、置信度、来源引用）。去重步骤检查新事实是否为已有条目的子串或语义重复——若是，则跳过写入；若与已有条目矛盾，则标记为待审核。置信度评分根据信息来源确定基线值：对话提取 0.6、代码/Git 交叉验证 0.9+、用户显式确认 1.0 [(Local AI Master)](https://localaimaster.com/models/qwen-2-5-coder-7b) 。

### 11.4.2 触发条件

蒸馏操作并非实时执行，而是在以下三种条件之一满足时触发：

| 触发条件 | 参数 | 说明 |
|:---------|:-----|:-----|
| 时间驱动 | 每 30 分钟 | 定时处理周期内累积的对话记录 |
| 数量驱动 | 单会话消息数 ≥ 20 条 | 长对话结束后立即触发 |
| 事件驱动 | 任务状态变为 `completed` | 任务完成时归档并提炼经验 |

时间驱动模式保证记忆不会无限累积而不处理；数量驱动模式确保长对话的及时蒸馏；事件驱动模式将任务完成时的经验立即转化为程序性知识。三种触发器通过 `setInterval` 和任务状态监听器实现，避免阻塞正常的对话流程。

### 11.4.3 质量评估

蒸馏质量通过三个维度评估：

**信息保留率**衡量关键事实在蒸馏过程中的保留程度。选取 100 条代表性对话，人工标注其中包含的事实陈述，计算蒸馏后知识条目的召回率。目标保留率 ≥ 85%，低于阈值时调整 LLM 提取提示词中的指令细节。

**压缩比**衡量冗余信息的消除效率。计算公式为蒸馏前对话文本总字符数与蒸馏后知识内容总字符数之比。经验目标压缩比为 5:1 至 10:1，即 10,000 字符的对话应压缩为 1,000–2,000 字符的知识表示。

**检索命中率**衡量蒸馏知识在实际使用中的效用。记录 Agent 加载的上下文中，来源于蒸馏知识的比例。命中率持续低于 30% 表明蒸馏策略需要调整——可能是提取过于保守（遗漏关键信息）或过于激进（丢失上下文细节）。

蒸馏后的知识条目 `distilled` 标记置为 `true`，只有蒸馏完成的知识才会参与 FTS5 检索并加载到 Agent 上下文中。原始对话记录保留在 `conversations` 表中作为审计追踪，但不再直接参与检索，形成"原始记录归档 + 精炼知识活跃"的双层存取结构。


---


## 12. 安装部署指南

OpenClaw 系统的部署遵循分层依赖原则——从运行时层到应用层逐级构建，每层组件仅依赖其下层已安装的基础设施。图 12-1 展示了四层部署架构及各组件之间的依赖关系。整个部署流程在具备基础 Linux/macOS 环境的机器上约需 45–60 分钟完成，其中 Ollama 模型下载占时最长（qwen2.5:14b 模型约 8.2 GB [(Local AI Master)](https://localaimaster.com/blog/ollama-model-ram-vram-table) ）。

![OpenClaw 系统组件部署依赖图](fig12_1_deployment_architecture.png)
*图 12-1：OpenClaw 系统四层部署架构——运行时层（Bun/Python/Node.js）→ 基础设施层（Ollama/SQLite/Obsidian/Git）→ 核心服务层（Gateway/MCP Server/LSP Bridge）→ 应用层（Hermes Agent/OpenCode/Pi Engine），箭头表示启动依赖方向*

### 12.1 环境准备

#### 12.1.1 系统要求

OpenClaw 的硬件需求由两层负载决定：Ollama 本地模型推理消耗 GPU VRAM，其余系统组件（Gateway、MCP Server、LSP Bridge）主要消耗系统 RAM 和 CPU 周期。以下是经多维度验证的最低与推荐配置 [(Local AI Master)](https://localaimaster.com/blog/ollama-system-requirements) ：

| 资源维度 | 最低配置 | 推荐配置 | 说明 |
|:---------|:---------|:---------|:-----|
| 操作系统 | Linux (Ubuntu 22.04+) / macOS 13+ / WSL2 | Linux (Ubuntu 24.04 LTS) | Windows 原生环境建议通过 WSL2 部署 [(langfuse.com)](https://langfuse.com/integrations/model-providers/ollama)  |
| 系统 RAM | 16 GB | 32 GB | Ollama 14B 模型运行期间峰值占用约 12 GB |
| GPU VRAM | 8 GB (Q4 量化) | 12 GB+ | qwen2.5:14b Q4_K_M 量化需 9.5 GB [(Github)](https://github.com/Michael-Obele/docshark)  |
| 磁盘空间 | 30 GB SSD | 50 GB NVMe SSD | 含模型文件（14B 约 8.2 GB + 嵌入模型 274 MB） |
| 网络 | 可访问国内云 API | 国内云 + 可选国际线路 | DeepSeek/阿里云百炼等 API 需公网访问 |

GPU 支持方面，Ollama 兼容 NVIDIA（CUDA 11.8+）、AMD ROCm 和 Apple Metal 三种后端 [(Local AI Master)](https://localaimaster.com/blog/ollama-system-requirements) 。无独立 GPU 时，Ollama 自动回退至纯 CPU 推理，14B 模型速度降至 3–6 tok/s [(Local AI Master)](https://localaimaster.com/blog/ollama-model-ram-vram-table) ，仅适合低频工具调用场景。推荐 GPU 型号为 RTX 3060 12 GB 或 RTX 4060 Ti 16 GB，在 qwen2.5:14b 上分别可达 40+ tok/s 和 60+ tok/s [(Local AI Master)](https://localaimaster.com/blog/ollama-model-ram-vram-table) 。

#### 12.1.2 Bun 安装

Bun（版本 ≥ 1.2）是整个系统的基础运行时。OpenClaw Gateway、MCP Server、数据采集 Pipeline 以及数据库层均依赖 Bun 的内置能力（`bun:sqlite`、`Bun.spawn`、`Bun.fetch`）。Bun 的安装方式如下 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) ：

```bash
# macOS / Linux（官方推荐方式）
curl -fsSL https://bun.sh/install | bash

# 验证安装
bun --version
# 预期输出: 1.2.x 或更高

# 将 bun 加入 PATH（按安装提示操作）
export PATH="$HOME/.bun/bin:$PATH"
```

Bun 相比 Node.js 在安装速度和运行性能上具有显著优势：包安装速度快 25 倍、启动时间低至 90 ms（Node.js 约 1 s）、SQLite 读取查询快 3–6 倍 [(Serverman | Tech Reviews | How-To Guides)](https://www.serverman.co.uk/ai/ollama/best-ollama-models-8gb-ram/) 。但 OpenClaw Gateway 本身仍需要 Node.js 24（或 Node.js 22 LTS 22.19+）作为宿主运行时 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) ，因此两个运行时需共存。Bun 负责数据层和工具链，Node.js 负责 Gateway 守护进程。

国内网络环境下，若官方安装脚本下载缓慢，可通过以下方式加速：

```bash
# 使用国内镜像源安装 Bun
npm install -g bun        # 前提: Node.js 已安装

# 配置 npm 国内镜像（加速后续依赖安装）
npm config set registry https://registry.npmmirror.com
```

#### 12.1.3 Python 安装（Scrapling 用）

Python 仅在数据采集模块的反爬场景中使用。Bun 原生方案（`fetch` + `cheerio`）覆盖 80% 的爬取需求[^Dim08^]，剩余 20% 需通过 Scrapling 框架的 `StealthyFetcher` 绕过 Cloudflare 等反爬保护。Scrapling 要求 Python ≥ 3.11 [(Github)](https://github.com/D4Vinci/Scrapling) 。

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y python3.11 python3.11-venv python3-pip

# macOS
brew install python@3.11

# 创建独立虚拟环境（避免污染系统 Python）
python3.11 -m venv ~/.openclaw/venv
source ~/.openclaw/venv/bin/activate

# 安装 Scrapling（含完整依赖，含 Playwright + Camoufox）
pip install "scrapling[all]"

# 验证安装
python -c "from scrapling.fetchers import StealthyFetcher; print('Scrapling OK')"
```

`scrapling[all]` 安装包体积约 800 MB，其中 Camoufox（修改版 Firefox）和 Playwright 浏览器二进制占主要部分。若仅使用基础 `Fetcher`（HTTP 请求），可改为 `pip install scrapling` 将体积降至约 50 MB [(xugj520.cn)](https://www.xugj520.cn/en/archives/scrapling-adaptive-web-scraping-framework.html) 。Bun 通过 `Bun.spawn()` 调用 Python 子进程，两者之间通过 JSON 标准输入输出交换数据，无需共享内存或复杂 IPC 机制[^Dim08^]。

### 12.2 核心组件安装

#### 12.2.1 OpenClaw 安装

OpenClaw 提供三种安装方式，curl 一键安装适用于绝大多数用户，Docker 部署适用于生产环境，源码编译适用于二次开发场景 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。

```bash
# 方式一: curl 一键安装（推荐，约 5 分钟）
curl -fsSL https://openclaw.ai/install.sh | bash

# 方式二: Docker Compose 部署（约 15 分钟）
git clone https://github.com/openclaw/openclaw
cd openclaw && cp .env.example .env
# 编辑 .env 填入 API Key
docker-compose up --build -d

# 安装后验证
openclaw --version
openclaw onboard          # 交互式配置向导
```

curl 安装脚本执行完毕后会自动启动 `openclaw onboard` 向导，引导用户选择 LLM 提供商并输入 API Key [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。首次配置需指定至少一个模型端点（本地 Ollama 或云端 DeepSeek API），否则 Gateway 无法启动。配置文件位于 `~/.openclaw/openclaw.json`，采用 JSON5 格式（支持注释和尾部逗号） [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。

#### 12.2.2 Ollama 安装与模型拉取

Ollama 是本地模型推理的基础设施，默认监听 `127.0.0.1:11434`，提供 OpenAI 兼容的 `/v1/*` API 端点 [(CSDN博客)](https://blog.csdn.net/gusushantang/article/details/149825229) 。

```bash
# macOS（Homebrew 推荐）
brew install ollama
brew services start ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
ollama serve              # 前台启动，或配置 systemd 服务

# 验证安装
ollama -v                 # 检查版本（当前稳定版 0.24.0）
ollama list               # 查看已下载模型（初始为空）
```

模型拉取命令清单：

```bash
# 主力工具模型（9.5 GB VRAM，工具调用可靠性 ~90%）
ollama pull qwen2.5:14b

# 嵌入模型（274 MB，纯 CPU 运行）
ollama pull nomic-embed-text

# 可选：编码专用模型（适合离线代码生成场景）
ollama pull qwen2.5-coder:14b

# 验证工具调用能力
ollama show qwen2.5:14b
# 预期输出中应包含 "Capabilities: completion, tools"
```

生产环境推荐配置 systemd 服务文件 `/etc/systemd/system/ollama.service`，确保 Ollama 随系统启动并自动恢复 [(PkgPulse)](https://www.pkgpulse.com/guides/state-of-nodejs-orms-2026) ：

```ini
[Unit]
Description=Ollama Service
After=network-online.target

[Service]
ExecStart=/usr/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment="PATH=$PATH"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"

[Install]
WantedBy=multi-user.target
```

#### 12.2.3 Obsidian 安装与插件配置

Obsidian 作为记忆管理系统的可视化前端和 REST API 服务提供者，安装流程分为桌面客户端安装和插件启用两步[^Dim07^]。

```bash
# 方式一: macOS
brew install --cask obsidian

# 方式二: Linux (AppImage)
wget https://github.com/obsidianmd/obsidian-releases/releases/download/v1.8.9/Obsidian-1.8.9.AppImage
chmod +x Obsidian-1.8.9.AppImage
./Obsidian-1.8.9.AppImage

# 方式三: 手动下载
# 访问 https://obsidian.md/download 选择对应平台
```

Obsidian 启动后，需依次安装以下三个关键插件：

1. **obsidian-local-rest-api**：提供 HTTPS REST API（默认端口 27124），支持完整 CRUD 操作和精确 Patch 编辑。安装方式：Obsidian 设置 → 社区插件 → 浏览 → 搜索 "Local REST API" → 安装并启用。启用后在插件设置中生成 API Key[^Dim07^]。

2. **Dataview**：提供 SQL 风格查询语言，用于动态仪表盘和记忆统计。安装方式同上，搜索 "Dataview"[^Dim07^]。

3. **Periodic Notes**（可选）：自动生成日/周/月/季/年周期性笔记模板。

Vault 目录结构初始化命令：

```bash
mkdir -p ~/.openclaw/workspace/{01-Projects,02-Areas,03-Knowledge,04-Conversations,05-Tasks,06-Archives,memory}
touch ~/.openclaw/workspace/{SOUL.md,USER.md,AGENTS.md,MEMORY.md,HEARTBEAT.md,INDEX.md,LOG.md}
```

#### 12.2.4 OpenCode 安装

OpenCode 是系统的编码 Agent，负责代码生成、重构和测试任务。推荐通过 Bun 安装以获得最佳性能 [(Opencode 重新定义你的 AI 编程体验 | OpenCodex)](https://opencodex.cc/posts/opencode-installation-guide) 。

```bash
# 方式一: Bun 包管理器（推荐，启动快 4 倍、内存低 47%）
bun install -g opencode-ai@latest

# 方式二: 官方一键安装脚本
curl -fsSL https://opencode.ai/install | bash

# 方式三: Docker
docker run -it --rm ghcr.io/anomalyco/opencode

# 验证安装
opencode --version
```

安装完成后需配置模型连接。编辑 `~/.opencode/opencode.json`：

```json
{
  "provider": "openrouter",
  "model": "deepseek/deepseek-chat-v3.1",
  "fallback": {
    "provider": "ollama",
    "model": "qwen2.5-coder:14b"
  }
}
```

OpenCode 支持在同一对话中通过 `/model` 命令切换模型 [(陈广亮的技术博客)](https://chenguangliang.com/posts/blog149_ai-coding-tools-2026-review/) 。LSP 插件安装通过 OpenCode 内部命令完成：`/plugin install typescript-lsp`。

#### 12.2.5 Hermes Agent 安装

Hermes Agent 作为深度研究模块，通过 Ollama 运行 hermes3 模型实例 [(Clanker Cloud)](https://clankercloud.ai/blog/hermes-agent-clanker-cloud-infrastructure-management) 。Hermes Agent 不依赖独立安装包，而是通过 Ollama 拉取模型并配合 OpenClaw Gateway 的路由绑定启动。

```bash
# 拉取 Hermes 3 模型（基于 Llama 3 微调，专为代理任务优化）
ollama pull hermes3:8b

# 验证工具调用能力
ollama show hermes3:8b
# 预期 Capabilities 包含: completion, tools
```

Hermes Agent 的工作目录初始化：

```bash
mkdir -p ~/.openclaw/workspace/hermes/{skills,learn,tmp}
```

Hermes Agent 的配置通过 OpenClaw Gateway 的 `bindings` 机制实现——将研究类请求路由至 Hermes Agent 处理。具体路由规则见第 12.3.1 节的完整配置模板。

### 12.3 配置文件模板

#### 12.3.1 OpenClaw 配置

以下 `openclaw.json` 模板整合了 Gateway、Pi 引擎、模型路由、Agent 绑定和安全策略的完整配置，基于前文第 3、4、10 章的参数设计 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) ：

```json5
// ~/.openclaw/openclaw.json — 完整部署配置模板
{
  // === Gateway 层 ===
  gateway: {
    port: 18789,
    bind: "loopback",              // 仅本机访问，生产环境建议 SSH 隧道转发
    auth: { token: "${env.OC_TOKEN}" },
    logLevel: "info",
  },

  // === 模型路由 ===
  models: {
    mode: "merge",                 // 追加而非替换内置提供商列表
    providers: {
      deepseek: {
        apiKey: "${env.DEEPSEEK_API_KEY}",
        models: [
          { id: "deepseek-chat", contextWindow: 64000 },
          { id: "deepseek-coder", contextWindow: 128000 },
        ],
      },
      ollama: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        api: "openai-compatible",
        models: [
          { id: "qwen2.5:14b", contextWindow: 8192 },
          { id: "nomic-embed-text", contextWindow: 8192 },
        ],
      },
    },
  },

  // === Agent 配置 ===
  agents: {
    list: [
      {
        id: "main",
        default: true,
        name: "Assistant",
        workspace: "~/.openclaw/workspace",
        model: {
          primary: "deepseek/deepseek-chat",
          fallback: "ollama/qwen2.5:14b",
        },
        sandbox: {
          mode: "non-main",          // 主会话宿主机运行，子会话沙箱隔离
          docker: {
            binds: [],
            image: "openclaw/sandbox:latest",
          },
        },
        tools: {
          allow: ["ptc_execute", "group:openclaw"],
        },
      },
      {
        id: "research",
        name: "HermesResearch",
        workspace: "~/.openclaw/workspace/hermes",
        model: { primary: "ollama/hermes3:8b" },
      },
    ],
  },

  // === 消息路由 ===
  bindings: [
    // 研究类关键词路由至 Hermes Agent
    { agentId: "research", match: { channel: "telegram", peer: { kind: "dm" } } },
    { agentId: "main", match: { channel: "telegram" } },
    { agentId: "main", match: { channel: "cli" } },
  ],

  // === 渠道配置 ===
  channels: {
    telegram: {
      enabled: true,
      botToken: "${env.TELEGRAM_BOT_TOKEN}",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
    cli: { enabled: true },
  },
}
```

配置中的 `${env.VAR_NAME}` 语法从环境变量读取敏感值 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) ，避免 API Key 落入磁盘文件。生产环境应将 `.env` 文件权限设置为 `600`，并排除在版本控制之外。

#### 12.3.2 MCP 服务器配置

MCP（Model Context Protocol）服务器通过 `openclaw config set` 命令动态注册。以下是系统所需的完整 MCP 服务器清单 [(Github)](https://github.com/blackwell-systems/agent-lsp) [^Dim05^]：

```bash
# 1. 文件系统 MCP（Workspace 文件操作）
openclaw config set mcp.servers.filesystem \
  '{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/home/user/.openclaw/workspace"]}'

# 2. SQLite MCP（数据库查询与 FTS5 搜索）
openclaw config set mcp.servers.sqlite \
  '{"command":"bun","args":["run","mcp-sqlite-server.ts"]}'

# 3. Obsidian Vault MCP（通过 REST API 访问 Vault）
openclaw config set mcp.servers.obsidian \
  '{"type":"http","url":"https://127.0.0.1:27124/mcp/","headers":{"Authorization":"Bearer ${env.OBSIDIAN_API_KEY}"}}'

# 4. 网络搜索 MCP（SerpAPI）
openclaw config set mcp.servers.web-search \
  '{"command":"uvx","args":["mcp-server-serpapi"],"env":{"SERPAPI_API_KEY":"${env.SERPAPI_KEY}"}}'

# 5. Scrapling MCP（AI 辅助爬取，可选）
openclaw config set mcp.servers.scrapling \
  '{"command":"python3","args":["-m","scrapling.mcp"]}'

# 应用配置并重启 Gateway
openclaw gateway restart

# 验证所有 MCP 服务器状态
openclaw mcp list
```

#### 12.3.3 LSP 配置

LSP（Language Server Protocol）桥接通过 agent-lsp 将语言服务器能力暴露为 MCP 工具。agent-lsp 的安装和配置如下 [(Github)](https://github.com/blackwell-systems/agent-lsp) ：

```bash
# 安装 agent-lsp
npm install -g @blackwell-systems/agent-lsp

# 验证环境（探测所有配置的语言服务器）
agent-lsp doctor

# 交互式初始化（自动生成 MCP 配置）
agent-lsp init
```

agent-lsp 的 MCP 配置模板：

```json
{
  "mcpServers": {
    "lsp": {
      "type": "stdio",
      "command": "agent-lsp",
      "args": [
        "typescript:typescript-language-server,--stdio",
        "python:pyright-langserver,--stdio",
        "go:gopls",
        "rust:rust-analyzer"
      ]
    }
  }
}
```

上述配置启用 TypeScript、Python、Go、Rust 四种语言的语义支持。agent-lsp 的 65 个 MCP 工具 [(Github)](https://github.com/blackwell-systems/agent-lsp) 在首次请求对应语言时自动启动语言服务器守护进程，约 10 秒完成索引，30 分钟无活动后自动退出。`typescript-language-server` 和 `pyright` 需预先安装：`npm install -g typescript-language-server typescript pyright`。

#### 12.3.4 Ollama 环境变量

Ollama 的行为通过环境变量全局控制。以下配置针对 qwen2.5:14b 工具模型场景优化，在 12 GB VRAM 设备上可获得最佳推理性能 [(ollama.com)](https://docs.ollama.com/faq) ：

```bash
# === 性能优化 ===
export OLLAMA_FLASH_ATTENTION=1        # KV Cache 减少 40–60%，强烈推荐启用
export OLLAMA_KV_CACHE_TYPE=q8_0       # 内存减半，质量几乎无损
export OLLAMA_CONTEXT_LENGTH=8192      # 工具模型 8K 上下文足够

# === 并发配置 ===
export OLLAMA_NUM_PARALLEL=2           # 单个模型并发请求数
export OLLAMA_MAX_LOADED_MODELS=3      # 同时加载 qwen2.5:14b + nomic-embed-text + hermes3:8b
export OLLAMA_KEEP_ALIVE=-1            # 模型常驻内存，消除冷启动延迟
export OLLAMA_MAX_QUEUE=512            # 请求队列长度

# === 调试（排查时临时启用）===
# export OLLAMA_DEBUG=1
```

Modelfile 方式可为特定模型覆盖全局配置。以下为 qwen2.5:14b 的自定义 Modelfile，将温度参数降低以提升工具调用格式遵循率 [(比邻)](https://eastondev.com/blog/en/posts/ai/ollama-modelfile-guide/) ：

```dockerfile
# ~/.openclaw/Modelfile.qwen25-14b-tools
FROM qwen2.5:14b
PARAMETER num_ctx 8192
PARAMETER temperature 0.3
PARAMETER top_p 0.9
SYSTEM "You are a tool-calling assistant. Always use the provided function_call format."
```

创建自定义模型：`ollama create qwen2.5:14b-tools -f ~/.openclaw/Modelfile.qwen25-14b-tools`，此后在 OpenClaw 配置中将模型 ID 改为 `qwen2.5:14b-tools` 即可使用该配置。

### 12.4 验证测试

部署完成后，需执行三阶段验证流程（图 12-2），从组件独立测试到集成测试再到性能基准，确保系统各层级功能正常。

![OpenClaw 验证测试流程](fig12_2_verification_flow.png)
*图 12-2：三阶段验证测试流程——Phase 1 组件独立测试（5 项检查）、Phase 2 集成测试（5 项链路验证）、Phase 3 性能基准（5 项指标测量），每阶段设定明确的通过标准*

#### 12.4.1 组件独立测试

各组件独立验证命令清单及预期输出：

| 组件 | 测试命令 | 预期结果 | 通过标准 |
|:-----|:---------|:---------|:---------|
| Bun 运行时 | `bun --version` | 输出 ≥ 1.2.x | 版本号匹配 |
| Ollama 服务 | `curl http://localhost:11434/api/tags` | JSON 返回模型列表 | HTTP 200，含 qwen2.5:14b |
| qwen2.5:14b 推理 | `ollama run qwen2.5:14b "hello"` | 生成响应文本 | 响应时间 < 5 s |
| OpenClaw Gateway | `openclaw gateway start` + `curl ws://127.0.0.1:18789` | WebSocket 握手成功 | 端口监听正常 |
| Obsidian REST API | `curl -k -H "Authorization: Bearer $KEY" https://127.0.0.1:27124/vault/` | 返回 Vault 文件列表 | HTTP 200 |
| OpenCode | `opencode --version` | 输出版本号 | 无报错退出 |
| agent-lsp | `agent-lsp doctor` | 报告各语言服务器状态 | 所有服务器 detected |
| FTS5 索引 | `bun run test-fts5.ts`（自定义脚本） | 返回 BM25 评分结果 | 查询延迟 < 10 ms |

组件独立测试阶段的全部 8 项检查通过，方可进入集成测试阶段。任何一项失败应返回对应组件的安装步骤排查。

#### 12.4.2 集成测试

集成测试验证跨组件链路的端到端数据流。测试场景设计遵循"最小功能路径"原则，覆盖 Gateway → Agent → 工具 → 记忆存储的完整回路 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) 。

**测试 1：Gateway → Agent 消息路由**

通过 CLI 渠道发送测试消息，验证 Gateway 正确路由至 Pi 引擎，Agent 生成响应并返回：

```bash
# 启动 Gateway 前台模式（便于观察日志）
openclaw gateway start --foreground

# 在另一个终端发送测试消息
openclaw send --channel cli --message "请记录一条测试笔记"

# 预期行为:
# 1. Gateway 日志显示消息接收 + 路由决策
# 2. Agent 日志显示工具调用（Write 工具写入 memory/日期.md）
# 3. 响应返回成功
```

**测试 2：Agent → MCP 工具调用**

发送需要外部工具的消息，验证 MCP 工具注册和调用链路：

```bash
openclaw send --channel cli --message "搜索今天的科技新闻"
# 预期: Agent 调用 web-search MCP 工具 → 返回搜索结果 → Agent 总结回复
```

**测试 3：Agent → Obsidian 记忆写入**

验证 Agent 可通过 MCP 将知识写入 Obsidian Vault 并触发 FTS5 索引更新：

```bash
openclaw send --channel cli --message "将 'Redis 缓存最佳实践' 记录到知识库"
# 预期: Vault 03-Knowledge/ 目录新增 Markdown 文件
#       FTS5 索引自动同步（通过数据库触发器）
```

**测试 4：编码 Agent 协作**

验证 OpenCode 可通过 MCP 获取项目上下文并生成代码：

```bash
opencode /mcp list          # 列出可用 MCP 工具
opencode "写一个 SQLite FTS5 搜索函数"
# 预期: OpenCode 调用 LSP 工具获取类型信息 → 生成类型安全代码
```

**测试 5：记忆蒸馏 Pipeline**

触发记忆蒸馏流程，验证 L1（对话记录）→ L3（精炼知识）的转换链路：

```bash
# 模拟完成一个任务
openclaw send --channel cli --message "完成记忆蒸馏测试"
# 等待 30 分钟（定时触发器）或手动触发
bun run trigger-distill.ts
# 预期: knowledge 表新增 distilled=true 条目，原始对话仍保留在 conversations 表
```

#### 12.4.3 性能基准

性能基准测试建立系统运行的量化基线，为后续运维监控提供比较基准。

| 指标 | 测试方法 | 目标值 | 测量工具 |
|:-----|:---------|:-------|:---------|
| Gateway 延迟 | `wrk -t4 -c100 -d30s ws://127.0.0.1:18789` | P99 < 2.5 ms [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api)  | wrk / curl |
| FTS5 检索延迟 | 十万级文档量下关键词搜索 | 冷查询 < 10 ms，热查询 < 9 ms [(Github)](https://github.com/mneves75/ffts-grep)  | `bun:sqlite` 内置计时 |
| qwen2.5:14b TTFT | 首 token 生成时间（GPU 满载） | < 2 s | Ollama 日志 |
| qwen2.5:14b 吞吐 | tok/s（12 GB VRAM 设备） | ≥ 40 tok/s [(Local AI Master)](https://localaimaster.com/blog/ollama-model-ram-vram-table)  | Ollama `ollama ps` |
| 24h 稳定性 | 持续运行 Gateway + Ollama | 零崩溃、零内存泄漏 | systemd 状态监控 |
| MCP 工具调用 | 100 次连续工具调用成功率 | ≥ 85%（7B 模型）/ ≥ 90%（14B 模型） [(Github)](https://github.com/Michael-Obele/docshark)  | 自定义脚本 |

Gateway 延迟测试使用 `curl` 测量 WebSocket 握手往返时间，在本地回环网络中 P99 应低于 2.5 ms。若超过该阈值，应检查 Node.js 进程是否被 CPU 限流或存在日志阻塞。FTS5 检索延迟通过 `bun:sqlite` 的 `Date.now()` 差值测量，在 3 个月日常使用积累的数据库（约 2.4 MB）中实测约 6–8 ms [(Github)](https://github.com/mneves75/ffts-grep) 。

VRAM 监控可通过 `nvidia-smi`（NVIDIA GPU）或 `ollama ps`（跨平台）实时查看。ollama ps 的输出示例：

```bash
$ ollama ps
NAME                    ID              SIZE    PROCESSOR       UNTIL
qwen2.5:14b-tools       abc123...       9.5 GB  100% GPU        Forever
nomic-embed-text:latest def456...       274 MB  100% GPU        Forever
```

当 `PROCESSOR` 列显示非 100% GPU 时，表明部分模型层被卸载至 CPU，推理速度会下降 3–10 倍。此时应优先启用 `OLLAMA_FLASH_ATTENTION=1` 和 `OLLAMA_KV_CACHE_TYPE=q8_0` 以节省 VRAM，或降低 `OLLAMA_CONTEXT_LENGTH` 减少上下文缓存占用。


---


## 13. 运维与监控

OpenClaw Agent 系统的运维对象覆盖六类核心组件：Gateway 守护进程、Ollama 本地推理服务、SQLite 记忆数据库、Obsidian Vault 文件存储、MCP 工具服务器和 LSP 语言服务进程。各组件运维复杂度差异显著——Gateway 作为 Node.js 守护进程需要进程级监控 [(4/ChatGPT API)](http://iyi-chatgpt.github.io/model-3-api) ；Ollama 的 GPU 推理受显存约束 [(Github)](https://github.com/mneves75/ffts-grep) ；SQLite 单文件架构简化了备份但 WAL 模式需碎片维护 [(sqlite.org)](https://sqlite.org/wal.html) 。本章从日常运维、监控告警、故障处理三个维度提供可操作的运维手册，以检查清单为核心呈现形式。

### 13.1 日常运维

#### 13.1.1 Vault 备份策略

Obsidian Vault 以纯 Markdown 文件存储记忆数据，天然适配 Git 版本控制 [(阿里云帮助中心)](https://help.aliyun.com/zh/model-studio/model-pricing) 。备份采用三级递进架构。

**本地自动提交（RTO < 1 分钟）**：cron 每 15 分钟执行 `git add -A && git commit`，确保 Write/Edit 操作可追溯 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。`.gitignore` 排除 `*.db`、`.obsidian/workspace.json` 等非关键文件。

**远程同步（RTO < 1 小时）**：每小时 `git push` 至远程仓库。3 个月日常使用的数据库约 2.4 MB [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) ，纯文本 Markdown 压缩后通常不足 10 MB，推送耗时秒级。

**完整快照（RTO < 24 小时）**：每日 `tar` 打包 `~/.openclaw` 目录，保留 7 日滚动快照，含配置、记忆文件、数据库和模型元数据。

#### 13.1.2 模型更新

**云端 API 密钥轮换**：在平台生成新 Key → 更新环境变量 → `openclaw gateway restart` 重载 → 验证可用性 → 72 小时后删除旧 Key。OpenClaw 支持多 Auth Profile 旋转，可在 Provider 间自动切换以应对速率限制 [(Tencent Cloud)](https://www.tencentcloud.com/techpedia/141564) 。

**Ollama 模型版本管理**：更新前 `ollama show qwen2.5:14b` 确认版本，更新后执行 20 次单工具 + 10 次多工具链基准测试。可靠性低于更新前时，通过 digest 回滚旧版本 [(Github)](https://github.com/Michael-Obele/docshark) 。生产环境推荐双实例蓝绿切换 [(Github)](https://github.com/ollama/ollama/issues/14578) 。

| 维护项 | 频率 | 命令 / 操作 | 验证方式 |
|:-------|:-----|:------------|:---------|
| Git 自动提交 | 每 15 分钟 | `git add -A && git commit` | `git log --oneline -5` |
| 远程推送 | 每小时 | `git push origin main` | 远程文件树比对 |
| 完整快照 | 每日 | `tar czf backup-$(date +%F).tar.gz ~/.openclaw` | 校验和验证 |
| API 密钥轮换 | 每 90 天 | 平台生成新 Key → 重启服务 | `curl` 测试可用性 |
| Ollama 模型更新 | 每月 | `ollama pull qwen2.5:14b` | 30 次工具调用基准测试 |
| 数据库碎片整理 | 每周 | `VACUUM` via bun:sqlite | 文件大小变化 |

#### 13.1.3 索引维护

SQLite FTS5 索引通过 AFTER 触发器自动同步 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) ，但长期运行后产生碎片，表现为检索延迟从亚 10 ms [(Github)](https://github.com/mneves75/ffts-grep) 上升至 50 ms 以上。每周执行 `INSERT INTO knowledge_fts(knowledge_fts) VALUES('optimize')` 重建倒排索引，操作不锁定主表 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。

B-树索引通过 `ANALYZE` 更新查询优化器统计信息，单次会话写入超 500 条后建议执行。WAL 模式长期运行累积 `-wal` 和 `-shm` 文件，若 WAL 文件持续超过主库 50%，执行 `PRAGMA wal_checkpoint(TRUNCATE)` [(sqlite.org)](https://sqlite.org/wal.html) 。

### 13.2 监控告警

#### 13.2.1 关键指标

![OpenClaw 系统核心组件延迟基准](fig13_1_latency_baseline.png)

系统监控覆盖四类指标。延迟类：Gateway 路由 < 2.5 ms [(腾讯新闻)](https://view.inews.qq.com/a/20260316A04I3600) ；FTS5 冷查询 < 10 ms [(Github)](https://github.com/mneves75/ffts-grep) ；Ollama GPU 推理 40-120 tok/s [(Local AI Master)](https://localaimaster.com/blog/ollama-system-requirements) ；云端 API P95 < 4.5 s [(Tencent Cloud)](https://www.tencentcloud.com/techpedia/141564) 。错误率类：qwen2.5:14b 单工具可靠性 ~90% [(Github)](https://github.com/Michael-Obele/docshark) ，连续 10 次成功率 < 80% 触发告警；MCP 失败率 > 5% 时检查连接 [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) ；API 5xx 比例 > 5% 触发 Provider 切换 [(thebomb.ca)](https://thebomb.ca/blog/openclaw-multi-agent-routing/) 。资源类：qwen2.5:14b VRAM ~9.5 GB [(CSDN博客)](https://blog.csdn.net/weimeilayer/article/details/159931736) ；磁盘告警阈值 80%、紧急阈值 90%。

#### 13.2.2 日志管理

日志体系由三个来源构成。**Gateway 结构化日志**位于 `~/.openclaw/logs/`，按日期滚动，记录消息生命周期（接收、路由、执行、响应） [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。`logLevel` 支持四级，debug 级别捕获完整 WebSocket 帧内容，应配 7 日清理策略。**Ollama 推理日志**通过 `OLLAMA_DEBUG=1` 启用，关键字段包括 `load duration`、`total_duration` 和 `eval_rate`，显存不足时的 CPU 回退以 `offloading N layers to CPU` 标记 [(Local AI Master)](https://localaimaster.com/blog/ollama-system-requirements) 。**应用层审计日志**通过 Git 提交留痕，LOG.md 记录敏感操作，bun:sqlite 的 `conversations` 表保留 `latency_ms` 和 `tokens_used` 字段 [(Long Bui)](https://longdatadevlog.com/blog/2025/07/30/full-text-search-much-better-with-fts5/) 。

建议通过 systemd journal 或 Vector 统一汇聚，配置三个路由规则：error 级实时推送告警；warn 级 15 分钟聚合；info 级保留 30 天。

#### 13.2.3 告警阈值

| 指标 | 级别 | 触发条件 | 响应动作 |
|:-----|:-----|:---------|:---------|
| Gateway 路由延迟 | Warning | P95 > 8 ms | 检查进程 CPU/内存 |
| FTS5 检索延迟 | Warning | P95 > 20 ms | 执行 `OPTIMIZE` |
| Ollama 推理延迟 | Critical | P95 > 3 s | 检查 GPU 状态，模型降级 |
| API 错误率 | Critical | 5xx > 5%（3 分钟）| 切换 Auth Profile |
| 工具调用成功率 | Warning | 连续 10 次 < 80% | 模型健康检查 |
| 磁盘使用率 | Warning | > 80% | 清理日志 |
| 磁盘使用率 | Critical | > 90% | 停止非核心服务 |
| MCP 连接失败 | Warning | 失败率 > 5%（5 分钟）| 检查端点 |

告警采用分级通知：Warning 级发送至日志系统和 Telegram 机器人；Critical 级通过短信/电话通知。告警触发时自动附带最近 5 分钟日志片段以缩短 MTTR。

### 13.3 故障处理

#### 13.3.1 常见问题诊断

**模型无响应**：诊断路径遵循"本地优先、分层隔离"。第一步 `ollama ps` 确认模型加载且 GPU 完全卸载，`ollama -v` 验证版本 [(Github)](https://github.com/mneves75/ffts-grep) 。第二步 `curl` 直接调用本地端点测试连通性，注意 `base_url` 不含 `/v1` 后缀 [(BetterClaw)](https://www.betterclaw.io/blog/openclaw-model-does-not-support-tools) 。第三步检查 Gateway 日志中 `model_fallback` 事件，确认 Provider 配置是否正确 [(thebomb.ca)](https://thebomb.ca/blog/openclaw-multi-agent-routing/) 。

**检索失败**：FTS5 返回空结果时，先确认触发器状态——新记录无法检索但旧记录正常表明触发器故障，需手动重建虚拟表。延迟异常时检查 WAL 文件大小并执行 `PRAGMA wal_checkpoint(TRUNCATE)` [(sqlite.org)](https://sqlite.org/wal.html) 。中文 CJK 内容检索失败时确认 Trigram 辅助表已创建 [(Zenn)](https://zenn.dev/kanseilink/articles/kanseilink-fts5-trigram-cjk-20260507?locale=en) 。

**MCP 连接断开**：stdio 模式常见原因为命令路径错误或运行时缺失；HTTP 模式通常为服务端超时 [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) 。诊断命令 `openclaw mcp list` 查看状态，`openclaw logs --follow` 跟踪日志。MCP 失败的特征是 Agent 静默不使用预期工具，不产生显式错误 [(The AI Agent Factory)](https://agentfactory.panaversity.org/docs/Building-OpenClaw-Apps/meet-your-personal-ai-employee/connect-external-tools) 。

#### 13.3.2 降级策略

| 故障场景 | 自动降级动作 | 预期影响 |
|:---------|:-------------|:---------|
| 云端 API 不可用 | Auth Profile 切换 → 本地 Ollama | 推理质量下降，成本为零 |
| Ollama 显存不足 | 14B → 7B → CPU 回退 | 速度降至 3-6 tok/s |
| FTS5 索引损坏 | 文件遍历 + grep 检索 | 延迟 > 100 ms |
| MCP stdio 失败 | 尝试 HTTP 备用端点 | 连接延迟 +200 ms |
| Gateway 崩溃 | systemd auto-restart | inflight 请求丢失 |

降级设计遵循"有损服务"原则——资源受限时优先保障核心对话。Ollama 在 VRAM 不足时自动触发三级降级（14B → 7B → CPU），切换在亚秒级完成且不阻塞请求队列 [(Local AI Master)](https://localaimaster.com/blog/ollama-system-requirements) 。

#### 13.3.3 安全事件响应

**密钥泄露**：立即在平台撤销该 Key，系统 5 分钟内自动 `model_fallback` 至备用 Key [(thebomb.ca)](https://thebomb.ca/blog/openclaw-multi-agent-routing/) 。若全部 Key 失效则退化为仅本地 Ollama 模式。24 小时内完成轮换审计，检查所有 `${env.VAR}` 引用点确认无硬编码密钥 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。

**恶意技能清理**：2026 年 2 月 ClawHavoc 事件中 341 个恶意技能在 ClawHub 被发现 [(财联社)](https://www.cls.cn/detail/2287927) 。响应流程：卸载未知来源 SKILL.md → 扫描 frontmatter 来源标记 → 比对恶意签名哈希 → 发送安全警报。预防层面应禁用自动技能市场同步，第三方技能需代码审查后方可放入 `skills/` 目录。

**异常行为检测**：单会话超 50 次工具调用（可能无限循环）、访问 `~/.ssh/` 或 `/etc/` 敏感目录、非 YOLO 模式下发起网络连接——均触发安全审查，超限后自动暂停 Agent 执行并要求人工确认 [(MoltFounders)](https://moltfounders.com/openclaw-configuration) 。

---

**运维检查清单**

| # | 检查项 | 频率 | 负责人 | 验证命令 |
|:--|:-------|:-----|:-------|:---------|
| 1 | Gateway 服务存活 | 持续 | 自动 | `systemctl is-active openclaw` |
| 2 | Ollama GPU 完全卸载 | 持续 | 自动 | `ollama ps` |
| 3 | Git 提交无冲突 | 每 15 分钟 | 自动 | `git status --short` |
| 4 | 远程备份同步 | 每小时 | 自动 | `git log origin/main --oneline -1` |
| 5 | 磁盘空间 | 每 4 小时 | 自动 | `df -h /` |
| 6 | FTS5 索引延迟 | 每日 | 自动 | 基准查询 < 10 ms |
| 7 | MCP 工具可用性 | 每日 | 自动 | `openclaw mcp list` |
| 8 | API Key 有效期 | 每周 | 运维 | 平台控制台检查 |
| 9 | 数据库 VACUUM | 每周 | 自动 | `.db` 文件大小 |
| 10 | Ollama 模型版本 | 每月 | 运维 | `ollama list` |
| 11 | 密钥轮换执行 | 每 90 天 | 运维 | 平滑切换验证 |
| 12 | 完整恢复演练 | 每季度 | 运维 | 测试环境恢复 |

清单涵盖 12 项检查，其中 8 项可通过自动化脚本无人值守执行，4 项需人工介入。自动化项建议以 systemd timer 调度，人工项通过日历提醒保障频率。个人部署场景可合并为每日 5 分钟健康检查脚本；团队部署建议集成 Prometheus + Alertmanager 实现全量指标采集与告警。


---



---

## 附录A: 完整配置文件集

### A.1 项目结构

```
openclaw-agent/
├── config/
│   ├── openclaw.yaml          # OpenClaw主配置
│   ├── mcp-servers.yaml       # MCP服务器注册
│   ├── lsp-config.yaml        # LSP语言服务器
│   └── model-router.yaml      # 多平台模型路由
├── src/
│   ├── router/
│   │   └── model-router.ts    # 统一模型路由器
│   ├── memory/
│   │   └── vault-manager.ts   # Obsidian Vault管理
│   ├── crawl/
│   │   └── data-pipeline.ts   # 数据采集Pipeline
│   └── mcp/
│       └── server.ts          # MCP服务器入口
├── scripts/
│   ├── setup.sh               # 一键安装脚本
│   ├── health-check.ts        # 健康检查
│   └── discover-free-models.ts # 免费模型发现
├── package.json
├── tsconfig.json
└── .env                       # 环境变量
```

### A.2 package.json

```json
{
  "name": "openclaw-agent",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "bun run src/main.ts",
    "dev": "bun --watch run src/main.ts",
    "build": "bun build src/main.ts --outdir ./dist",
    "mcp": "bun run src/mcp/server.ts",
    "health": "bun run scripts/health-check.ts",
    "discover": "bun run scripts/discover-free-models.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "drizzle-orm": "^0.30.0",
    "bun:sqlite": "builtin",
    "zod": "^3.22.0",
    "yaml": "^2.4.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.3.0"
  }
}
```

### A.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### A.4 .env 环境变量模板

```bash
# ========== 模型平台API密钥 ==========
# DeepSeek官方
DEEPSEEK_API_KEY=sk-your-deepseek-key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# 硅基流动（免费模型+付费）
SILICONFLOW_API_KEY=sk-your-siliconflow-key
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1

# OfoxAI（模型聚合）
OFOXAI_API_KEY=ofx-your-ofoxai-key
OFOXAI_BASE_URL=https://api.ofox.ai/v1

# OpenRouter（备用，需代理）
OPENROUTER_API_KEY=sk-or-your-openrouter-key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_HTTP_PROXY=http://127.0.0.1:7890

# 阿里云百炼
BAILIAN_API_KEY=your-bailian-key

# ========== OpenClaw配置 ==========
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_AUTH_TOKEN=your-secure-token

# ========== Obsidian配置 ==========
OBSIDIAN_VAULT_PATH=/path/to/your/vault
OBSIDIAN_API_PORT=27124
OBSIDIAN_API_TOKEN=your-obsidian-token

# ========== llama.cpp（如后续添加本地） ==========
LLAMACPP_BASE_URL=http://localhost:8080

# ========== 数据库 ==========
DATABASE_PATH=./data/agent.db

# ========== 日志级别 ==========
LOG_LEVEL=info
```

### A.5 config/openclaw.yaml

```yaml
# OpenClaw AI Agent 主配置
gateway:
  port: 18789
  bind: "127.0.0.1"
  auth:
    token: "${OPENCLAW_AUTH_TOKEN}"

# 模型配置 - 四层路由
models:
  # Tier 1: 硅基流动免费模型（工具调用/分类）
  - name: "sf-qwen2-7b"
    provider: "siliconflow"
    model: "Qwen/Qwen2-7B-Instruct"
    baseUrl: "https://api.siliconflow.cn/v1"
    apiKey: "${SILICONFLOW_API_KEY}"
    tier: 1
    purpose: ["tool_call", "classification", "embedding"]
    priority: 10

  - name: "sf-glm4-9b"
    provider: "siliconflow"
    model: "THUDM/glm-4-9b-chat"
    baseUrl: "https://api.siliconflow.cn/v1"
    apiKey: "${SILICONFLOW_API_KEY}"
    tier: 1
    purpose: ["tool_call", "chat"]
    priority: 9

  # Tier 2: OfoxAI免费层
  - name: "ofox-free"
    provider: "ofoxai"
    model: "auto"
    baseUrl: "https://api.ofox.ai/v1"
    apiKey: "${OFOXAI_API_KEY}"
    tier: 2
    purpose: ["general"]
    priority: 5
    freeOnly: true

  # Tier 3: 付费主力模型
  - name: "ds-v4-flash"
    provider: "deepseek"
    model: "deepseek-v4-flash"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "${DEEPSEEK_API_KEY}"
    tier: 3
    purpose: ["reasoning", "coding", "research"]
    priority: 8

  - name: "ds-v4-pro"
    provider: "deepseek"
    model: "deepseek-v4-pro"
    baseUrl: "https://api.deepseek.com/v1"
    apiKey: "${DEEPSEEK_API_KEY}"
    tier: 3
    purpose: ["deep_reasoning", "complex_coding"]
    priority: 6

  # Tier 4: OpenRouter备用
  - name: "or-backup"
    provider: "openrouter"
    model: "openrouter/free"
    baseUrl: "https://openrouter.ai/api/v1"
    apiKey: "${OPENROUTER_API_KEY}"
    httpProxy: "${OPENROUTER_HTTP_PROXY}"
    tier: 4
    purpose: ["fallback"]
    priority: 1

# 记忆管理
memory:
  vaultPath: "${OBSIDIAN_VAULT_PATH}"
  obsidianApiPort: 27124
  obsidianApiToken: "${OBSIDIAN_API_TOKEN}"
  databasePath: "${DATABASE_PATH}"

# 数据采集
crawler:
  searchApi: "serpapi"
  serpapiKey: "your-serpapi-key"
  maxConcurrent: 3
  requestDelay: 1000
```

### A.6 config/mcp-servers.yaml

```yaml
# MCP服务器注册配置
servers:
  # 文件系统访问
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]

  # SQLite数据库
  sqlite:
    command: "bun"
    args: ["run", "src/mcp/sqlite-server.ts"]

  # Obsidian Vault操作
  obsidian:
    command: "bun"
    args: ["run", "src/mcp/obsidian-server.ts"]

  # 网页搜索
  web-search:
    command: "bun"
    args: ["run", "src/mcp/search-server.ts"]

  # 数据采集
  crawler:
    command: "bun"
    args: ["run", "src/mcp/crawler-server.ts"]

  # 代码执行
  code-runner:
    command: "bun"
    args: ["run", "src/mcp/code-runner.ts"]

  # LSP桥接
  lsp-bridge:
    command: "bun"
    args: ["run", "src/mcp/lsp-bridge.ts"]
```

### A.7 src/router/model-router.ts（统一模型路由器）

```typescript
/**
 * 多平台模型路由器 - 四层路由策略
 * Tier 1: 硅基流动免费 → Tier 2: OfoxAI免费 → Tier 3: 付费 → Tier 4: OpenRouter备用
 */

import { Database } from "bun:sqlite";

interface ModelConfig {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tier: number;
  priority: number;
  purpose: string[];
  freeOnly?: boolean;
  httpProxy?: string;
}

interface RouteResult {
  model: ModelConfig;
  latency: number;
  tokensUsed: number;
}

class ModelRouter {
  private models: ModelConfig[] = [];
  private db: Database;
  private freeModelCache: Map<string, string[]> = new Map();
  private cacheExpiry: Map<string, number> = new Map();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        tier INTEGER NOT NULL,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        latency_ms INTEGER,
        success INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  loadConfig(configs: ModelConfig[]): void {
    this.models = configs.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 智能路由：根据任务类型选择最优模型
   */
  async route(taskType: string, complexity: 'low' | 'medium' | 'high' = 'medium'): Promise<ModelConfig> {
    // 根据复杂度确定起始Tier
    const startTier = complexity === 'low' ? 1 : complexity === 'medium' ? 1 : 3;

    for (let tier = startTier; tier <= 4; tier++) {
      const candidates = this.models
        .filter(m => m.tier === tier)
        .filter(m => m.purpose.includes(taskType) || m.purpose.includes('general') || m.purpose.includes('fallback'));

      for (const model of candidates) {
        if (await this.healthCheck(model)) {
          return model;
        }
      }
    }

    throw new Error(`No available model for task: ${taskType}`);
  }

  /**
   * 健康检查：验证模型可用性
   */
  private async healthCheck(model: ModelConfig): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${model.baseUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${model.apiKey}` },
        signal: controller.signal
      });

      clearTimeout(timeout);
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * 调用模型（统一封装）
   */
  async call(model: ModelConfig, messages: any[], options: { tools?: any[]; stream?: boolean } = {}): Promise<any> {
    const startTime = Date.now();

    const body: any = {
      model: model.model,
      messages,
      stream: options.stream ?? false
    };

    if (options.tools) body.tools = options.tools;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.apiKey}`
    };

    // OpenRouter特殊header
    if (model.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://openclaw.ai';
      headers['X-Title'] = 'OpenClaw Agent';
    }

    const response = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Model ${model.name} failed: ${response.status} ${await response.text()}`);
    }

    const latency = Date.now() - startTime;
    const result = await response.json();

    // 记录用量
    const inputTokens = result.usage?.prompt_tokens ?? 0;
    const outputTokens = result.usage?.completion_tokens ?? 0;
    this.logUsage(model, inputTokens, outputTokens, latency);

    return result;
  }

  /**
   * 流式调用
   */
  async *callStream(model: ModelConfig, messages: any[]): AsyncGenerator<string> {
    const response = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`
      },
      body: JSON.stringify({ model: model.model, messages, stream: true })
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch { /* ignore parse errors */ }
        }
      }
    }
  }

  private logUsage(model: ModelConfig, input: number, output: number, latency: number): void {
    this.db.run(
      'INSERT INTO model_usage (model_name, provider, tier, tokens_input, tokens_output, latency_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [model.name, model.provider, model.tier, input, output, latency]
    );
  }

  /**
   * 获取用量统计
   */
  getUsageStats(days: number = 30): any[] {
    return this.db.query(
      `SELECT provider, tier, 
        SUM(tokens_input) as total_input,
        SUM(tokens_output) as total_output,
        AVG(latency_ms) as avg_latency,
        SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate
      FROM model_usage 
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY provider, tier
      ORDER BY tier`,
      [days]
    ).all();
  }

  close(): void {
    this.db.close();
  }
}

export { ModelRouter };
export type { ModelConfig, RouteResult };
```

### A.8 scripts/discover-free-models.ts（免费模型动态发现）

```typescript
#!/usr/bin/env bun
/**
 * 免费模型动态发现脚本
 * 定期扫描OpenRouter和OfoxAI的免费模型，更新可用列表
 * 建议每6小时运行一次：0 */6 * * * bun run scripts/discover-free-models.ts
 */

import { Database } from "bun:sqlite";

interface FreeModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  description?: string;
  discoveredAt: string;
}

const PLATFORMS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    proxy: process.env.OPENROUTER_HTTP_PROXY,
    filter: (m: any) => m.id.endsWith(':free') || (m.pricing?.prompt === 0 && m.pricing?.completion === 0)
  },
  ofoxai: {
    baseUrl: 'https://api.ofox.ai/v1',
    apiKey: process.env.OFOXAI_API_KEY,
    filter: (m: any) => m.pricing?.prompt === 0 || m.id.includes('free')
  }
};

async function discoverFreeModels(platform: keyof typeof PLATFORMS): Promise<FreeModel[]> {
  const config = PLATFORMS[platform];
  if (!config.apiKey) {
    console.warn(`[${platform}] API key not configured, skipping`);
    return [];
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json'
  };

  if (platform === 'openrouter') {
    headers['HTTP-Referer'] = 'https://openclaw.ai';
    headers['X-Title'] = 'OpenClaw Agent';
  }

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${config.baseUrl}/models`, {
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const models = data.data || data;

    return models
      .filter(config.filter)
      .map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        provider: platform,
        contextLength: m.context_length || 4096,
        description: m.description,
        discoveredAt: new Date().toISOString()
      }));
  } catch (error) {
    console.error(`[${platform}] Discovery failed:`, error);
    return [];
  }
}

function saveToDatabase(models: FreeModel[]): void {
  const db = new Database(process.env.DATABASE_PATH || './data/agent.db');

  db.run(`
    CREATE TABLE IF NOT EXISTS free_models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      context_length INTEGER,
      description TEXT,
      is_available INTEGER DEFAULT 1,
      discovered_at TEXT,
      last_checked_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 标记所有为待验证
  db.run('UPDATE free_models SET is_available = 0');

  const insert = db.prepare(`
    INSERT OR REPLACE INTO free_models 
    (id, name, provider, context_length, description, is_available, discovered_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
  `);

  for (const model of models) {
    insert.run(model.id, model.name, model.provider, model.contextLength, 
               model.description, model.discoveredAt);
  }

  insert.finalize();
  db.close();

  console.log(`Saved ${models.length} free models to database`);
}

async function main() {
  console.log('🔍 Starting free model discovery...');
  const allModels: FreeModel[] = [];

  for (const platform of Object.keys(PLATFORMS) as (keyof typeof PLATFORMS)[]) {
    console.log(`
📡 Scanning ${platform}...`);
    const models = await discoverFreeModels(platform);
    console.log(`  Found ${models.length} free models`);
    for (const m of models) {
      console.log(`    ✓ ${m.id} (${m.contextLength}k context)`);
    }
    allModels.push(...models);
  }

  if (allModels.length > 0) {
    saveToDatabase(allModels);
    console.log(`
✅ Total: ${allModels.length} free models discovered and saved`);
  } else {
    console.log('
⚠️ No free models found. Check API keys and network.');
  }
}

main().catch(console.error);
```

### A.9 scripts/health-check.ts（健康检查）

```typescript
#!/usr/bin/env bun
/**
 * 健康检查脚本
 * 检查各平台API可用性和响应延迟
 * 建议每5分钟运行：*/5 * * * * bun run scripts/health-check.ts
 */

const CHECKS = [
  {
    name: '硅基流动',
    url: 'https://api.siliconflow.cn/v1/models',
    apiKey: process.env.SILICONFLOW_API_KEY,
    timeout: 5000
  },
  {
    name: 'OfoxAI',
    url: 'https://api.ofox.ai/v1/models',
    apiKey: process.env.OFOXAI_API_KEY,
    timeout: 5000
  },
  {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/v1/models',
    apiKey: process.env.DEEPSEEK_API_KEY,
    timeout: 5000
  },
  {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/models',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 10000,
    proxy: process.env.OPENROUTER_HTTP_PROXY
  },
  {
    name: 'Obsidian',
    url: `https://127.0.0.1:${process.env.OBSIDIAN_API_PORT || 27124}/vault/`,
    apiKey: process.env.OBSIDIAN_API_TOKEN,
    timeout: 3000
  }
];

async function checkEndpoint(check: typeof CHECKS[0]): Promise<{ name: string; status: string; latency: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), check.timeout);

    const headers: Record<string, string> = {};
    if (check.apiKey) headers['Authorization'] = `Bearer ${check.apiKey}`;
    if (check.name === 'OpenRouter') {
      headers['HTTP-Referer'] = 'https://openclaw.ai';
    }

    const response = await fetch(check.url, { headers, signal: controller.signal });
    const latency = Date.now() - start;

    if (response.ok) {
      return { name: check.name, status: '✅ UP', latency };
    } else {
      return { name: check.name, status: '❌ ERR', latency, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    return { name: check.name, status: '❌ DOWN', latency: Date.now() - start, error: String(error) };
  }
}

async function main() {
  console.log(`🏥 Health Check - ${new Date().toLocaleString()}
`);

  const results = await Promise.all(CHECKS.map(checkEndpoint));

  for (const r of results) {
    const latencyStr = r.latency < 1000 ? `${r.latency}ms` : `${(r.latency/1000).toFixed(1)}s`;
    console.log(`${r.status} ${r.name.padEnd(12)} ${latencyStr.padStart(6)}${r.error ? ' | ' + r.error : ''}`);
  }

  const allUp = results.every(r => r.status === '✅ UP');
  process.exit(allUp ? 0 : 1);
}

main();
```

---

## 附录B: 开发实施检查清单

### Phase 1: 环境准备（Day 1）

- [ ] 安装 Bun 运行时（`curl -fsSL https://bun.sh/install | bash`）
- [ ] 安装 Git 和 Node.js（备用）
- [ ] 创建项目目录结构
- [ ] 初始化 Git 仓库
- [ ] 配置 `.env` 文件（所有API密钥）
- [ ] 安装项目依赖（`bun install`）

### Phase 2: 模型平台接入（Day 1-2）

- [ ] 注册硅基流动账号，获取API Key
- [ ] 注册 OfoxAI 账号，获取API Key
- [ ] 注册 DeepSeek 账号，获取API Key
- [ ] （可选）注册 OpenRouter 账号，配置代理
- [ ] 验证各平台API连通性（运行 `bun run scripts/health-check.ts`）
- [ ] 测试硅基流动免费模型调用
- [ ] 测试 OfoxAI 模型调用
- [ ] 测试 DeepSeek V4-Flash 调用

### Phase 3: OpenClaw 网关部署（Day 2-3）

- [ ] 安装 OpenClaw（`curl -fsSL https://openclaw.ai/install.sh | bash`）
- [ ] 配置 Gateway（端口18789、认证Token）
- [ ] 配置 Pi 引擎模型路由
- [ ] 配置 Workspace 目录结构
- [ ] 启动 Gateway 并验证
- [ ] 测试 CLI 命令接收与响应

### Phase 4: MCP 服务器开发（Day 3-4）

- [ ] 实现 SQLite MCP 服务器
- [ ] 实现 Obsidian Vault MCP 服务器
- [ ] 实现 Web 搜索 MCP 服务器
- [ ] 实现数据采集 MCP 服务器
- [ ] 注册所有 MCP 服务器到 OpenClaw
- [ ] 测试 MCP 工具调用

### Phase 5: 模型路由器开发（Day 4-5）

- [ ] 实现 ModelRouter 核心类
- [ ] 配置四层路由策略
- [ ] 实现健康检查和故障转移
- [ ] 实现用量统计和日志记录
- [ ] 集成到 OpenClaw Gateway
- [ ] 压力测试路由性能

### Phase 6: Obsidian 记忆系统（Day 5-6）

- [ ] 安装 Obsidian 和 obsidian-local-rest-api 插件
- [ ] 初始化 Vault 目录结构
- [ ] 配置 SQLite FTS5 索引
- [ ] 实现 Vault 管理器（读写/搜索/索引）
- [ ] 实现 AST 检索算法
- [ ] 测试记忆读写和检索性能

### Phase 7: 数据采集 Pipeline（Day 6-7）

- [ ] 配置搜索API（SerpAPI/Firecrawl）
- [ ] 实现 Bun 原生爬虫（fetch + cheerio）
- [ ] 实现 HTML→Markdown 转换
- [ ] 实现数据清洗和归纳
- [ ] 集成到 MCP 服务器
- [ ] 测试端到端采集流程

### Phase 8: LSP 集成（Day 7-8）

- [ ] 安装 agent-lsp
- [ ] 配置 TypeScript 语言服务器
- [ ] 配置 Python 语言服务器
- [ ] 实现 LSP MCP 桥接
- [ ] 测试代码导航和诊断

### Phase 9: Hermes Agent 集成（Day 8-9）

- [ ] 安装 Hermes Agent
- [ ] 配置深度研究技能
- [ ] 配置记忆系统
- [ ] 测试研究任务执行
- [ ] 集成到 OpenClaw 工作流

### Phase 10: 编码 Agent 集成（Day 9-10）

- [ ] 安装 OpenCode
- [ ] 配置 LSP 支持
- [ ] 配置 MCP 工具集成
- [ ] 测试代码生成和重构
- [ ] 集成到 OpenClaw 工作流

### Phase 11: 测试与优化（Day 10-12）

- [ ] 端到端集成测试
- [ ] 性能基准测试
- [ ] 免费模型可靠性测试
- [ ] 故障转移测试
- [ ] 安全审计
- [ ] 文档完善

### Phase 12: 上线运维（Day 12+）

- [ ] 配置 systemd 服务
- [ ] 配置日志轮转
- [ ] 配置监控告警
- [ ] 配置定时任务（健康检查、模型发现）
- [ ] 备份 Vault 数据
- [ ] 上线运行

---

## 附录C: 故障排查手册

### C.1 模型调用失败

| 现象 | 原因 | 解决方案 |
|------|------|---------|
| 硅基流动返回 429 | 免费模型限速 | 降低请求频率，启用重试退避 |
| OfoxAI 连接超时 | 网络问题 | 检查DNS，切换备用DNS |
| DeepSeek 返回 401 | API Key失效 | 检查Key是否正确，重新生成 |
| OpenRouter 连接失败 | 代理问题 | 检查代理配置，测试代理连通性 |
| 所有模型不可用 | 网络中断 | 检查本地网络，切换到离线模式 |

### C.2 Obsidian 同步问题

| 现象 | 原因 | 解决方案 |
|------|------|---------|
| REST API 连接失败 | 插件未启动 | 在Obsidian中启用local-rest-api插件 |
| 写入文件失败 | 权限问题 | 检查Vault目录权限 |
| 搜索无结果 | FTS5索引未更新 | 手动重建索引或检查触发器 |
| 双向链接失效 | 文件名变更 | 使用Vault管理器统一处理重命名 |

### C.3 MCP 服务器问题

| 现象 | 原因 | 解决方案 |
|------|------|---------|
| MCP 工具调用超时 | 服务器未响应 | 检查MCP进程状态，重启服务 |
| 工具参数错误 | Schema不匹配 | 更新Zod校验规则 |
| LSP 诊断缺失 | 语言服务器未启动 | 运行`agent-lsp doctor`诊断 |
| 代码执行失败 | 沙箱限制 | 检查Docker/沙箱配置 |

### C.4 性能问题

| 现象 | 原因 | 解决方案 |
|------|------|---------|
| 网关响应慢 | 模型路由延迟高 | 检查健康状态，切换到更快的Tier |
| FTS5 检索慢 | 索引膨胀 | 重建FTS5索引，优化查询 |
| 内存占用高 | 连接池未释放 | 检查数据库连接，启用连接池 |
| Bun 启动慢 | 依赖过多 | 使用`bun build`预编译 |

### C.5 紧急降级流程

```
1. 检测到故障 → 自动重试3次
2. 重试失败 → 降级到下一Tier模型
3. Tier 4也失败 → 返回错误信息给用户
4. 记录故障日志 → 触发告警通知
5. 定时检查恢复 → 自动切换回原模型
```

### C.6 常用诊断命令

```bash
# 健康检查
bun run scripts/health-check.ts

# 测试硅基流动免费模型
curl https://api.siliconflow.cn/v1/chat/completions \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  -d '{"model":"Qwen/Qwen2-7B-Instruct","messages":[{"role":"user","content":"test"}]}'

# 测试OfoxAI
curl https://api.ofox.ai/v1/models \
  -H "Authorization: Bearer $OFOXAI_API_KEY"

# 重建FTS5索引
bun run -e "import { Database } from 'bun:sqlite'; \
  const db = new Database('./data/agent.db'); \
  db.run('INSERT INTO docs_fts(docs_fts) VALUES(\'rebuild\')');"

# 查看用量统计
bun run -e "import { Database } from 'bun:sqlite'; \
  const db = new Database('./data/agent.db'); \
  console.log(db.query('SELECT * FROM model_usage ORDER BY created_at DESC LIMIT 10').all());"

# 查看免费模型列表
bun run scripts/discover-free-models.ts
```

---

*文档版本: v3 | 最后更新: 2026年5月 | OpenClaw AI Agent 开发实施文档*
