# Axiom 前端审美修复 + 协议兼容覆盖 Spec（2026-08-11）

> 状态：实施中（Phase 1：协议研究 + 文档沉淀 + 前端 P0 修复）
> 分支：codex/frontend-aesthetic-repair
> 关联：docs/AUDIT-2026-08-11.md、docs/PROTOCOL-COMPATIBILITY-2026-08-11.md、docs/plans/2026-08-11-frontend-aesthetic-repair.md、skills/axiom-frontend-ui-repair/SKILL.md

## 1. 摘要

以 2026-08-11 全面审核报告为基线，完成三件事：
1. 拉取各大 AI 供应商文档，确定**协议兼容覆盖矩阵**（目标是：支持尽量多供应商，代码零硬编码，用户自配 key/模型/baseUrl）；
2. 沉淀阶段性文档（本 spec、实施计划、项目 skill），用 frontend-design / UI-UX / 工程实践类 skill 的规范指导后续修复；
3. 按 writing-plans 生成任务点并**开始修复前端 P0 批**（主题、Plugins 崩溃、语义色、移动端布局、数据真实性）。

## 2. 目标（本 spec 确认的工作目标）

- G1 协议最大覆盖：以 **OpenAI 兼容 REST（/v1/chat/completions + SSE + function calling + /v1/embeddings）为统一推理协议**，MCP（stdio + Streamable HTTP）承载工具面；Anthropic /v1/messages 为可选加分面。目标覆盖：OpenAI、Anthropic（经网关）、Gemini（经 OpenAI 兼容面或直连）、DeepSeek、SiliconFlow、Zhipu、Moonshot、MiniMax、OpenRouter、NVIDIA NIM、Mistral、xAI、Together、Groq、Ollama、llama.cpp、LM Studio。
- G2 用户自配置：所有 key 走 .env / Providers 页；模型名与 baseUrl 走 config YAML + env 覆盖；代码零硬编码（分阶段收敛）。
- G3 前端体验：双主题（暗/浅）都具备**动态背景**且可降级；动画**可实现、速度快、切换丝滑**（transform/opacity-only、reduced-motion、暂停策略）；修复 P0 批。
- G4 工程纪律：遵守 AGENTS.md 规则 1/2/3/5/8/11（最小施工、备份、提交、留痕、深模块、凭据本地化）。

## 3. 范围

本期（Phase 1）：
- 协议研究结论文档（PROTOCOL-COMPATIBILITY-2026-08-11.md）；
- 审计报告、spec、实施计划、项目 skill 入库；
- 前端 P0 批修复：F1 默认主题 / F2 Plugins 崩溃 / F3 Button 语义色 / F4 BottomNav / F5 key 冲突，外加 Router/Code 状态真实性；
- 前端测试 + lint + 真实渲染验证。

后续阶段（Phase 2+，不在本期）：
- 后端配置断链三件套 + POST /config 鉴权 + yaml-loader 模板化；
- 动态背景治理（8 层→3-4 层 + 帧率自适应 + WebGL 可选）；
- 移动端全量治理（44px 触摸目标、10px 字号）；
- 幽灵复杂度归档、model-router 单端口化、DRE 身份收敛、CI 修复。

## 4. 验收标准（可测量）

1. 协议矩阵文档列出 ≥14 家供应商的端点/认证/兼容性，并给出「最小协议覆盖 = OpenAI 兼容 + MCP」的结论与依据。
2. 默认打开应用为深色主题；浅色用户首屏无 dark→light 闪烁；Login 与其余页面主题一致。
3. Plugins 页在后端不可用时渲染空态而非崩溃（无 console 错误）。
4. danger/success 按钮在暗色下 hover 文字可读（非白字白底）。
5. BottomNav 移动端激活指示条位于当前项顶部。
6. 迷你聊天连续发送消息无重复 key 告警。
7. Router 全挂显示「未知」而非 ok；Code 状态卡按 status 映射颜色。
8. frontend 全量 vitest 通过；tsc --noEmit 通过。
9. 操作留痕：docs/operations-log.md 有对应记录，提交推送到 internal211。

## 5. 协议兼容矩阵（研究后定稿）

> 详见 docs/PROTOCOL-COMPATIBILITY-2026-08-11.md。核心结论（研究初步）：
> - 全部主流云供应商均提供 OpenAI 兼容端点（OpenAI 原生、Anthropic 原生 Messages 除外，但各网关/自托管提供兼容面）；
> - 没有任何「必须非 OpenAI 协议」的长尾供应商；
> - 最大覆盖 = OpenAI 兼容 REST（chat/embeddings/models/SSE/function calling）+ MCP 双传输（stdio/Streamable HTTP）；
> - 加分面：Anthropic /v1/messages（NVIDIA NIM、LM Studio 已自带）、OpenAI /v1/responses（可选）。

## 6. 任务分解

- Task 1 默认主题修复（useApp.ts / index.html / 测试）
- Task 2 Plugins 崩溃修复（setMarketplace 形状守卫）
- Task 3 Button danger/success hover 修复（+ chat-panels 徽标）
- Task 4 BottomNav 定位修复
- Task 5 迷你聊天 key 修复（useRef）
- Task 6 Router / Code 状态真实性
- Task 7 验证与提交
详细步骤见 docs/plans/2026-08-11-frontend-aesthetic-repair.md。

## 7. 原则与风险

- 最小施工：每项修复只动目标文件，不顺手重构（AGENTS.md 规则 1）。
- 深模块：协议适配收敛为单一接缝（provider adapter），不做投机抽象（规则 8）。
- 凭据：文档与代码只允许 ${VAR} 占位符（规则 11）。
- 风险：前端测试环境（jsdom）无 matchMedia，主题测试需显式 stub；真实渲染验证依赖浏览器通道（本会话沙箱曾 EPERM，必要时用 in-app Browser）。
