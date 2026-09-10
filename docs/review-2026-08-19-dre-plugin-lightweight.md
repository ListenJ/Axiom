# DRE-DSH 插件全面审核与轻量化 Review（2026-08-19）

> 摘要：对 `plugins/dre-dsh`（axiom-dre-dsh v0.1.0，约 500 行源码 + 25 测试）做全面代码审核，
> 目标为「轻量极简」。结论：无 Critical 问题（无安全漏洞/无密钥/无崩溃风险），
> 存在 5 处 Warning 级冗余（死代码/未用分支/未用成员），删除后行为不变；测试覆盖良好。
> 本审核依据 code-review 技能清单（正确性/安全/性能/可维护性/测试）逐项核验。

---

## 一、审核范围（事实）

| 文件 | 行数(约) | 职责 |
| --- | --- | --- |
| `src/types.ts` | 40 | DSH 运行面结构性类型（DshToolDefinition / DshContext） |
| `src/config.ts` | 120 | 配置解析纯函数（默认值/归一化/摘要无密钥） |
| `src/mcp-bridge.ts` | 230 | MCP stdio 桥（白名单过滤 + dre 前缀 + lossless JSON） |
| `src/index.ts` | 110 | 插件入口（apply / 诊断工具 / 生命周期） |
| `tests/` | 3 文件 25 用例 | config 8 / bridge 11 / smoke 2（真实 MCP） |

## 二、审核结论（判断）

### Critical（必须修）：无
- 无密钥/凭据入库（configSummary 排除 mcpEnv，测试覆盖）
- 无命令注入面（command/args 来自用户配置，属 DSH 插件固有信任模型）
- 无崩溃路径（桥失败走容忍/严格两模式，均有日志）

### Warning（应修，轻量化核心）：
1. **`src/index.ts`：`disposers` 数组是死代码** —— 从未被 push，清理循环遍历空数组。
   删除 `disposers` 参数后 `registerStatusAndEffect` 签名简化为 4 参。
2. **`src/types.ts`：`DshContext.inject` / `DshContext.get` 未使用** —— 插件不注入 webServer、
   不读服务；删除后结构类型更窄（更宽松，DSH 侧兼容性反而更好）。
3. **`src/mcp-bridge.ts`：`McpToolMeta.outputSchema` 未使用** —— `toToolDefinition` 只读
   `name/description/inputSchema`，删除该字段。
4. **`src/mcp-bridge.ts`：`McpBridgeOptions.toolFilter` 可选且存在未使用的「不过滤桥全部」分支**
   —— 本插件唯一消费者（index.ts + 测试）总是传入 filter；改为必填并删除 `filter.length ? ... : tools` 分支。
5. **`src/index.ts`：`const log = ...` 包装器仅使用一次** —— 内联为 `ctx.logger?.info?.(...)`。

### Info（可选，不阻塞）：
6. `src/config.ts` 字符串用双引号，其余文件单引号 —— 风格微不一致（不影响功能，暂不批量改）。
7. `DshContext.logger.debug?` 未使用 —— 保留（对齐 dsh logger 接口完整性）。

### Positive（做得好的）：
- 纯函数集中在 config/mcp-bridge，可测性佳（25 用例覆盖解析/过滤/前缀/渲染/真实桥接）
- lossless JSON 契约（省略 undefined structuredContent）+ isError 帧转真实错误 —— 正确
- 白名单过滤 + synapseEnabled 门控语义正确（前缀/全名匹配、剔除突触）
- `resolveAxiomHome` 三序解析（config → env → 上溯 3 层）平台无关
- 生命周期 `ctx.effect` 清理（卸载工具 + 关闭 transport）支持热卸载（远端实测通过）

## 三、轻量化改动清单（行为不变）

| # | 文件 | 改动 | 效果 |
| --- | --- | --- | --- |
| 1 | `src/index.ts` | 删 `disposers` 数组与清理循环遍历 | -8 行 |
| 2 | `src/types.ts` | 删 `inject`/`get` 成员 | -5 行 |
| 3 | `src/mcp-bridge.ts` | 删 `outputSchema` | -2 行 |
| 4 | `src/mcp-bridge.ts` | `toolFilter` 必填，删「不过滤」分支 | -4 行 + 简化 connect |
| 5 | `src/index.ts` | 内联 `log` 包装器 | -3 行 |

实际净减 16 行（src 342→326，约 4.7%），行为零变化（typecheck/build/25 测试全绿）。

## 四、验证方案

1. `bun test --timeout 60000 tests/` 25/25 全绿（含真实 MCP 冒烟）
2. `bun run typecheck` + `bun run build`
3. 仓库级 `bun run lint` 无回归
4. （可选）远端热插拔抽查——上轮已实测通过，本次为纯删除优化，冒烟覆盖即可

## 五、来源与依据

- 本仓库 `plugins/dre-dsh/` 全部源码与测试全文审阅
- 对比参照：`plugins/dsh/` 单块插件（确认 DRE 插件无 webServer/frostedGlass 等多余能力面）
- 用户约束：轻量极简为目标；行为与功能面不得缩减（白名单/dre 前缀/热插拔保持不变）
