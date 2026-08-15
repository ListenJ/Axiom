# 前端视觉审核（Frontend Visual Review）— SenseNova 视觉模型

> 日期：2026-08-15 ｜ 位置：`src/computer-use/frontend-review.ts` ｜ MCP：`frontend_visual_review`

## 摘要

用 SenseNova 视觉模型（`sensenova-6.8-flash-lite`，多模态 text+image）对前端页面截图做**结构化视觉审核**，输出 JSON：
- `verdict`：pass / issues
- `findings[]`：`{ severity: critical|major|minor|info, area: layout|contrast|interaction|consistency|rendering, description, suggestion }`
- `summary`

审核维度：布局（重叠/溢出/截断/未对齐）、可读性（对比度/字号）、交互（可见可点/无遮挡）、一致性（间距/配色/字体）、渲染错误（空白/破损/样式未加载）。

## 密钥（规则 11：凭据不入库）
- 读取顺序：env `SENSENOVA_API_KEY` → `~/.axiom/axiom-secrets/sensenova.credentials`
- 仓库只保留占位符 `.env.example`（SENSENOVA_API_KEY / SENSENOVA_BASE_URL / SENSENOVA_VISION_MODEL）
- 真实密钥已存本地 `C:\Users\<user>\.axiom\axiom-secrets\sensenova.credentials`

## 使用
```bash
# 直接审核图片 base64
MCP: frontend_visual_review { imageBase64 }
# 审核 URL（CDP 截图 → 审核）
MCP: frontend_visual_review { url, cdpUrl }
# 代码
import { reviewFrontendScreenshot } from "src/computer-use/frontend-review.js";
```

## 模型注册
- provider `sensenova`（api-key-store + providers.ts + types.ts）
- 模型 `sensenova-6.8-flash-lite` / `sensenova-6.7-flash-lite`（registry.ts，tags 含 vision/multimodal/computer-use/frontend-review）
- 经 `findModelsForRole("computer-use")` 可被 computer-use agent 与前端审核复用

## 验证
- `tests/frontend-review.test.ts`（5）：多模态请求体、JSON/```json 解析、pass 空 findings、无 Key 抛错、key 解析
- 实时（真实模型）：审核诗歌截图 → `verdict=pass`，总结准确（文字清晰/对比度高/阶梯缩进），~14.5s
- root 套件 **2593 tests / 0 fail**

## 页面级审核流水线（2026-08-16 追加）

### 能力
`frontend_audit`：对一组前端页面**逐页截图 → SenseNova 视觉审核 → 汇总报告**（Markdown）。

- `src/computer-use/frontend-audit.ts`：`auditFrontendPages(baseUrl, pages, deps)` → `FrontendAuditReport`
  - 默认 9 个可见页（/chat /search /code /vault /providers /git /sessions /tokens /settings）
  - 截图默认走 **Playwright CLI**（Node 子进程）——**关键坑**：Playwright 在 Bun 运行时内 launch 会卡死（进程/管道握手差异），必须经 Node 子进程
  - `--wait-for-timeout=1500` 稳定等待（**关键坑**：无等待时慢页面会截成黑屏误报——实测 /settings 6KB→220KB）
  - 审核调用 `reviewFrontendScreenshot`（SenseNova），聚合 verdict/findings/severity 统计
- `scripts/frontend-audit.ts` CLI：`bun run audit:frontend --base-url=... [--pages=/chat,/x] [--concurrency=2] [--knowledge]`
  - 报告写入 `reports/frontend-audit-<ts>.md`；`--knowledge` 把 issues 写入知识库（domain=frontend-audit）
  - critical/major>0 时 exit 1（可作 CI 门禁）
- MCP 工具 `frontend_audit`

### 验证
- `tests/frontend-audit.test.ts`（5）：聚合统计/severity/单页失败容错/Markdown/默认页面清单（mock 截图+审核，零浏览器零网络）
- 实时（真实后端 + Playwright + SenseNova）：2 页 10s 完成；修复时机问题后 /chat、/settings 均 pass
- root 套件 **2598 tests / 0 fail**

## CI 视觉回归门禁（2026-08-16 追加）

### 工作流
`.github/workflows/frontend-audit.yml`：**前端改动时**（frontend/**、public/**）自动触发：
构建前端 → 起后端 → 全 9 页 Playwright 截图 → SenseNova 审核 → 报告归档（artifact）→ 门禁。

- 触发：push/PR 命中 `frontend/**`、`public/**`
- 需要 GitHub secret：`SENSENOVA_API_KEY`
- `.ci/frontend-audit.sh`：构建→起后端（trap 清理）→等健康→审核→归档 `reports/frontend-audit-ci-<ts>.md`→按退出码拦截
- 报告上传为 artifact（保留 30 天）

### 门禁阈值（`--block-on`，默认 critical）
- **critical（渲染级故障：黑屏/重叠/内容缺失）→ 拦截（exit 1）** —— 回归门禁的核心
- major/minor（如次要文字对比度）→ 进报告供人工审阅，不拦截
- 依据（事实）：深色主题 `--text-muted:#a6a6a6 on --bg:#0a0a0a` ≈ **7.6:1（WCAG AA 达标）**；LLM 视觉模型对次要文字对比度**过度标记**（实测 9 页被标 2 major/7 minor 均为此类），若在 major 拦截会把门禁长期搞红
- 实测：`--block-on=critical` 全 9 页 exit 0（门禁绿）；`--block-on=major` 会 exit 1（3 处对比度噪音）

### 本地运行
```bash
bun run src/main.ts &        # 起后端
bun run audit:frontend --block-on=critical
bun run audit:frontend --pages=/chat,/settings --out=reports/audit.md
```
