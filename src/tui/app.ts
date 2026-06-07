/**
 * OpenClaw TUI (Terminal User Interface) v1.0
 *
 * 基于 blessed 的全终端交互界面
 * 功能:
 *   - 聊天面板（意图识别 + 分层路由实时反馈）
 *   - 模型状态监控（L1-L4 各层健康度）
 *   - 任务编排可视化
 *   - 工具池健康度
 *   - WebSocket 社交连接状态
 *
 * 启动: bun run src/tui/app.ts 或 bun run src/cli.ts tui
 */
import blessed from "blessed";
import { logger } from "../utils/logger.js";
import { router, toolPool, type ToolRole } from "../router/model-router.js";
import { orchestrator } from "../router/task-orchestrator.js";
import { buildAgentMessages } from "../agents/intent-router.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";

// 全局 screen
const screen = blessed.screen({
  smartCSR: true,
  title: "OpenClaw AI Agent v3.0",
});

// ===== 布局定义 =====

// 顶部状态栏
const header = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: 3,
  tags: true,
  style: { fg: "white", bg: "blue" },
  content:
    " {center}[OpenClaw] AI Agent v3.0 | DeepSeek-V4 Pro (Decision) | KIMI-k2.6 (Architecture) | Free Tool Pool | Tencent hy3 (Eval){/center} ",
});

// 左侧：聊天历史
const chatBox = blessed.log({
  top: 3,
  left: 0,
  width: "60%",
  height: "70%",
  label: " Chat ",
  border: { type: "line" },
  style: { border: { fg: "cyan" }, fg: "white" },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: " " },
});

// 左下角：输入框
const inputBox = blessed.textbox({
  bottom: 0,
  left: 0,
  width: "60%",
  height: 3,
  label: " Input ",
  border: { type: "line" },
  style: { border: { fg: "green" }, fg: "white", focus: { border: { fg: "yellow" } } },
  inputOnFocus: true,
});

// 右侧上：模型状态
const modelStatusBox = blessed.box({
  top: 3,
  right: 0,
  width: "40%",
  height: "35%",
  label: " Model Layers ",
  border: { type: "line" },
  style: { border: { fg: "magenta" }, fg: "white" },
  tags: true,
  scrollable: true,
  content:
    "{bold}L1 Decision{/bold}:    [正常] deepseek-v4-pro\n" +
    "{bold}L2 Architecture{/bold}: [正常] kimi-k2.6\n" +
    "{bold}L3 Tool Pool{/bold}:    see Tool Health tab\n" +
    "{bold}L4 Evaluation{/bold}:   [警告] tencent/hy3 ($5 limit)",
});

// 右侧中：WebSocket / 社交连接
const socialBox = blessed.box({
  top: "38%",
  right: 0,
  width: "40%",
  height: "20%",
  label: " Social Connections ",
  border: { type: "line" },
  style: { border: { fg: "yellow" }, fg: "white" },
  tags: true,
  content:
    "{bold}WebSocket Server{/bold}: ws://localhost:18789\n" +
    "  Connected clients: 0\n" +
    "  Subscriptions: system.status, agent.intent\n\n" +
    "{bold}MCP Server{/bold}: 23 tools registered\n" +
    "{bold}HTTP API{/bold}: http://localhost:18789",
});

// 右侧下：工具池健康度
const toolHealthBox = blessed.log({
  top: "59%",
  right: 0,
  width: "40%",
  height: "38%",
  label: " Tool Pool Health ",
  border: { type: "line" },
  style: { border: { fg: "red" }, fg: "white" },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
});

// 底部提示栏
const footer = blessed.box({
  bottom: 3,
  left: 0,
  width: "60%",
  height: 3,
  tags: true,
  style: { fg: "gray" },
  content:
    " {bold}Enter{/bold}: send | {bold}Ctrl+O{/bold}: orchestrate task | {bold}Ctrl+S{/bold}: status | {bold}Ctrl+C{/bold}: exit ",
});

// 组装界面
screen.append(header);
screen.append(chatBox);
screen.append(inputBox);
screen.append(modelStatusBox);
screen.append(socialBox);
screen.append(toolHealthBox);
screen.append(footer);

inputBox.focus();

// ===== 键盘事件 =====

screen.key(["C-c"], () => {
  process.exit(0);
});

screen.key(["C-o"], async () => {
  // 切换 orchestrator 模式
  chatBox.log("{yellow-fg}[Mode] Switched to Orchestrator mode{/yellow-fg}");
  inputBox.setLabel(" Orchestrator Input ");
  screen.render();
});

screen.key(["C-s"], () => {
  refreshToolHealth();
});

// ===== 聊天处理 =====

let orchestratorMode = false;

inputBox.on("submit", async (text: string) => {
  inputBox.clearValue();
  inputBox.focus();
  screen.render();

  if (!text.trim()) return;

  chatBox.log(`{right}{gray-fg}You{/gray-fg}{/right}`);
  chatBox.log(text);

  if (orchestratorMode || text.startsWith("/orchestrate ")) {
    const task = text.replace("/orchestrate ", "");
    await handleOrchestrate(task);
  } else if (text.startsWith("/codegraph ")) {
    const query = text.replace("/codegraph ", "");
    await handleCodegraphQuery(query);
  } else if (text.startsWith("/tool ")) {
    const role = text.replace("/tool ", "").trim();
    await handleToolQuery(role);
  } else if (text.startsWith("/skill ")) {
    const query = text.replace("/skill ", "");
    await handleSkill(query);
  } else if (text.startsWith("/computer ")) {
    const task = text.replace("/computer ", "");
    await handleComputerUseTUI(task);
  } else if (text === "/health") {
    await handleHealthCheck();
  } else if (text === "/config") {
    await handleConfigView();
  } else if (text === "/skills") {
    await handleSkillList();
  } else if (text === "/help") {
    showHelp();
  } else {
    await handleChat(text);
  }
});

async function handleChat(userInput: string) {
  try {
    // Step 1: 意图识别
    chatBox.log("{cyan-fg}[意图识别] Recognizing intent...{/cyan-fg}");
    const { intent, messages } = buildAgentMessages(userInput);

    if (intent) {
      chatBox.log(
        `{cyan-fg}[意图] ${intent.agentName} (${intent.intent}) — ${(
          intent.confidence * 100
        ).toFixed(0)}%{/cyan-fg}`
      );
    }

    // Step 2: 分层路由
    const result = await router.routeByIntent(intent?.intent ?? "general-chat", messages);

    chatBox.log(`{gray-fg}⚡ ${result.provider} / ${result.model} [${result.layer}]{/gray-fg}`);
    chatBox.log(result.content ?? "(no response)");
    chatBox.log("");
  } catch (e) {
    chatBox.log(`{red-fg}[错误]: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleOrchestrate(task: string) {
  try {
    chatBox.log("{yellow-fg}[编排] Orchestrating complex task...{/yellow-fg}");
    const start = Date.now();

    const result = await orchestrator.execute(task);

    chatBox.log(`{yellow-fg}[完成] Completed in ${result.totalLatencyMs}ms | ${result.totalTokens} tokens{/yellow-fg}`);
    chatBox.log(`{yellow-fg}[层级] Layers used: ${result.layersUsed.join(", ")}{/yellow-fg}`);

    for (const r of result.subTaskResults) {
      chatBox.log(
        `{gray-fg}[${r.layer}] ${r.model} (${r.latencyMs}ms){/gray-fg}`
      );
    }

    chatBox.log("{bold}Final Answer:{/bold}");
    chatBox.log(result.finalAnswer);
    chatBox.log("");
  } catch (e) {
    chatBox.log(`{red-fg}[错误] Orchestration failed: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleCodegraphQuery(query: string) {
  try {
    chatBox.log(`{green-fg}[搜索] CodeGraph: "${query}"{/green-fg}`);
    const result = await retrieveCodeMemory(query);
    if (result) {
      chatBox.log(`{green-fg}Found ${result.symbols.length} symbols{/green-fg}`);
      chatBox.log(result.results.slice(0, 2000));
    } else {
      chatBox.log("{gray-fg}No CodeGraph memory found.{/gray-fg}");
    }
  } catch (e) {
    chatBox.log(`{red-fg}[错误] CodeGraph error: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleToolQuery(roleInput: string) {
  const validRoles = ["coding", "english", "rl", "general-tool"];
  const role = validRoles.includes(roleInput) ? roleInput : "general-tool";
  try {
    chatBox.log(`{magenta-fg}[工具] Tool call [${role}]...{/magenta-fg}`);
    const result = await router.tool(role as ToolRole, [
      { role: "user", content: "Ready for task assignment." },
    ]);
    chatBox.log(`{gray-fg}⚡ ${result.provider} / ${result.model}{/gray-fg}`);
    chatBox.log(result.content ?? "(no response)");
  } catch (e) {
    chatBox.log(`{red-fg}[错误] Tool error: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

// ===== Skill 命令 =====

async function handleSkill(query: string) {
  try {
    chatBox.log(`{blue-fg}[Skill] Matching: "${query}"...{/blue-fg}`);
    const { getSkillRegistry } = await import("../skills/skill-registry.js");
    const registry = getSkillRegistry();
    const match = registry.match(query);

    if (!match) {
      chatBox.log("{gray-fg}No matching skill found. Try /skills to list all.{/gray-fg}");
      // Fallback to general chat
      await handleChat(query);
      return;
    }

    chatBox.log(`{blue-fg}[Skill] Matched: ${match.skill.name} (${match.confidence} confidence, score: ${match.score}){/blue-fg}`);
    const result = await registry.execute(match);
    chatBox.log(`{gray-fg}⚡ ${result.provider} / ${result.model} [skill: ${result.skillId}] (${result.latencyMs}ms){/gray-fg}`);
    chatBox.log(result.content);
  } catch (e) {
    chatBox.log(`{red-fg}[错误] Skill error: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleSkillList() {
  try {
    const { getSkillRegistry } = await import("../skills/skill-registry.js");
    const registry = getSkillRegistry();
    const skills = registry.list();
    const stats = registry.stats();

    chatBox.log(`{blue-fg}[Skill Registry] ${stats.total} skills (${stats.builtin} builtin, ${stats.file} file, ${stats.hermes} hermes){/blue-fg}`);
    for (const skill of skills) {
      const src = skill.source === "builtin" ? "[B]" : skill.source === "file" ? "[F]" : "[H]";
      chatBox.log(`  ${src} ${skill.id.padEnd(20)} ${skill.name} — ${skill.triggers.slice(0, 3).join(", ")}`);
    }
  } catch (e) {
    chatBox.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

// ===== Computer Use 命令 =====

async function handleComputerUseTUI(task: string) {
  try {
    chatBox.log(`{cyan-fg}[Computer Use] Task: ${task}{/cyan-fg}`);
    chatBox.log("{gray-fg}Note: Computer Use requires CDP browser connection at http://127.0.0.1:9222{/gray-fg}");
    chatBox.log("{gray-fg}Use '/computer <task>' with CDP running.{/gray-fg}");

    // Try to analyze with existing screenshot if available
    const { getComputerUseAgent } = await import("../agents/computer-use-agent.js");
    const agent = getComputerUseAgent();

    chatBox.log("{cyan-fg}[Computer Use] Available vision models:{/cyan-fg}");
    const models = agent.listVisionModels();
    for (const m of models.slice(0, 5)) {
      chatBox.log(`  • ${m.id} (${m.provider})`);
    }
  } catch (e) {
    chatBox.log(`{red-fg}[错误] Computer Use error: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

// ===== Health Check 命令 =====

async function handleHealthCheck() {
  try {
    chatBox.log("{yellow-fg}[HealthCheck] Running system diagnostics...{/yellow-fg}");
    const { runHealthCheck } = await import("../core/health-checker.js");
    const report = await runHealthCheck();

    const icons = { ok: "✅", warning: "⚠️", error: "❌", skipped: "⏭️" };
    for (const check of report.checks.slice(0, 15)) {
      const icon = icons[check.status];
      chatBox.log(`  ${icon} ${check.component.padEnd(20)} ${check.message.slice(0, 50)}`);
    }
    chatBox.log(`{yellow-fg}Overall: ${report.overall.toUpperCase()}{/yellow-fg}`);
  } catch (e) {
    chatBox.log(`{red-fg}[错误] Health check failed: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

// ===== Config View 命令 =====

async function handleConfigView() {
  try {
    const { getConfigCenter } = await import("../core/config-center.js");
    const center = getConfigCenter();
    const categories = ["gateway", "model", "memory", "crawler", "security", "advanced"];
    const names: Record<string, string> = {
      gateway: "🌐 网关", model: "🤖 模型", memory: "🧠 记忆",
      crawler: "🔍 采集", security: "🔒 安全", advanced: "⚙️ 高级",
    };

    chatBox.log("{green-fg}[ConfigCenter] Current Configuration{/green-fg}");
    for (const cat of categories) {
      chatBox.log(`{bold}${names[cat]}{/bold}`);
      const configs = center.getByCategory(cat as any);
      for (const c of configs.slice(0, 6)) {
        const masked = c.masked || String(c.value ?? "(not set)");
        chatBox.log(`  ${c.key.padEnd(35)} ${masked.slice(0, 30)}`);
      }
    }
  } catch (e) {
    chatBox.log(`{red-fg}[错误] Config error: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

// ===== Help =====

function showHelp() {
  chatBox.log("{bold}OpenClaw TUI Commands:{/bold}");
  chatBox.log("  /orchestrate <task>  — 任务编排模式");
  chatBox.log("  /codegraph <query>   — CodeGraph 代码搜索");
  chatBox.log("  /tool <role>        — 工具池调用 (coding/english/rl)");
  chatBox.log("  /skill <query>      — Skill 匹配执行");
  chatBox.log("  /skills             — 列出所有 Skill");
  chatBox.log("  /computer <task>    — Computer Use 视觉自动化");
  chatBox.log("  /health             — 系统健康检查");
  chatBox.log("  /config             — 查看配置中心");
  chatBox.log("  /help               — 显示此帮助");
  chatBox.log("  Ctrl+O              — 切换编排模式");
  chatBox.log("  Ctrl+S              — 刷新工具池状态");
  chatBox.log("  Ctrl+C              — 退出");
  screen.render();
}

// ===== 工具池健康度刷新 =====

function refreshToolHealth() {
  const stats = toolPool.getStats() as Record<string, { role: string; health: string; rpmThisMinute: number; rpmLimit: number }>;
  toolHealthBox.setContent("");

  const grouped: Record<string, Array<{ id: string; role: string; health: string; rpmThisMinute: number; rpmLimit: number }>> = {};
  for (const [id, s] of Object.entries(stats)) {
    const role = s.role as string;
    if (!grouped[role]) grouped[role] = [];
    grouped[role].push({ id, ...s });
  }

  for (const [role, models] of Object.entries(grouped)) {
    toolHealthBox.log(`{bold}${role.toUpperCase()}{/bold}`);
    for (const m of models) {
      const icon = m.health.includes("[异常]") ? "[异常]" : m.health.includes("[警告]") ? "[警告]" : "[正常]";
      const shortId = m.id.split("/").pop()?.slice(0, 30) ?? m.id;
      toolHealthBox.log(`  ${icon} ${shortId} | ${m.rpmThisMinute}/${m.rpmLimit} RPM`);
    }
  }
  screen.render();
}

let toolHealthInterval: ReturnType<typeof setInterval> | null = null;

/** 停止TUI定时器 */
export function stopTUI(): void {
  if (toolHealthInterval) {
    clearInterval(toolHealthInterval);
    toolHealthInterval = null;
  }
}

// ===== 启动 =====

export async function startTUI(): Promise<void> {
  // 启动定时刷新工具池状态
  toolHealthInterval = setInterval(refreshToolHealth, 10000);
  refreshToolHealth();
  chatBox.log("{center}{bold}Welcome to OpenClaw AI Agent v3.0{/bold}{/center}");
  chatBox.log("{center}Type a message and press Enter to chat.{/center}");
  chatBox.log("{center}Commands: /help | /skill <query> | /computer <task> | /health | /config{/center}");
  chatBox.log("");
  screen.render();

  logger.info("[TUI] OpenClaw TUI started");

  // 保持进程运行
  await new Promise(() => {});
}

// 直接运行时启动
if (import.meta.url === `file://${process.argv[1]}`) {
  startTUI();
}
