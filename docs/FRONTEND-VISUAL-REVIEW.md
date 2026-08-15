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
