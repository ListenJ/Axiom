# 实践手册（Practice Manual）— 错误记录 + 修复过程 + 效果

> 需求 4 的知识库沉淀。结构化数据源：`src/dre/practice-manual.ts`（确定性引擎直接读取）。
> 本文件为人类可读镜像。LLM 遇到同类问题时应调用 `dre_constraint_inject` /
> `autoInjectDreConstraints`，把下方 `约束词` 插入输入后再调用 LLM。

## 条目

### 1. SQLite 并发写锁（SQLITE_BUSY / database is locked）
- 关键词：sqlite / busy / database is locked / 锁 / 并发写 / lock
- 约束词：SQLite 多进程并发写会触发 SQLITE_BUSY。连接须设置 PRAGMA busy_timeout（如 5000）并启用 journal_mode=WAL；写失败应重试而非立即报错。
- 修复：`src/utils/cache.ts`（及其他 bun:sqlite 连接）初始化时执行 `PRAGMA busy_timeout=5000` + `PRAGMA journal_mode=WAL`。
- 效果：并行测试 worker 下 SQLITE_BUSY 消除（full suite 0 fail）。

### 2. 测试依赖真实网络导致超时
- 关键词：github / network / timeout / api / 超时 / fetch / zhipu / llm
- 约束词：单元测试不得依赖真实网络。外部 fetch 用全局 mock（返回空 Response）；LLM 调用用注入的 fake executor / spy，避免真实 API 限流与超时。
- 修复：`tests/knowledge/*` 用 `spyOn(globalThis,'fetch')`；`tests/orchestrator` 注入 fake executor + `spyOn(router.executeWithRole)`。
- 效果：网络依赖用例从 30s 超时降为毫秒级，全绿。

### 3. 随机模拟测试偶发失败
- 关键词：random / seed / flaky / 随机 / 概率 / cross-talk / hallucination
- 约束词：含随机/概率的测试必须可复现：用 seeded PRNG（mulberry32，如 params.seed）替代裸 Math.random；对「>0」断言给定种子后确定性成立。
- 修复：新增 `src/testing/scenarios/random.ts`；cross-talk/hallucination 场景支持 `params.seed`，测试传 seed=42。
- 效果：cluster-test 连续多次全绿（原 ~4% flake）。

### 4. bun test 误匹配 dist/ 陈旧编译测试
- 关键词：bun / test / dist / 编译 / stale / match
- 约束词：bun test 的目录参数会被当作路径过滤器，可能匹配 dist/ 下的陈旧编译测试。应使用 ./tests 显式路径并限定并行度（--parallel=8），避免误报。
- 修复：package.json test 改为 `bun test --parallel=8 ./tests`；清理 dist/tests 陈旧产物。
- 效果：本地测试基线确定性化（无 dist 噪声）。

### 5. 高并行下 ESM 模块加载竞态
- 关键词：parallel / worker / promise / undefined / 竞态 / 并发 / module / load
- 约束词：过高测试并行度（worker = CPU 核数）下 bun 可能返回未就绪模块绑定。测试套件应限定并行 worker 数（--parallel=8），避免模块加载竞态。
- 修复：测试命令限定 `--parallel=8`（验证 16 worker → 22 fail，8 worker → 全绿）。
- 效果：router/skill/runToolLoop 相关用例在高并行下不再报「is an instance of Promise」。

### 6. Windows/Linux 平台命令差异
- 关键词：windows / linux / platform / xdg-open / cmd / start / 平台 / browser
- 约束词：启动浏览器/打开文件的命令因平台而异：Windows 用 `cmd /c start`，Linux 用 `xdg-open`，macOS 用 `open`。跨平台代码必须按平台分支并做纯函数可测试。
- 修复：`src/computer-use/browser-launch.ts`：`resolveOpenCommand(platform,url)` 纯函数 + `launchUserBrowser(Bun.spawn)`。
- 效果：Win/Linux 均有测试覆盖；browser_launch 跨平台可用。

### 7. 无视觉模型时前端视觉场景无法判断
- 关键词：vision / 视觉 / model / screenshot / 图片 / 没有视觉
- 约束词：无视觉模型时不得抛错：用 CDP 可交互元素（精确坐标）生成文本引导（任务/元素表/建议操作/验证），并可用 browser_locate/browser_launch 辅助定位与核对。
- 修复：`ComputerUseAgent.analyzeWithFallback` 自动降级；`browser_guide/browser_locate/browser_launch` 工具。
- 效果：无视觉模型也能对页面做结构化定位与引导。

## 使用方式

- MCP：`dre_constraint_inject { text }` → `{ injected: [id...], words }`，把 words 插入 LLM 输入。
- 代码接缝：`autoInjectDreConstraints(messages, extraContext)`（skill-registry 已接线）。
- 校验：`tests/dre-constraint-injection.test.ts`（命中/幂等/注入位置）。
