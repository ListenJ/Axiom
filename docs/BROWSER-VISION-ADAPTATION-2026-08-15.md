# 前端视觉场景适配（Browser Vision Adaptation）— 2026-08-15

> 需求 3 落地：无视觉模型时文本引导 + 无头浏览器精确定位 + 启动用户浏览器。
> 涉及文件：`src/computer-use/{text-guide,browser-launch,locate}.ts`、`src/agents/computer-use-agent.ts`（降级）、`src/mcp/server/browser-tools.ts`。

## 摘要

前端视觉场景（页面是否按预期渲染、模块/位置是否正确）在**没有视觉模型**时不再只能抛错：

1. **文本引导（text-guide）**：基于 CDP 提取的可交互元素（`getBoundingClientRect` 实测坐标）
   生成结构化 Markdown——任务重述、元素表（index/类型/文本/中心坐标/尺寸）、建议操作、验证步骤。
2. **无头浏览器精确定位（browser_locate）**：CDP 提取 → 按 text/role/tag/index 过滤 → 返回边界框。
3. **启动用户浏览器（browser_launch）**：Windows `cmd /c start` / Linux `xdg-open` / macOS `open`，
   让 Agent 打开真实页面供用户/自身核对。
4. **Agent 级降级**：`ComputerUseAgent.analyzeWithFallback()` 在无视觉模型时自动回退为文本引导，
   而不是抛出 "No vision model available"。

## MCP 工具

| 工具 | 作用 | 平台 |
|------|------|------|
| `browser_guide` | 无视觉模型文本引导（任务 + 元素表 + 建议操作 + 验证） | 跨平台 |
| `browser_locate` | 无头精确定位（返回 x/y/宽/高/中心） | 跨平台 |
| `browser_locate_local` | 对已提取元素列表做本地过滤（离线/测试） | 跨平台 |
| `browser_launch` | 启动用户默认浏览器打开 URL | Win/Linux/macOS |

## 文件与职责

| 文件 | 职责 |
|------|------|
| `src/computer-use/text-guide.ts` | `buildTextGuide` / `elementsToMarkdown` / `suggestActions`（纯函数） |
| `src/computer-use/locate.ts` | `filterElementsByQuery`（纯函数）/ `locateOnPage`（CDP） |
| `src/computer-use/browser-launch.ts` | `resolveOpenCommand`（纯函数）/ `launchUserBrowser`（Bun.spawn） |
| `src/agents/computer-use-agent.ts` | `analyzeWithFallback`：视觉 → 无视觉时文本引导 |
| `src/mcp/server/browser-tools.ts` | MCP 工具注册 |

## 操作示例

```bash
# 1. 无头定位"登录按钮"
browser_locate  cdpUrl=http://127.0.0.1:9222  text=登录  role=button
# → { found:1, matches:[{ index:0, bbox:{ x:10,y:20,width:80,height:32,centerX:50,centerY:36 } }] }

# 2. 无视觉模型时，给用户/LLM 一份文字引导
browser_guide  task="点击登录按钮登录系统"  cdpUrl=http://127.0.0.1:9222
# → Markdown：任务 + 元素表 + 建议操作（click #0 / type #1）+ 验证步骤

# 3. 启动用户真实浏览器核对
browser_launch  url=https://example.com/login
# → Windows: cmd /c start "" https://example.com/login
#   Linux:   xdg-open https://example.com/login
```

## 测试

- `tests/computer-use/text-guide.test.ts`（5）：元素表渲染、竖线转义、空表降级、建议操作命中
- `tests/computer-use/locate.test.ts`（4）：text/role/tag/index 过滤、组合交集、bbox 形状
- `tests/computer-use/browser-launch.test.ts`（6）：三平台命令、未知平台/空 URL 抛错
- `tests/computer-use/agent-fallback.test.ts`（2）：无视觉模型回退文本引导；非视觉错误继续抛
