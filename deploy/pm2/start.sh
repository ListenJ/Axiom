#!/bin/bash
# pm2 入口包装：pm2 的 bun fork 容器（ProcessContainerForkBun.js）以 require() 加载入口，
# 而 dist/main.js 为含 top-level await 的 ESM bundle → TypeError 崩溃循环（2026-09-08 实证，
# CI run 34162662690 与本地 pm2 复现同因）。改由 bash 包装 exec bun，pm2 直接管理 bash 进程。
cd "$(dirname "$0")/../.." || exit 1
exec bun dist/main.js
