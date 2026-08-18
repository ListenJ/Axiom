# DRE-DSH 插件实现计划（2026-08-19）

**Goal:** 创建独立 DSH 插件 `axiom-dre-dsh`（`plugins/dre-dsh/`），把 Axiom 确定性推理引擎（DRE）以 `dre__*` 工具暴露给 DSH，支持热插拔与快装快卸，并在本地 + `listen@192.168.0.150` 完成深度测试。

**Architecture:** Cordis 插件经 `cordis.patch.yml`（id `dre`）注入配置；`apply()` 拉起 Axiom MCP 服务器（stdio），`mcp-bridge` 按 DRE 白名单过滤并注册 `dre__<tool>`；`ctx.effect` 管理生命周期实现热卸载；自带 `dre_plugin_status` 诊断工具。复用现有 `plugins/dsh` 的桥模式（自包含拷贝 + 白名单扩展，不重构单块插件）。

**Tech Stack:** TypeScript（ESM）、@modelcontextprotocol/sdk、Cordis 结构性类型（鸭子类型）、bun（测试/构建）、DSH CLI（热插拔）、远端 Linux(Node22)+bun。

---

## Task 1: 脚手架 `plugins/dre-dsh`

**Files:**
- Create: `plugins/dre-dsh/package.json`
- Create: `plugins/dre-dsh/tsconfig.json`、`plugins/dre-dsh/tsconfig.build.json`
- Create: `plugins/dre-dsh/cordis.patch.yml`
- Create: `plugins/dre-dsh/.gitignore`
- Create: `plugins/dre-dsh/README.md`

**Step 1:** 按 `plugins/dsh` 同构创建（包名 `axiom-dre-dsh`，`dsh.bundle.patch` → `./cordis.patch.yml`，`files: ["lib","cordis.patch.yml","README.md"]`；peerDeps `@deepseek-ai/cordis`/`@deepseek-ai/dsh-tools`，dep `@modelcontextprotocol/sdk`）。
**Step 2:** `cordis.patch.yml` 行 id `dre`，默认 `mcpServerName: 'dre'`、`toolFilter: []`（空=默认白名单）、`synapseEnabled: true`、`mcpFailOnStartupError: false`。
**Step 3:** 验证 `bun x tsc --noEmit`（此时仅配置，应为空转）→ `bun install`。

## Task 2: 桥与类型（白名单过滤）

**Files:**
- Create: `plugins/dre-dsh/src/types.ts`（DshContext/DshToolDefinition/DshWebServerLike，同 `plugins/dsh/src/types.ts`）
- Create: `plugins/dre-dsh/src/mcp-bridge.ts`（基于 `plugins/dsh/src/mcp-bridge.ts` 增加 `toolFilter`：白名单前缀/全名数组；`publicToolName` 同构）

**关键实现（过滤）：**
```ts
export const DEFAULT_DRE_FILTER = [
  "dre_", "cognitive_", "reasoning_", "constraint_", "actor_", "mental_model_",
  "mind_synapse_", "task_graph_execute", "mind_suggest",
]
export function matchTool(name: string, filter: string[]): boolean {
  return filter.some((f) => f.endsWith("_") ? name.startsWith(f) : name === f)
}
```
**Step 3 测试（先写后实现，TDD）：** `tests/mcp-bridge.test.ts` 断言过滤、前缀、哈希防塌缩、extractText。

## Task 3: 配置解析 `src/config.ts`

**Files:**
- Create: `plugins/dre-dsh/src/config.ts`（`AxiomDreConfig`：axiomHome/mcpEnabled/mcpCommand/mcpArgs/mcpEnv/mcpServerName/mcpToolCallTimeoutMs/mcpFailOnStartupError/toolFilter/synapseEnabled；`normalizeConfig` 全默认值；`configSummary` 不含密钥；`resolveAxiomHome` 上溯 3 层）
**Step 3 测试：** `tests/config.test.ts`（默认值/非法回退/synapseEnabled=false 时 summary 标记/密钥排除/toolFilter 归一化）。

## Task 4: 插件入口 `src/index.ts`

**Files:**
- Create: `plugins/dre-dsh/src/index.ts`
**关键实现：**
- `apply()`：normalize config → `toolFilter = config.toolFilter.length ? config.toolFilter : DEFAULT_DRE_FILTER`（synapseEnabled=false 时剔除 `mind_synapse_`/`mind_suggest`）→ `createMcpBridge({..., serverName:'dre', filter})` → connect → 注册 `dre_plugin_status`（桥状态 + 引擎状态 + configSummary）→ `ctx.effect` 清理（disposers + bridge.dispose）。
- `mcpFailOnStartupError=true` 时连接失败抛错（严格模式）；false 容忍并 warn。

## Task 5: 冒烟测试（真实 MCP）

**Files:**
- Create: `plugins/dre-dsh/tests/smoke-mcp.test.ts`（spawn `bun run src/mcp/server.ts --stdio`，cwd=仓库根）
**断言：** 注册工具全部 `dre__*`；数量 = 白名单交集；`dre__dre_status` 可调用返回 JSON；`dre__dre_plugin_status` 可用。

## Task 6: 本地验证与门禁

Run:
- `bun test tests/`（插件目录）
- `bun x tsc -p tsconfig.build.json`（构建）
- `bun x tsc --noEmit`（typecheck）
- 仓库级 `bun run lint`（tsc 全仓）
- `bun test tests/agent-evals/external-benchmarks.test.ts` 等已挂门禁复跑（确认无回归）

## Task 7: 远端深度测试（listen@192.168.0.150）

Run（远端）:
1. `export HOME=/home/listen`；`curl -fsSL https://bun.sh/install | bash` → `~/.bun/bin`
2. `npm config set prefix ~/.npm-global && npm install -g @deepseek-ai/dsh`
3. 同步仓库：本地 `git archive HEAD | gzip > .tmp/repo.tgz` → scp → 远端解压 → `bun install`
4. `dsh plugin --profile web add <repo>/plugins/dre-dsh`
5. 启动 web profile（后台），调用 `dre__dre_status` / `dre__constraint_check` / `cognitive_loop`，校验结构
6. `dsh plugin --profile web rm axiom-dre-dsh` → 重启 → 断言工具消失、无孤儿进程
7. 重复 add/rm 一轮（热插拔稳定性）

## Task 8: 文档与提交

- 更新 `docs/operations-log.md`（本任务条目，hash 占位）
- `git add` 仅本任务文件 → commit → push `internal211 codex/self-evolving-agent` → 回填 hash（记录维护提交）

## 验收
- [ ] 本地全部单测/冒烟/构建/typecheck 绿
- [ ] 远端 add→可用→rm→消失→再 add 闭环通过
- [ ] `dre_plugin_status` 无密钥、可诊断
- [ ] 已推送 internal211，operations-log hash 回填
