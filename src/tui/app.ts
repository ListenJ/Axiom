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
import { router, toolPool } from "../router/model-router.js";
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
    " {center}🦅 OpenClaw AI Agent v3.0 | DeepSeek-V4 Pro (Decision) | KIMI-k2.6 (Architecture) | Free Tool Pool | Tencent hy3 (Eval){/center} ",
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
    "{bold}L1 Decision{/bold}:    🟢 deepseek-v4-pro\n" +
    "{bold}L2 Architecture{/bold}: 🟢 kimi-k2.6\n" +
    "{bold}L3 Tool Pool{/bold}:    see Tool Health tab\n" +
    "{bold}L4 Evaluation{/bold}:   🟡 tencent/hy3 ($5 limit)",
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
    "{bold}WebSocket Server{/bold}: ws://localhost:3000\n" +
    "  Connected clients: 0\n" +
    "  Subscriptions: system.status, agent.intent\n\n" +
    "{bold}MCP Server{/bold}: 23 tools registered\n" +
    "{bold}HTTP API{/bold}: http://localhost:3000",
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
  } else {
    await handleChat(text);
  }
});

async function handleChat(userInput: string) {
  try {
    // Step 1: 意图识别
    chatBox.log("{cyan-fg}🧠 Recognizing intent...{/cyan-fg}");
    const { intent, messages } = buildAgentMessages(userInput);

    if (intent) {
      chatBox.log(
        `{cyan-fg}🎯 Intent: ${intent.agent.emoji} ${intent.agentName} (${intent.intent}) — ${(
          intent.confidence * 100
        ).toFixed(0)}%{/cyan-fg}`
      );
    }

    // Step 2: 分层路由
    const result = await router.routeByIntent(intent?.intent ?? "general-chat", messages);

    chatBox.log(`{gray-fg}⚡ ${result.provider} / ${result.model} [${result.layer}]{/gray-fg}`);
    chatBox.log(result.content ?? "(no response)");
    chatBox.log("");
  } catch (e: any) {
    chatBox.log(`{red-fg}❌ Error: ${e.message}{/red-fg}`);
  }
  screen.render();
}

async function handleOrchestrate(task: string) {
  try {
    chatBox.log("{yellow-fg}🎼 Orchestrating complex task...{/yellow-fg}");
    const start = Date.now();

    const result = await orchestrator.execute(task);

    chatBox.log(`{yellow-fg}✅ Completed in ${result.totalLatencyMs}ms | ${result.totalTokens} tokens{/yellow-fg}`);
    chatBox.log(`{yellow-fg}📊 Layers used: ${result.layersUsed.join(", ")}{/yellow-fg}`);

    for (const r of result.subTaskResults) {
      chatBox.log(
        `{gray-fg}[${r.layer}] ${r.model} (${r.latencyMs}ms){/gray-fg}`
      );
    }

    chatBox.log("{bold}Final Answer:{/bold}");
    chatBox.log(result.finalAnswer);
    chatBox.log("");
  } catch (e: any) {
    chatBox.log(`{red-fg}❌ Orchestration failed: ${e.message}{/red-fg}`);
  }
  screen.render();
}

async function handleCodegraphQuery(query: string) {
  try {
    chatBox.log(`{green-fg}🔍 CodeGraph: "${query}"{/green-fg}`);
    const result = await retrieveCodeMemory(query);
    if (result) {
      chatBox.log(`{green-fg}Found ${result.symbols.length} symbols{/green-fg}`);
      chatBox.log(result.results.slice(0, 2000));
    } else {
      chatBox.log("{gray-fg}No CodeGraph memory found.{/gray-fg}");
    }
  } catch (e: any) {
    chatBox.log(`{red-fg}❌ CodeGraph error: ${e.message}{/red-fg}`);
  }
  screen.render();
}

async function handleToolQuery(roleInput: string) {
  const validRoles = ["coding", "english", "rl", "general-tool"];
  const role = validRoles.includes(roleInput) ? roleInput : "general-tool";
  try {
    chatBox.log(`{magenta-fg}🛠️ Tool call [${role}]...{/magenta-fg}`);
    const result = await router.tool(role as any, [
      { role: "user", content: "Ready for task assignment." },
    ]);
    chatBox.log(`{gray-fg}⚡ ${result.provider} / ${result.model}{/gray-fg}`);
    chatBox.log(result.content ?? "(no response)");
  } catch (e: any) {
    chatBox.log(`{red-fg}❌ Tool error: ${e.message}{/red-fg}`);
  }
  screen.render();
}

// ===== 工具池健康度刷新 =====

function refreshToolHealth() {
  const stats = toolPool.getStats() as Record<string, any>;
  toolHealthBox.setContent("");

  const grouped: Record<string, any[]> = {};
  for (const [id, s] of Object.entries(stats)) {
    const role = s.role as string;
    if (!grouped[role]) grouped[role] = [];
    grouped[role].push({ id, ...s });
  }

  for (const [role, models] of Object.entries(grouped)) {
    toolHealthBox.log(`{bold}${role.toUpperCase()}{/bold}`);
    for (const m of models) {
      const icon = m.health.includes("🔴") ? "🔴" : m.health.includes("🟡") ? "🟡" : "🟢";
      const shortId = m.id.split("/").pop()?.slice(0, 30) ?? m.id;
      toolHealthBox.log(`  ${icon} ${shortId} | ${m.rpmThisMinute}/${m.rpmLimit} RPM`);
    }
  }
  screen.render();
}

// 定时刷新工具池状态
setInterval(refreshToolHealth, 10000);
refreshToolHealth();

// ===== 启动 =====

export async function startTUI(): Promise<void> {
  chatBox.log("{center}{bold}Welcome to OpenClaw AI Agent v3.0{/bold}{/center}");
  chatBox.log("{center}Type a message and press Enter to chat.{/center}");
  chatBox.log("{center}Commands: /orchestrate <task> | /codegraph <query> | /tool <role>{/center}");
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
