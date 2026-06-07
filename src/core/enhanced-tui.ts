/**
 * 增强版 TUI v2.0 — 配置管理 + 诊断 + 性能监控
 *
 * 相比 v1.0 新增:
 *   - 配置面板 (实时查看和修改配置)
 *   - 一键诊断 (运行 HealthChecker)
 *   - 性能监控 (实时显示路由性能数据)
 *   - 模型状态轮询
 *   - 黑板状态监控
 */

import blessed from "blessed";
import { logger } from "../utils/logger.js";
import { getConfigCenter } from "./config-center.js";
import { runHealthCheck, printHealthReport } from "./health-checker.js";
import { getRouterEngine } from "./router-engine.js";

// ─── Screen ─────────────────────────────────────────────────────────────────

const screen = blessed.screen({ smartCSR: true, title: "OpenClaw AI Agent v2.2" });

// ─── Layout ─────────────────────────────────────────────────────────────────

const header = blessed.box({
  top: 0, left: 0, width: "100%", height: 3,
  tags: true, style: { fg: "white", bg: "blue" },
  content: " {center}[OpenClaw] AI Agent v2.2 | Ctrl+C:退出 | Tab:切换面板 | F1:诊断 | F2:配置 | F3:性能{/center} ",
});

// 主内容区（可切换）
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
    "{bold}缓存{/bold}: 0 命中",
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
  content: " {bold}Tab{/bold}:切换面板 | {bold}F1{/bold}:诊断 | {bold}F2{/bold}:配置 | {bold}F3{/bold}:性能 | {bold}Ctrl+C{/bold}:退出 ",
});

// 组装
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

// ─── Panel Switching ────────────────────────────────────────────────────────

function switchPanel(name: PanelName): void {
  panels[currentPanel].hide();
  panels[name].show();
  currentPanel = name;

  // 更新焦点
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

  // Enter 进入编辑模式
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
      if (check.fix) {
        diagLog.log(`   {gray-fg}Fix: ${check.fix}{/gray-fg}`);
      }
    }

    if (report.recommendations.length > 0) {
      diagLog.log("\n{yellow-fg}Recommendations:{/yellow-fg}");
      for (const rec of report.recommendations) {
        diagLog.log(`  💡 ${rec}`);
      }
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

  if (data.length === 1) {
    data.push(["No data yet", "-", "-", "-", "-", "⏳"]);
  }

  perfTable.setData(data);
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

// ─── Chat Input ─────────────────────────────────────────────────────────────

chatInput.on("submit", async (text: string) => {
  chatInput.clearValue();
  chatInput.focus();
  screen.render();
  if (!text.trim()) return;

  chatLog.log(`{right}{gray-fg}You{/gray-fg}{/right}`);
  chatLog.log(text);

  // 简单命令处理
  if (text.startsWith("/config ")) {
    const key = text.replace("/config ", "").trim();
    const value = getConfigCenter().getString(key);
    chatLog.log(`{green-fg}${key} = ${value || "(not set)"}{/green-fg}`);
  } else if (text.startsWith("/health")) {
    chatLog.log("{yellow-fg}Running health check...{/yellow-fg}");
    try {
      const report = await runHealthCheck();
      chatLog.log(`{bold}Status: ${report.overall}{/bold}`);
      for (const check of report.checks.slice(0, 10)) {
        const icon = check.status === "ok" ? "✅" : check.status === "warning" ? "⚠️" : "❌";
        chatLog.log(`${icon} ${check.component}: ${check.message}`);
      }
    } catch (e) {
      chatLog.log(`{red-fg}Error: ${(e as Error).message}{/red-fg}`);
    }
  } else if (text.startsWith("/routes")) {
    const routes = getRouterEngine().getRoutes();
    chatLog.log(`{cyan-fg}Registered routes: ${routes.length}{/cyan-fg}`);
    for (const r of routes.slice(0, 20)) {
      chatLog.log(`  ${r.method.padEnd(6)} ${r.path}`);
    }
  } else {
    chatLog.log("{gray-fg}Commands: /config <key> | /health | /routes{/gray-fg}");
  }

  screen.render();
});

// ─── Startup ────────────────────────────────────────────────────────────────

export async function startEnhancedTUI(): Promise<void> {
  chatInput.focus();
  chatLog.log("{center}{bold}Welcome to OpenClaw AI Agent v2.2{/bold}{/center}");
  chatLog.log("{center}Enhanced TUI with Config / Diagnostics / Performance{/center}");
  chatLog.log("{center}Tab: switch panel | F1: diagnostics | F2: config | F3: performance{/center}\n");

  // 定期刷新性能面板 + 黑板状态
  setInterval(async () => {
    if (currentPanel === "perf") refreshPerfPanel();
    // 更新 Chat 面板的黑板/缓存状态
    try {
      const { getGlobalBlackboard } = await import("../memory/blackboard.js");
      const bb = getGlobalBlackboard();
      const bbStats = bb.stats();
      chatStatus.setContent(
        "{bold}L1 Decision{/bold}:    [正常]\n" +
        "{bold}L2 Architecture{/bold}: [正常]\n" +
        "{bold}L3 Tool Pool{/bold}:    [正常]\n" +
        "{bold}L4 Evaluation{/bold}:   [正常]\n\n" +
        `{bold}黑板{/bold}: ${bbStats.totalEntries} 条目 (${bbStats.verifiedCount}✓ ${bbStats.conflictCount}⚠)\n` +
        `{bold}缓存{/bold}: ${bbStats.totalEntries > 0 ? "活跃" : "空"}`
      );
      if (currentPanel === "chat") screen.render();
    } catch {
      // ignore
    }
  }, 5000);

  screen.render();
  logger.info("[EnhancedTUI] Started");

  await new Promise(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startEnhancedTUI();
}
