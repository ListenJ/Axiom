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

## 其他待办（长期）

- [x] 知识库插件（axiom-kb-dsh，plugins/kb-dsh/）已按自包含模式拆分：Vault 记忆 + 知识图谱后端内置；联网检索工具不入插件队列，仅个人使用。
- [ ] 其余功能插件按自包含模式拆分（联网检索、模型路由等）
- [ ] axiom-kb-dsh 开源到 GitHub（OSS 镜像已就绪 .tmp/axiom-kb-dsh-oss/，待确认后创建仓库 + awesome-dsh-plugin 上架）
- [ ] PR #1797 合并后确认 dshmarket / awesome-dsh-plugin.com 展示
