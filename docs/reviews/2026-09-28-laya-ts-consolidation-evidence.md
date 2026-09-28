# Laya TS 接入 + local-llm/Rust 退役 —— 冒烟与门禁证据（2026-09-28）

> **方向修正（2026-09-28 同日）**：用户澄清 Laya 属**开发流程**（分诊/审计链）而非项目运行时——
> 本文涉及的运行时接线（decision/risk-screen 运行时适配、local-llm 退役）已回退；
> 本文件保留的**有效部分**：Laya 实服务冒烟读数（HTTP 客户端现服务开发流程链）、
> Rust 退役门禁、推送回执。最终口径见 operations-log 方向修正条目与
> skills/laya-local-decision-model §10。
>
> 主体记录见 `docs/operations-log.md` 2026-09-28 条目；本文件是可重放的机器证据。
> 代码提交 `e6c77347`，日志提交 `a85fd022`，分支 `codex/main-unify-2026-09-26`（gitea）。

## 实服务冒烟（脚本为一次性，验后删除；全文见 `git show e6c77347` 中 scripts/laya-smoke.ts）

```
===== LAYA SMOKE RESULTS =====
PASS  health/live 200  — status=true
PASS  单条 answers + routing.model=multilingual  — refund.noul=0.9963
PASS  choice 返回合法标签  — action=auto_refund
PASS  非法项被预校验拦截  — client-side guard
PASS  批量保序且全 ok  — total=3 ok=3 results=[a:true,b:true,c:true] elapsed=481ms
PASS  422 MODEL_NOT_AVAILABLE 正确上抛（0 重试）  — 4xx 不重试 ✓
PASS  并发 32 请求被钳到 8  — cap=8
===== 7/7 pass =====
```

## 推送回执

```
To ssh://git@<gitea-host>:2222/agent/openclaw-fusion.git
   41baaa1b..e6c77347  codex/main-unify-2026-09-26 -> codex/main-unify-2026-09-26
```

> 按规则 11，远端主机地址以 `<gitea-host>` 占位（实址见 `git remote -v`，不入库）。

## 门禁终态（复核命令）

- `bunx tsc --noEmit` rc=0；frontend `bunx tsc -b` rc=0
- 串行全量 `bun test --timeout 15000 ./tests`：4,637 用例 1 fail（high-intensity-load 墙钟绝对阈值，
  文件头自注"干净 HEAD 上同样红"；单文件 3× 复跑 22/0 全绿；当日 load 10–15/16 核，环境性非回归）
- `bun run audit:runtime` 16/16；doc-contract 35/0；outbound ratchet 16/16；docs-consistency 9/0；arch-integrity 25/25
- 前端 vitest 60 files / 308 tests 全过
