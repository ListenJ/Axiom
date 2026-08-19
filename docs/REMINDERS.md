# 提醒与待办（REMINDERS）

> 本文件用于记录需要在指定时间/条件下执行的事项。每次处理后更新状态。

## 🔔 2026-08-20 05:33（北京时间）后 — 重跑 awesome-dsh-plugin PR #1797 submission gate

- **背景**：PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1797（axiom-dre-dsh 上架）。
  `Submission gate` 失败原因为仓库 `ListenJ/axiom-dre-dsh` age < 1 天（创建于 2026-08-18T21:33Z）。
  commits=10 已达标（≥10）。
- **触发方式**：仓库满 24h 后，向 fork（ListenJ/awesome-dsh-plugin）push 一个空提交或 amend 触发 gate 重跑：
  ```bash
  git -C .tmp/awesome-dsh-plugin commit --allow-empty -m "trigger: repo age now >= 1 day" && git -C .tmp/awesome-dsh-plugin push origin main
  ```
  （或用 `gh pr close 1797 && gh pr reopen` 重新触发检查）
- **验证**：`gh pr checks 1797 --repo awesome-dsh-plugin/awesome-dsh-plugin` → Submission gate 应为 pass。
- **状态**：⏳ 待 2026-08-20 05:33 后执行

## 🔔 2026-08-20 10:35（北京时间）后 — 重跑 awesome-dsh-plugin PR #2020 submission gate

- **背景**：PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2020（axiom-kb-dsh 上架）。
  ListenJ/axiom-kb-dsh 创建于 2026-08-19T02:35Z（=08-19 10:35 北京），满 24h 为 08-20 10:35 北京；
  commits=11 已达标（≥10）；dsh.bundle 已声明；CI 绿。
- **触发方式**：满 24h 后向 fork 分支 push 空提交（或 amend / close+reopen）触发 gate 重跑：
  `ash
  git -C .tmp/awesome-dsh-plugin push origin add-axiom-kb-dsh --force-with-lease 2>/dev/null; # 或直接 push 空提交到该分支
  ``n  （参考 DRE：gh pr checks 2020 --repo awesome-dsh-plugin/awesome-dsh-plugin 应 pass）
- **状态**：⏳ 待 2026-08-20 10:35 后执行

## 其他待办（长期）

- [x] 知识库插件（axiom-kb-dsh，plugins/kb-dsh/）已按自包含模式拆分：Vault 记忆 + 知识图谱后端内置；联网检索工具不入插件队列，仅个人使用。
- [x] 开源仓库 github: 安装路径已修复并验证（lib/ 随仓库发布，clone 后即可加载）。
- [ ] npm 发布：两仓库 npm-publish 工作流已就绪（dry-run 验证通过）；待用户添加 NPM_TOKEN 仓库 Secret 后 git tag v0.1.0 && push 或手动触发 publish=true。
- [ ] 其余功能插件按自包含模式拆分（联网检索、模型路由等）
- [x] axiom-kb-dsh 已开源到 GitHub（https://github.com/ListenJ/axiom-kb-dsh，CI 绿）；待办：awesome-dsh-plugin 上架条目（参考 DRE PR #1797 流程，待该 PR 合并后）
- [ ] PR #1797 合并后确认 dshmarket / awesome-dsh-plugin.com 展示
