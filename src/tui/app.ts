/**
 * OpenClaw TUI (Terminal User Interface) v3.0 Unified
 * 合并 v1 聊天功能 + v2 配置/诊断/性能/Native 面板
 *
 * 面板: Chat | Config | Diagnostics | Performance
 * 快捷键: Tab 切换 | F1 诊断 | F2 配置 | F3 性能 | F4 Native | Ctrl+C 退出
 */
import blessed from "blessed";
import { logger } from "../utils/logger.js";
import { router, toolPool, type ToolRole } from "../router/model-router.js";
import { orchestrator } from "../router/task-orchestrator.js";
import { buildAgentMessages } from "../agents/intent-router.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";
import { getConfigCenter } from "../core/config-center.js";
import { runHealthCheck } from "../core/health-checker.js";
import { getRouterEngine } from "../core/router-engine.js";

// ─── Screen ─────────────────────────────────────────────────────────────────

const screen = blessed.screen({ smartCSR: true, title: "OpenClaw AI Agent v3.0" });

// ─── Layout ─────────────────────────────────────────────────────────────────

const header = blessed.box({
  top: 0, left: 0, width: "100%", height: 3,
  tags: true, style: { fg: "white", bg: "blue" },
  content: " {center}{bold}OpenClaw AI Agent v3.0 — Unified TUI{/bold}{/center} ",
});

const contentBox = blessed.box({
  top: 3, left: 0, width: "100%", height: "85%",
  border: { type: "line" }, style: { border: { fg: "cyan" } },
});

// ─── Panel: Chat ────────────────────────────────────────────────────────────

const chatPanel = blessed.box({ parent: contentBox, width: "100%", height: "100%" });

const chatLog = blessed.log({
  parent: chatPanel, top: 0, left: 0, width: "70%", height: "90%",
  label: " Chat ", border: { type: "line" },
  style: { border: { fg: "cyan" }, fg: "white" },
  tags: true, scrollable: true, alwaysScroll: true,
});

const chatInput = blessed.textbox({
  parent: chatPanel, bottom: 0, left: 0, width: "70%", height: "10%",
  label: " Input ", border: { type: "line" },
  style: { border: { fg: "green" }, focus: { border: { fg: "yellow" } } },
  inputOnFocus: true,
});

const chatStatus = blessed.box({
  parent: chatPanel, top: 0, right: 0, width: "30%", height: "90%",
  label: " Status ", border: { type: "line" },
  style: { border: { fg: "magenta" }, fg: "white" }, tags: true,
  content:
    "{bold}L1 Decision{/bold}:    [正常]\n" +
    "{bold}L2 Architecture{/bold}: [正常]\n" +
    "{bold}L3 Tool Pool{/bold}:    [正常]\n" +
    "{bold}L4 Evaluation{/bold}:   [正常]\n\n" +
    "{bold}黑板{/bold}: 0 条目\n" +
    "{bold}缓存{/bold}: 0 命中\n" +
    "{bold}Native{/bold}: 检测中...",
});

// ─── Panel: Config ──────────────────────────────────────────────────────────

const configPanel = blessed.box({ parent: contentBox, width: "100%", height: "100%", hidden: true });

const configList = blessed.list({
  parent: configPanel, top: 0, left: 0, width: "50%", height: "90%",
  label: " Configuration ", border: { type: "line" },
  style: { border: { fg: "green" }, fg: "white", selected: { bg: "blue" } },
  keys: true, interactive: true, tags: true,
});

const configDetail = blessed.box({
  parent: configPanel, top: 0, right: 0, width: "50%", height: "90%",
  label: " Detail ", border: { type: "line" },
  style: { border: { fg: "yellow" }, fg: "white" }, tags: true,
  content: "选择配置项查看详情",
});

const configInput = blessed.textbox({
  parent: configPanel, bottom: 0, left: 0, width: "100%", height: "10%",
  label: " Edit Value (Enter to save, Esc to cancel) ", border: { type: "line" },
  style: { border: { fg: "green" } }, inputOnFocus: true,
});

// ─── Panel: Diagnostics ─────────────────────────────────────────────────────

const diagPanel = blessed.box({ parent: contentBox, width: "100%", height: "100%", hidden: true });

const diagLog = blessed.log({
  parent: diagPanel, top: 0, left: 0, width: "100%", height: "80%",
  label: " Diagnostics ", border: { type: "line" },
  style: { border: { fg: "red" }, fg: "white" },
  tags: true, scrollable: true, alwaysScroll: true,
});

const diagButton = blessed.button({
  parent: diagPanel, bottom: 0, left: "center", width: 30, height: 3,
  content: "{center}Run Health Check{/center}",
  border: { type: "line" },
  style: { fg: "white", bg: "green", focus: { bg: "yellow" } },
  align: "center", valign: "middle",
});

// ─── Panel: Performance ─────────────────────────────────────────────────────

const perfPanel = blessed.box({ parent: contentBox, width: "100%", height: "100%", hidden: true });

const perfTable = blessed.listtable({
  parent: perfPanel, top: 0, left: 0, width: "100%", height: "80%",
  label: " Performance Metrics ", border: { type: "line" },
  style: { border: { fg: "cyan" }, fg: "white", header: { fg: "yellow", bold: true }, cell: { fg: "white" } },
  tags: true, interactive: false,
});

// ─── Footer ─────────────────────────────────────────────────────────────────

const footer = blessed.box({
  bottom: 0, left: 0, width: "100%", height: 2,
  tags: true, style: { fg: "gray" },
  content: " {bold}Tab{/bold}:切换面板 | {bold}F1{/bold}:诊断 | {bold}F2{/bold}:配置 | {bold}F3{/bold}:性能 | {bold}F4{/bold}:Native | {bold}Ctrl+C{/bold}:退出 ",
});

screen.append(header);
screen.append(contentBox);
screen.append(footer);

// ─── State ──────────────────────────────────────────────────────────────────

type PanelName = "chat" | "config" | "diag" | "perf";
let currentPanel: PanelName = "chat";
const panels: Record<PanelName, blessed.Widgets.BoxElement> = {
  chat: chatPanel, config: configPanel, diag: diagPanel, perf: perfPanel,
};

let configItems: Array<{ key: string; value: string; description: string }> = [];
let selectedConfigIndex = 0;
let orchestratorMode = false;

// ─── Panel Switching ────────────────────────────────────────────────────────

function switchPanel(name: PanelName): void {
  panels[currentPanel].hide();
  panels[name].show();
  currentPanel = name;

  if (name === "chat") chatInput.focus();
  if (name === "config") configList.focus();
  if (name === "diag") diagButton.focus();
  if (name === "perf") perfPanel.focus();

  screen.render();
}

// ─── Config Panel Logic ─────────────────────────────────────────────────────

function refreshConfigList(): void {
  const center = getConfigCenter();
  const categories = ["gateway", "model", "memory", "crawler", "security", "advanced"] as const;
  const categoryNames: Record<string, string> = {
    gateway: "🌐 网关", model: "🤖 模型", memory: "🧠 记忆",
    crawler: "🔍 采集", security: "🔒 安全", advanced: "⚙️ 高级",
  };

  configItems = [];
  const items: string[] = [];

  for (const cat of categories) {
    items.push(`{bold}${categoryNames[cat]}{/bold}`);
    const configs = center.getByCategory(cat);
    for (const c of configs) {
      configItems.push({ key: c.key, value: String(c.value ?? ""), description: c.description });
      const masked = c.masked;
      const status = c.value ? "✅" : "⚪";
      items.push(`  ${status} ${c.key.padEnd(30)} ${masked.slice(0, 30)}`);
    }
  }

  configList.setItems(items);
  screen.render();
}

configList.on("select", (_item, index) => {
  const item = configItems[index];
  if (!item) return;

  selectedConfigIndex = index;
  const center = getConfigCenter();
  const schema = center.getAll()[item.key];

  configDetail.setContent(
    `{bold}Key:{/bold} ${item.key}\n` +
    `{bold}Description:{/bold} ${item.description}\n` +
    `{bold}Current Value:{/bold} ${item.value}\n` +
    `{bold}Source:{/bold} ${schema?.source ?? "default"}\n\n` +
    `{gray-fg}Press Enter to edit{/gray-fg}`
  );
  screen.render();

  configInput.setValue(item.value);
  configInput.focus();
  screen.render();
});

configInput.on("submit", (value: string) => {
  const item = configItems[selectedConfigIndex];
  if (!item) return;

  const center = getConfigCenter();
  center.set(item.key, value, "tui", true);
  configDetail.setContent(`{green-fg}Saved: ${item.key} = ${value}{/green-fg}`);
  refreshConfigList();
  configList.focus();
  screen.render();
});

configInput.key("escape", () => {
  configList.focus();
  screen.render();
});

// ─── Diagnostics Panel Logic ────────────────────────────────────────────────

async function runDiagnostics(): Promise<void> {
  diagLog.log("{yellow-fg}Running health check...{/yellow-fg}");
  screen.render();

  try {
    const report = await runHealthCheck();
    diagLog.log(`\n{bold}Overall: ${report.overall.toUpperCase()}{/bold}\n`);

    for (const check of report.checks) {
      const icon = check.status === "ok" ? "✅" : check.status === "warning" ? "⚠️" : "❌";
      diagLog.log(`${icon} ${check.component}: ${check.message}`);
      if (check.fix) diagLog.log(`   {gray-fg}Fix: ${check.fix}{/gray-fg}`);
    }

    if (report.recommendations.length > 0) {
      diagLog.log("\n{yellow-fg}Recommendations:{/yellow-fg}");
      for (const rec of report.recommendations) diagLog.log(`  💡 ${rec}`);
    }
  } catch (e) {
    diagLog.log(`{red-fg}Error: ${(e as Error).message}{/red-fg}`);
  }
  screen.render();
}

diagButton.on("press", runDiagnostics);

// ─── Performance Panel Logic ────────────────────────────────────────────────

function refreshPerfPanel(): void {
  const engine = getRouterEngine();
  const report = engine.getPerfReport();
  const hotspots = engine.getHotspotReport();

  const data: string[][] = [
    ["Endpoint", "Requests", "Avg(ms)", "P95(ms)", "Errors", "Status"],
  ];

  for (const [endpoint, metrics] of Object.entries(report)) {
    const status = metrics.errors > 0 ? "⚠️" : metrics.avgLatency > 1000 ? "🐌" : "✅";
    data.push([
      endpoint.slice(0, 35),
      String(metrics.totalRequests),
      String(metrics.avgLatency),
      String(metrics.p95Latency),
      String(metrics.errors),
      status,
    ]);
  }

  if (data.length === 1) data.push(["No data yet", "-", "-", "-", "-", "⏳"]);

  perfTable.setData(data);
  screen.render();
}

// ─── Native Status ──────────────────────────────────────────────────────────

async function showNativeStatus(): Promise<void> {
  chatLog.log("{cyan-fg}[Native Bridge] Checking status...{/cyan-fg}");
  try {
    const { isNativeReady, getNativeEdition, nativeStats } = await import("../native-bridge.js");
    if (isNativeReady()) {
      const stats = await nativeStats();
      chatLog.log(`{green-fg}🦀 Rust Core Active — ${getNativeEdition()} edition{/green-fg}`);
      if (stats) {
        chatLog.log(`  Version: ${stats.version || "unknown"}`);
        chatLog.log(`  Uptime: ${stats.uptime_secs || 0}s`);
        chatLog.log(`  Vault Notes: ${stats.vault_notes || 0}`);
      }
    } else {
      chatLog.log("{gray-fg}📜 TypeScript-only mode (Rust core not running){/gray-fg}");
      chatLog.log("{gray-fg}  To enable: set OPENCLAW_NATIVE=true and build Rust core{/gray-fg}");
    }
  } catch (e) {
    chatLog.log(`{red-fg}[Native] Error: ${(e as Error).message}{/red-fg}`);
  }
  screen.render();
}

// ─── Keyboard Events ────────────────────────────────────────────────────────

screen.key(["C-c"], () => process.exit(0));

screen.key(["tab"], () => {
  const order: PanelName[] = ["chat", "config", "diag", "perf"];
  const next = order[(order.indexOf(currentPanel) + 1) % order.length];
  switchPanel(next);
});

screen.key(["f1"], () => switchPanel("diag"));
screen.key(["f2"], () => { switchPanel("config"); refreshConfigList(); });
screen.key(["f3"], () => switchPanel("perf"));
screen.key(["f4"], () => showNativeStatus());
screen.key(["C-o"], () => {
  orchestratorMode = !orchestratorMode;
  chatLog.log(`{yellow-fg}[Mode] Orchestrator ${orchestratorMode ? "ON" : "OFF"}{/yellow-fg}`);
  chatInput.setLabel(orchestratorMode ? " Orchestrator Input " : " Input ");
  screen.render();
});
screen.key(["C-s"], () => refreshPerfPanel());

// ─── Chat Input ─────────────────────────────────────────────────────────────

chatInput.on("submit", async (text: string) => {
  chatInput.clearValue();
  chatInput.focus();
  screen.render();
  if (!text.trim()) return;

  chatLog.log(`{right}{gray-fg}You{/gray-fg}{/right}`);
  chatLog.log(text);

  if (orchestratorMode || text.startsWith("/orchestrate ")) {
    await handleOrchestrate(text.replace("/orchestrate ", ""));
  } else if (text.startsWith("/codegraph ")) {
    await handleCodegraphQuery(text.replace("/codegraph ", ""));
  } else if (text.startsWith("/tool ")) {
    await handleToolQuery(text.replace("/tool ", "").trim());
  } else if (text.startsWith("/skill ")) {
    await handleSkill(text.replace("/skill ", ""));
  } else if (text.startsWith("/computer ")) {
    await handleComputerUseTUI(text.replace("/computer ", ""));
  } else if (text === "/health") {
    await handleHealthCheck();
  } else if (text === "/config") {
    switchPanel("config"); refreshConfigList();
  } else if (text === "/perf") {
    switchPanel("perf"); refreshPerfPanel();
  } else if (text === "/skills") {
    await handleSkillList();
  } else if (text === "/native") {
    await showNativeStatus();
  } else if (text === "/help") {
    showHelp();
  } else {
    await handleChat(text);
  }
});

// ─── Chat Handlers ──────────────────────────────────────────────────────────

async function handleChat(userInput: string) {
  try {
    chatLog.log("{cyan-fg}[意图识别] Recognizing intent...{/cyan-fg}");
    const { intent, messages } = buildAgentMessages(userInput);
    if (intent) chatLog.log(`{cyan-fg}[意图] ${intent.agentName} (${intent.intent}) — ${(intent.confidence * 100).toFixed(0)}%{/cyan-fg}`);
    const result = await router.routeByIntent(intent?.intent ?? "general-chat", messages);
    chatLog.log(`{gray-fg}⚡ ${result.provider} / ${result.model} [${result.layer}]{/gray-fg}`);
    chatLog.log(result.content ?? "(no response)");
    chatLog.log("");
  } catch (e) {
    chatLog.log(`{red-fg}[错误]: ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleOrchestrate(task: string) {
  try {
    chatLog.log("{yellow-fg}[编排] Orchestrating...{/yellow-fg}");
    const result = await orchestrator.execute(task);
    chatLog.log(`{yellow-fg}[完成] ${result.totalLatencyMs}ms | ${result.totalTokens} tokens{/yellow-fg}`);
    for (const r of result.subTaskResults) chatLog.log(`{gray-fg}[${r.layer}] ${r.model} (${r.latencyMs}ms){/gray-fg}`);
    chatLog.log("{bold}Final:{/bold}"); chatLog.log(result.finalAnswer); chatLog.log("");
  } catch (e) {
    chatLog.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleCodegraphQuery(query: string) {
  try {
    chatLog.log(`{green-fg}[CodeGraph] "${query}"{/green-fg}`);
    const result = await retrieveCodeMemory(query);
    if (result) { chatLog.log(`{green-fg}Found ${result.symbols.length} symbols{/green-fg}`); if (result.source === "codegraph") chatLog.log(result.results.slice(0, 2000)); }
    else chatLog.log("{gray-fg}No CodeGraph memory found.{/gray-fg}");
  } catch (e) {
    chatLog.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleToolQuery(roleInput: string) {
  const role = ["coding", "english", "rl", "general-tool"].includes(roleInput) ? roleInput : "general-tool";
  try {
    const result = await router.tool(role as ToolRole, [{ role: "user", content: "Ready." }]);
    chatLog.log(`{gray-fg}⚡ ${result.provider} / ${result.model}{/gray-fg}`);
    chatLog.log(result.content ?? "(no response)");
  } catch (e) {
    chatLog.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleSkill(query: string) {
  try {
    const { getSkillRegistry } = await import("../skills/skill-registry.js");
    const registry = getSkillRegistry();
    const match = registry.match(query);
    if (!match) { chatLog.log("{gray-fg}No skill matched.{/gray-fg}"); await handleChat(query); return; }
    const result = await registry.execute(match);
    chatLog.log(`{gray-fg}⚡ ${result.provider} / ${result.model} [${result.skillId}]{/gray-fg}`);
    chatLog.log(result.content);
  } catch (e) {
    chatLog.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleSkillList() {
  try {
    const { getSkillRegistry } = await import("../skills/skill-registry.js");
    const registry = getSkillRegistry();
    const stats = registry.stats();
    chatLog.log(`{blue-fg}[Skills] ${stats.total} total{/blue-fg}`);
  } catch (e) {
    chatLog.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleComputerUseTUI(task: string) {
  try {
    chatLog.log(`{cyan-fg}[Computer] ${task}{/cyan-fg}`);
    chatLog.log("{gray-fg}Requires CDP at http://127.0.0.1:9222{/gray-fg}");
  } catch (e) {
    chatLog.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

async function handleHealthCheck() {
  try {
    chatLog.log("{yellow-fg}[HealthCheck] Running...{/yellow-fg}");
    const report = await runHealthCheck();
    const icons: any = { ok: "✅", warning: "⚠️", error: "❌", skipped: "⏭️" };
    for (const check of report.checks.slice(0, 15)) chatLog.log(`  ${icons[check.status]} ${check.component.padEnd(20)} ${check.message.slice(0, 50)}`);
    chatLog.log(`{yellow-fg}Overall: ${report.overall.toUpperCase()}{/yellow-fg}`);
  } catch (e) {
    chatLog.log(`{red-fg}[错误] ${e instanceof Error ? e.message : String(e)}{/red-fg}`);
  }
  screen.render();
}

function showHelp() {
  chatLog.log("{bold}Commands:{/bold}");
  chatLog.log("  /orchestrate <task>  — Task orchestration");
  chatLog.log("  /codegraph <query>   — CodeGraph search");
  chatLog.log("  /tool <role>         — Tool pool");
  chatLog.log("  /skill <query>       — Skill match");
  chatLog.log("  /skills              — List skills");
  chatLog.log("  /computer <task>     — Computer Use");
  chatLog.log("  /health              — Health check");
  chatLog.log("  /config              — Config panel");
  chatLog.log("  /perf                — Performance panel");
  chatLog.log("  /native              — Native core status");
  chatLog.log("  /help                — This help");
  chatLog.log("  Ctrl+O               — Toggle orchestrator");
  chatLog.log("  Ctrl+S               — Refresh perf");
  chatLog.log("  Tab/F1-F4            — Switch panels");
  chatLog.log("  Ctrl+C               — Exit");
  screen.render();
}

// ─── Tool Health Refresh ────────────────────────────────────────────────────

function refreshToolHealth() {
  const stats = toolPool.getStats() as Record<string, any>;
  const grouped: Record<string, any[]> = {};
  for (const [id, s] of Object.entries(stats)) {
    if (!grouped[s.role]) grouped[s.role] = [];
    grouped[s.role].push({ id, ...s });
  }
  chatLog.log("{bold}Tool Pool Health:{/bold}");
  for (const [role, models] of Object.entries(grouped)) {
    chatLog.log(`  {bold}${role}{/bold}`);
    for (const m of models) {
      const icon = m.health.includes("[异常]") ? "🔴" : m.health.includes("[警告]") ? "🟡" : "🟢";
      chatLog.log(`    ${icon} ${m.id.split("/").pop()?.slice(0, 30)} ${m.rpmThisMinute}/${m.rpmLimit} RPM`);
    }
  }
  screen.render();
}

// ─── Periodic Refresh ───────────────────────────────────────────────────────

setInterval(async () => {
  if (currentPanel === "perf") refreshPerfPanel();
  try {
    const { getGlobalBlackboard } = await import("../memory/blackboard.js");
    const bb = getGlobalBlackboard();
    const bbStats = bb.stats();
    const { isNativeReady, getNativeEdition } = await import("../native-bridge.js");
    const nativeStatus = isNativeReady() ? `{green-fg}🦀 ${getNativeEdition()}{/green-fg}` : "{gray-fg}📜 TS-Only{/gray-fg}";
    chatStatus.setContent(
      "{bold}L1 Decision{/bold}:    [正常]\n" +
      "{bold}L2 Architecture{/bold}: [正常]\n" +
      "{bold}L3 Tool Pool{/bold}:    [正常]\n" +
      "{bold}L4 Evaluation{/bold}:   [正常]\n\n" +
      `{bold}黑板{/bold}: ${bbStats.totalEntries} 条目 (${bbStats.verifiedCount}✓ ${bbStats.conflictCount}⚠)\n` +
      `{bold}缓存{/bold}: ${bbStats.totalEntries > 0 ? "活跃" : "空"}\n` +
      `{bold}Native{/bold}: ${nativeStatus}`
    );
    if (currentPanel === "chat") screen.render();
  } catch { /* ignore */ }
}, 5000);

// ─── Startup ────────────────────────────────────────────────────────────────

export async function startTUI(): Promise<void> {
  chatInput.focus();
  chatLog.log("{center}{bold}Welcome to OpenClaw AI Agent v3.0 — Unified TUI{/bold}{/center}");
  chatLog.log("{center}Chat | Config (F2) | Diagnostics (F1) | Performance (F3) | Native (F4){/center}");
  chatLog.log("{center}Commands: /help | /config | /perf | /native{/center}\n");
  screen.render();
  logger.info("[TUI] Unified TUI started");
  await new Promise(() => {});
}

export function stopTUI(): void { /* placeholder for shutdown */ }

if (import.meta.url === `file://${process.argv[1]}`) startTUI();
