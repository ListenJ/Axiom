# 2026-08-15 新增能力与工程基线（Consolidated Capabilities）

> 本文档汇总本轮目标推进中新增/修复的能力与工程基线，操作与效果详见各专项文档。

## 一、工程化测试基线（需求 1/4/5）

- **root 套件**：`bun test --parallel=8 ./tests` → **2509 pass / 28 skip / 0 fail**（会话初 55 fail + 6 error）。
- **frontend 套件**：65 文件 / **331 测试全绿**；`tsc --noEmit` + `eslint` + `vite build` 全过。
- 修复：网络依赖测试 mock（github/zhipu）、随机测试 seeded PRNG（mulberry32）、SQLite 并发
  （PRAGMA busy_timeout + WAL）、bun dist 误匹配、并行加载竞态（--parallel=8 上限）。
- 详见：`docs/operations-log.md`（2026-08-15 多条记录）。

## 二、前端页面场景化测试（需求 1）

- 22/22 页面组件均有 colocated 场景测试（`frontend/src/pages/*.test.tsx`）。
- 覆盖：聊天/会话/知识库/路由/搜索/智能体/Token/设置/代码/图谱/代理/Git/登录（含开放式重定向防护）/
  旧路由重定向（Knowledge/OCR/Research/Trends/KG）。
- 覆盖清单校验：`tests/e2e-pages.test.ts`（防新增页面漏测）。

## 三、神经突触心智模块（需求 2）

- `src/dre/synapse/`：SynapseStore（SQLite + 链式防篡改验证记录）+ SynapseEngine
  （Hebbian 激活 / 扩散激活 / 场景目标建议 / 校验 / 追溯）+ 可选本地模型增强。
- MCP：`mind_synapse_create/activate/spread/suggest/verify/trace`、`mind_suggest`。
- 详见：`docs/MIND-SYNAPSE.md`。

## 四、心智模块 × 自进化闭环（需求 2）

- `src/self-evolve/mind-suggest.ts`：self-evolve 归纳/教训 → 突触（场景→能力/教训）→
  未来同场景/目标由扩散激活给出可追溯建议（MindAdvisor）。
- 详见：`docs/MIND-SYNAPSE.md`（闭环部分）。

## 五、前端视觉场景适配（需求 3）

- `src/computer-use/`：text-guide（无视觉模型文本引导）、locate（无头精确定位）、
  browser-launch（Win `cmd /c start` / Linux `xdg-open` / macOS `open`）。
- `ComputerUseAgent.analyzeWithFallback`：无视觉模型自动回退文本引导，不抛错。
- MCP：`browser_guide / browser_locate / browser_locate_local / browser_launch`。
- 详见：`docs/BROWSER-VISION-ADAPTATION-2026-08-15.md`。

## 六、DRE 约束自动注入 + 实践手册（需求 4）

- `src/dre/practice-manual.ts`：7 条错误记录（SQLITE_BUSY/网络测试/随机 flake/bun dist/
  并行竞态/Win-Linux 平台命令/无视觉模型）——keywords/constraint/fix/effect。
- `src/dre/constraint-injection.ts`：LLM 调用前自动注入约束词（幂等、来源可追溯）；
  skill-registry 已接线；MCP `dre_constraint_inject`。
- 知识库镜像：`knowledge-base/practice-manual/entries.md`。

## 七、质量门禁

| 门禁 | 命令 | 现状 |
|------|------|------|
| root 测试 | `bun test --parallel=8 ./tests` | 2509 pass / 0 fail |
| 类型 | `bunx tsc --noEmit` | 干净 |
| 前端测试 | `cd frontend && npm run test:run` | 331 pass |
| 前端 lint | `cd frontend && npm run lint` | 干净 |
| 前端构建 | `cd frontend && npm run build` | 成功 |
| 运行时审计 | `bun run audit:runtime` | 见 ops-log |
