#!/usr/bin/env bun
/**
 * Axiom 开发者工具箱 — 常用操作的便捷入口
 *
 * 用法:
 *   bun run tools                 显示交互式菜单
 *   bun run tools kg:query "..."  直接执行命令
 *   bun run tools help             显示帮助
 */
const args = process.argv.slice(2);

const MENU = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Axiom AI Agent — 开发者工具箱 v4.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🚀  快速启动
  ───────────────────────────────────
  1.  axiom start         启动 HTTP 服务
  2.  axiom dev           开发模式（热重载）
  3.  axiom tui           启动终端界面
  4.  axiom install       安装配置向导

  🔍  搜索 / 知识
  ───────────────────────────────────
  5.  s / search <query>          网络搜索
  6.  r / research <topic>        KG增强深度研究
  7.  kg query <question>         自然语言查询KG
  8.  kg feedback <query>         KG反馈改进

  📖  记忆库
  ───────────────────────────────────
  9.  v / vault search <query>    记忆库搜索
  10. vault read <path>           读取笔记
  11. vault stats                 统计信息

  📊  模型 / 评估
  ───────────────────────────────────
  12. advisor free                发现免费模型
  13. advisor recommend           模型推荐
  14. eval                        运行评估

  🛠️  系统
  ───────────────────────────────────
  15. status                      系统状态
  16. health                      健康检查
  17. help --all                  所有命令
  18. lint                        TypeScript 检查
  19. test                        运行测试

  0.  退出

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

if (args.length === 0) {
  console.log(MENU);
  const answer = prompt("\n  选择操作 [0-19]: ");
  if (!answer) process.exit(0);
  const n = parseInt(answer);
  if (isNaN(n) || n < 1 || n > 19) process.exit(0);

  const cmds: Record<number, string[]> = {
    1: ["bun", "run", "src/main.ts"],
    2: ["bun", "--watch", "run", "src/main.ts"],
    3: ["bun", "run", "src/tui/app.ts"],
    4: ["bun", "run", "src/tui/install-wizard.ts"],
    5: ["bun", "run", "src/cli.ts", "search"],
    6: ["bun", "run", "src/cli.ts", "research"],
    7: ["bun", "run", "src/cli.ts", "kg", "query"],
    8: ["bun", "run", "src/cli.ts", "kg", "feedback"],
    9: ["bun", "run", "src/cli.ts", "vault", "search"],
    10: ["bun", "run", "src/cli.ts", "vault", "read"],
    11: ["bun", "run", "src/cli.ts", "vault", "stats"],
    12: ["bun", "run", "src/cli.ts", "advisor", "free"],
    13: ["bun", "run", "src/cli.ts", "advisor", "recommend"],
    14: ["bun", "run", "src/eval/eval-cli.ts"],
    15: ["bun", "run", "src/cli.ts", "status"],
    16: ["bun", "run", "scripts/health-check.ts"],
    17: ["bun", "run", "src/cli.ts", "help", "--all"],
    18: ["bun", "run", "tsc", "--noEmit"],
    19: ["bun", "test"],
  };

  const cmd = cmds[n];
  if (!cmd) process.exit(0);
  console.log(`\n  → ${cmd.join(" ")}\n`);
  const { spawnSync } = await import("child_process");
  spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", cwd: process.cwd() });
} else {
  // Forward to CLI
  const { spawnSync } = await import("child_process");
  const result = spawnSync("bun", ["run", "src/cli.ts", ...args], { stdio: "inherit", cwd: process.cwd() });
  process.exit(result.status ?? 0);
}
