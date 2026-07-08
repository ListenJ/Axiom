/**
 * Axiom Installation Wizard v2.3
 * TUI-based interactive installer for Local / Cloud edition selection
 *
 * Run: bun run src/tui/install-wizard.ts
 */
import blessed from "blessed";
import fs from "fs";
import path from "path";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type InstallEdition = "local" | "cloud";

interface InstallConfig {
  edition: InstallEdition;
  port: number;
  bind: string;
  vaultPath: string;
  dbPath: string;
  databaseUrl?: string;
  redisUrl?: string;
  installRust: boolean;
  apiKey?: string;
}

// ═══════════════════════════════════════════════════════════════
// UI State
// ═══════════════════════════════════════════════════════════════

let screen: blessed.Widgets.Screen;
let currentStep = 0;
let config: InstallConfig = {
  edition: "local",
  port: 18789,
  bind: "127.0.0.1",
  vaultPath: "./axiom-memory",
  dbPath: "./data/agent.db",
  installRust: false,
};

const STEPS = ["edition", "network", "storage", "rust", "review", "install"];

// ═══════════════════════════════════════════════════════════════
// Screen Setup
// ═══════════════════════════════════════════════════════════════

function createScreen(): blessed.Widgets.Screen {
  return blessed.screen({
    smartCSR: true,
    title: "Axiom Installer v2.3",
  });
}

function createLayout() {
  const header = blessed.box({
    top: 0, left: 0, width: "100%", height: 3,
    tags: true,
    style: { fg: "white", bg: "blue" },
    content: " {center}{bold}Axiom AI Agent v2.3 — Installation Wizard{/bold}{/center} ",
  });

  const progress = (blessed as any).progressbar({
    top: 3, left: 0, width: "100%", height: 1,
    filled: 0,
    style: { bar: { bg: "green" } },
  });

  const content = blessed.box({
    top: 4, left: 0, width: "100%", height: "85%",
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
  });

  const footer = blessed.box({
    bottom: 0, left: 0, width: "100%", height: 2,
    tags: true,
    style: { fg: "gray" },
    content: " {bold}↑↓{/bold}: Navigate | {bold}Enter{/bold}: Select | {bold}Tab{/bold}: Next | {bold}Ctrl+C{/bold}: Exit ",
  });

  return { header, progress, content, footer };
}

// ═══════════════════════════════════════════════════════════════
// Step: Edition Selection
// ═══════════════════════════════════════════════════════════════

function renderEditionStep(contentBox: blessed.Widgets.BoxElement) {
  contentBox.setContent("");

  blessed.text({
    parent: contentBox,
    top: 1, left: 2,
    tags: true,
    content: "{bold}Select Deployment Edition{/bold}\n\n" +
      "Choose the edition that matches your environment:\n\n",
  });

  const localBox = blessed.box({
    parent: contentBox,
    top: 5, left: 4, width: "40%", height: 12,
    border: { type: "line" },
    style: {
      border: { fg: config.edition === "local" ? "green" : "gray" },
      bg: config.edition === "local" ? "green" : undefined,
    },
    tags: true,
    content:
      "{center}{bold}🏠 LOCAL{/bold}{/center}\n\n" +
      "  • Single-node, lightweight\n" +
      "  • SQLite single-file storage\n" +
      "  • Memory-based caching\n" +
      "  • No external dependencies\n" +
      "  • Ideal for: laptop, desktop,\n" +
      "    edge device, personal use\n\n" +
      "  {green-fg}✓ Recommended for beginners{/green-fg}",
  });

  const cloudBox = blessed.box({
    parent: contentBox,
    top: 5, left: "52%", width: "40%", height: 12,
    border: { type: "line" },
    style: {
      border: { fg: config.edition === "cloud" ? "yellow" : "gray" },
      bg: config.edition === "cloud" ? "yellow" : undefined,
    },
    tags: true,
    content:
      "{center}{bold}☁️  CLOUD{/bold}{/center}\n\n" +
      "  • Multi-node, scalable\n" +
      "  • PostgreSQL + Redis\n" +
      "  • Distributed caching\n" +
      "  • Load balancing ready\n" +
      "  • Ideal for: server, VPS,\n" +
      "    Kubernetes, team use\n\n" +
      "  {yellow-fg}⚡ Requires external DB{/yellow-fg}",
  });

  const hint = blessed.text({
    parent: contentBox,
    bottom: 1, left: 2,
    tags: true,
    content: "{gray-fg}Press ← → or Tab to switch edition, Enter to confirm{/gray-fg}",
  });
}

// ═══════════════════════════════════════════════════════════════
// Step: Network Configuration
// ═══════════════════════════════════════════════════════════════

function renderNetworkStep(contentBox: blessed.Widgets.BoxElement) {
  contentBox.setContent("");

  blessed.text({
    parent: contentBox,
    top: 1, left: 2,
    tags: true,
    content: "{bold}Network Configuration{/bold}\n\n",
  });

  const form = blessed.form({
    parent: contentBox,
    top: 3, left: 4, width: "60%", height: 10,
    keys: true,
    vi: false,
  });

  blessed.text({ parent: form, top: 0, left: 0, content: "Port:" });
  const portInput = blessed.textbox({
    parent: form, top: 0, left: 12, width: 10, height: 1,
    inputOnFocus: true,
    value: String(config.port),
    style: { fg: "white", focus: { fg: "yellow" } },
  });

  blessed.text({ parent: form, top: 2, left: 0, content: "Bind:" });
  const bindInput = blessed.textbox({
    parent: form, top: 2, left: 12, width: 20, height: 1,
    inputOnFocus: true,
    value: config.bind,
    style: { fg: "white", focus: { fg: "yellow" } },
  });

  blessed.text({ parent: form, top: 4, left: 0, content: "API Key:" });
  const keyInput = blessed.textbox({
    parent: form, top: 4, left: 12, width: 40, height: 1,
    inputOnFocus: true,
    value: config.apiKey ?? "",
    censor: true,
    style: { fg: "white", focus: { fg: "yellow" } },
  });

  const saveBtn = blessed.button({
    parent: form, top: 7, left: 0, width: 20, height: 1,
    content: "Save & Continue",
    style: { fg: "white", bg: "green", focus: { bg: "yellow" } },
    align: "center",
  });

  saveBtn.on("press", () => {
    const parsed = parseInt(portInput.getValue(), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      config.port = 18789;
    } else {
      config.port = parsed;
    }
    config.bind = bindInput.getValue() || "127.0.0.1";
    config.apiKey = keyInput.getValue() || undefined;
    nextStep();
  });

  portInput.focus();
}

// ═══════════════════════════════════════════════════════════════
// Step: Storage Configuration
// ═══════════════════════════════════════════════════════════════

function renderStorageStep(contentBox: blessed.Widgets.BoxElement) {
  contentBox.setContent("");

  blessed.text({
    parent: contentBox,
    top: 1, left: 2,
    tags: true,
    content: `{bold}Storage Configuration{/bold} (${config.edition} edition)\n\n`,
  });

  const form = blessed.form({
    parent: contentBox,
    top: 3, left: 4, width: "70%", height: 14,
    keys: true,
  });

  blessed.text({ parent: form, top: 0, left: 0, content: "Vault Path:" });
  const vaultInput = blessed.textbox({
    parent: form, top: 0, left: 14, width: 40, height: 1,
    inputOnFocus: true,
    value: config.vaultPath,
  });

  if (config.edition === "local") {
    blessed.text({ parent: form, top: 2, left: 0, content: "SQLite DB:" });
    const dbInput = blessed.textbox({
      parent: form, top: 2, left: 14, width: 40, height: 1,
      inputOnFocus: true,
      value: config.dbPath,
    });

    const saveBtn = blessed.button({
      parent: form, top: 5, left: 0, width: 20, height: 1,
      content: "Save & Continue",
      style: { fg: "white", bg: "green", focus: { bg: "yellow" } },
      align: "center",
    });

    saveBtn.on("press", () => {
      config.vaultPath = vaultInput.getValue() || "./axiom-memory";
      config.dbPath = dbInput.getValue() || "./data/agent.db";
      nextStep();
    });
    vaultInput.focus();
  } else {
    blessed.text({ parent: form, top: 2, left: 0, content: "PostgreSQL URL:" });
    const pgInput = blessed.textbox({
      parent: form, top: 2, left: 16, width: 50, height: 1,
      inputOnFocus: true,
      value: config.databaseUrl ?? "postgres://user:pass@localhost/axiom",
    });

    blessed.text({ parent: form, top: 4, left: 0, content: "Redis URL:" });
    const redisInput = blessed.textbox({
      parent: form, top: 4, left: 16, width: 50, height: 1,
      inputOnFocus: true,
      value: config.redisUrl ?? "redis://127.0.0.1:6379",
    });

    const saveBtn = blessed.button({
      parent: form, top: 7, left: 0, width: 20, height: 1,
      content: "Save & Continue",
      style: { fg: "white", bg: "green", focus: { bg: "yellow" } },
      align: "center",
    });

    saveBtn.on("press", () => {
      config.vaultPath = vaultInput.getValue() || "./axiom-memory";
      config.databaseUrl = pgInput.getValue() || undefined;
      config.redisUrl = redisInput.getValue() || undefined;
      nextStep();
    });
    vaultInput.focus();
  }
}

// ═══════════════════════════════════════════════════════════════
// Step: Rust Core Build
// ═══════════════════════════════════════════════════════════════

function renderRustStep(contentBox: blessed.Widgets.BoxElement) {
  contentBox.setContent("");

  blessed.text({
    parent: contentBox,
    top: 1, left: 2,
    tags: true,
    content:
      "{bold}Rust Native Core{/bold}\n\n" +
      "The Rust core provides 5-20x performance improvement for:\n" +
      "  • Deterministic search engine\n" +
      "  • Trie routing engine\n" +
      "  • Memory cache layer\n\n" +
      "Requirements: Rust 1.78+, ~500MB disk for build artifacts\n",
  });

  const buildBox = blessed.box({
    parent: contentBox,
    top: 10, left: 4, width: "50%", height: 6,
    border: { type: "line" },
    style: { border: { fg: config.installRust ? "green" : "gray" } },
    tags: true,
    content:
      "{center}{bold}Build Rust Core{/bold}{/center}\n\n" +
      "  {green-fg}✓{/green-fg} High-performance native code\n" +
      "  {green-fg}✓{/green-fg} Lower CPU & memory usage\n" +
      "  {yellow-fg}⚠{/yellow-fg} Requires Rust toolchain (~5 min build)",
  });

  const skipBox = blessed.box({
    parent: contentBox,
    top: 10, left: "56%", width: "30%", height: 6,
    border: { type: "line" },
    style: { border: { fg: !config.installRust ? "green" : "gray" } },
    tags: true,
    content:
      "{center}{bold}Skip{/bold}{/center}\n\n" +
      "  Use TypeScript-only mode\n" +
      "  (slower but no build)",
  });

  blessed.text({
    parent: contentBox,
    bottom: 1, left: 2,
    tags: true,
    content: "{gray-fg}Press ← → to select, Enter to confirm{/gray-fg}",
  });
}

// ═══════════════════════════════════════════════════════════════
// Step: Review
// ═══════════════════════════════════════════════════════════════

function renderReviewStep(contentBox: blessed.Widgets.BoxElement) {
  contentBox.setContent("");

  const lines: string[] = [
    "{bold}Installation Summary{/bold}\n",
    `  Edition:     {bold}${config.edition.toUpperCase()}{/bold}`,
    `  Port:        ${config.port}`,
    `  Bind:        ${config.bind}`,
    `  Vault:       ${config.vaultPath}`,
  ];

  if (config.edition === "local") {
    lines.push(`  SQLite DB:   ${config.dbPath}`);
  } else {
    lines.push(`  PostgreSQL:  ${config.databaseUrl ?? "(not set)"}`);
    lines.push(`  Redis:       ${config.redisUrl ?? "(not set)"}`);
  }

  lines.push(`  Rust Core:   ${config.installRust ? "Yes (will build)" : "No (TS-only)"}`);
  lines.push(`  API Key:     ${config.apiKey ? "✓ Set" : "⚠ Not set (all requests rejected)"}`);

  lines.push("\n{bold}Files to be created:{/bold}");
  lines.push("  .env                  — Environment variables");
  lines.push("  config/axiom.yaml  — Main configuration");
  if (config.installRust) {
    lines.push("  native/target/release/ — Rust binaries");
  }

  blessed.text({
    parent: contentBox,
    top: 1, left: 2,
    tags: true,
    content: lines.join("\n"),
  });

  const installBtn = blessed.button({
    parent: contentBox,
    bottom: 3, left: "center", width: 30, height: 3,
    content: "{center}{bold}🚀 INSTALL NOW{/bold}{/center}",
    border: { type: "line" },
    style: { fg: "white", bg: "green", focus: { bg: "yellow" } },
    align: "center", valign: "middle",
  });

  installBtn.on("press", () => nextStep());
  installBtn.focus();
}

// ═══════════════════════════════════════════════════════════════
// Step: Install Progress
// ═══════════════════════════════════════════════════════════════

function renderInstallStep(contentBox: blessed.Widgets.BoxElement) {
  contentBox.setContent("");

  const log = blessed.log({
    parent: contentBox,
    top: 1, left: 2, width: "96%", height: "90%",
    border: { type: "line" },
    style: { border: { fg: "green" }, fg: "white" },
    tags: true, scrollable: true, alwaysScroll: true,
  });

  runInstallation(log).catch((e) => {
    log.log(`{red-fg}Installation failed: ${e.message}{/red-fg}`);
  });
}

async function runInstallation(log: blessed.Widgets.Log) {
  log.log("{cyan-fg}[1/5] Creating directories...{/cyan-fg}");
  await Bun.write("./data/.gitkeep", "").catch(() => {});
  await Bun.write("./data/logs/.gitkeep", "").catch(() => {});
  log.log("  ✓ data/");

  log.log("{cyan-fg}[2/5] Writing .env...{/cyan-fg}");
  const envLines = [
    `AXIOM_GATEWAY_PORT=${config.port}`,
    `AXIOM_AUTH_TOKEN=${config.apiKey ?? ""}`,
    `OBSIDIAN_VAULT_PATH=${config.vaultPath}`,
    `DATABASE_PATH=${config.dbPath}`,
    `AXIOM_EDITION=${config.edition}`,
    `LOG_LEVEL=info`,
    "",
    "# Model Providers (optional)",
    "# SILICONFLOW_API_KEY=",
    "# DEEPSEEK_API_KEY=",
    "# OPENROUTER_API_KEY=",
    "# MINIMAX_API_KEY=",
    "",
    "# Cloud-only",
  ];
  if (config.edition === "cloud") {
    if (config.databaseUrl) envLines.push(`DATABASE_URL=${config.databaseUrl}`);
    if (config.redisUrl) envLines.push(`REDIS_URL=${config.redisUrl}`);
  }
  fs.writeFileSync(".env", envLines.join("\n") + "\n");
  log.log("  ✓ .env");

  log.log("{cyan-fg}[3/5] Writing config/axiom.yaml...{/cyan-fg}");
  const yamlContent = generateConfigYaml();
  fs.writeFileSync("config/axiom.yaml", yamlContent);
  log.log("  ✓ config/axiom.yaml");

  if (config.installRust) {
    log.log("{cyan-fg}[4/5] Building Rust core (this may take 3-5 minutes)...{/cyan-fg}");
    const features = config.edition === "cloud" ? "cloud" : "local";
    const proc = Bun.spawn({
      cmd: ["cargo", "build", "--release", "--features", features],
      cwd: "./native",
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      log.log(`  ✓ Rust core built (${features})`);
    } else {
      log.log("  {yellow-fg}⚠ Rust build failed — falling back to TypeScript-only{/yellow-fg}");
    }
  } else {
    log.log("{cyan-fg}[4/5] Skipping Rust build (TypeScript-only mode){/cyan-fg}");
  }

  log.log("{cyan-fg}[5/5] Finalizing...{/cyan-fg}");
  fs.writeFileSync(".axiom-installed", JSON.stringify({
    edition: config.edition,
    version: "2.3.0",
    installedAt: new Date().toISOString(),
    rustEnabled: config.installRust,
  }, null, 2));
  log.log("  ✓ .axiom-installed");

  log.log("\n{green-fg}{bold}✅ Installation complete!{/bold}{/green-fg}");
  log.log(`\nStart with: {bold}bun run src/main.ts{/bold}`);
  log.log(`Or TUI mode: {bold}bun run src/tui/app.ts{/bold}`);
  log.log(`\nPress Ctrl+C to exit.`);
}

function generateConfigYaml(): string {
  return `gateway:
  port: ${config.port}
  bind: "${config.bind}"
  auth:
    token: "\${AXIOM_AUTH_TOKEN}"

edition: ${config.edition}

memory:
  vaultPath: "\${OBSIDIAN_VAULT_PATH}"
  databasePath: "\${DATABASE_PATH}"
${config.edition === "cloud" ? `
  postgresql:
    url: "\${DATABASE_URL}"
  redis:
    url: "\${REDIS_URL}"
` : ""}

native:
  enabled: ${config.installRust}
  port: ${config.port + 1}
  edition: ${config.edition}
`;
}

// ═══════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════

function renderCurrentStep() {
  const { content, progress } = createLayoutRefs();
  const stepName = STEPS[currentStep];
  progress.filled = Math.round(((currentStep + 1) / STEPS.length) * 100);

  switch (stepName) {
    case "edition": renderEditionStep(content); break;
    case "network": renderNetworkStep(content); break;
    case "storage": renderStorageStep(content); break;
    case "rust": renderRustStep(content); break;
    case "review": renderReviewStep(content); break;
    case "install": renderInstallStep(content); break;
  }

  screen.render();
}

let layoutRefs: { content: blessed.Widgets.BoxElement; progress: any } | null = null;

function createLayoutRefs() {
  if (!layoutRefs) {
    const { content, progress } = createLayout();
    screen.append(createLayout().header);
    screen.append(progress);
    screen.append(content);
    screen.append(createLayout().footer);
    layoutRefs = { content, progress };
  }
  return layoutRefs;
}

function nextStep() {
  if (currentStep < STEPS.length - 1) {
    currentStep++;
    renderCurrentStep();
  }
}

function prevStep() {
  if (currentStep > 0) {
    currentStep--;
    renderCurrentStep();
  }
}

// ═══════════════════════════════════════════════════════════════
// Keyboard Handlers
// ═══════════════════════════════════════════════════════════════

function setupKeyboard() {
  screen.key(["C-c"], () => process.exit(0));

  // Tab only advances/retreats the wizard when focus is NOT inside a form
  // field. When a textbox/button is focused we let Tab traverse fields
  // instead, so the Network step's Port/Bind/API Key inputs are reachable.
  const isFormField = (el: blessed.Widgets.Node | null | undefined): boolean =>
    !!el && (el.type === "textbox" || el.type === "textarea" || el.type === "button");

  screen.key(["tab"], () => {
    if (isFormField(screen.focused)) {
      screen.focusNext();
    } else {
      nextStep();
    }
  });
  screen.key(["S-tab"], () => {
    if (isFormField(screen.focused)) {
      screen.focusPrevious();
    } else {
      prevStep();
    }
  });

  screen.key(["right"], () => {
    if (STEPS[currentStep] === "edition") {
      config.edition = "cloud";
      renderCurrentStep();
    } else if (STEPS[currentStep] === "rust") {
      config.installRust = true;
      renderCurrentStep();
    }
  });

  screen.key(["left"], () => {
    if (STEPS[currentStep] === "edition") {
      config.edition = "local";
      renderCurrentStep();
    } else if (STEPS[currentStep] === "rust") {
      config.installRust = false;
      renderCurrentStep();
    }
  });

  screen.key(["enter"], () => {
    if (STEPS[currentStep] === "edition") nextStep();
    else if (STEPS[currentStep] === "rust") nextStep();
  });
}

// ═══════════════════════════════════════════════════════════════
// Main Entry
// ═══════════════════════════════════════════════════════════════

export async function startInstallWizard(): Promise<void> {
  screen = createScreen();
  createLayoutRefs();
  setupKeyboard();
  renderCurrentStep();

  // Keep process alive
  await new Promise(() => {});
}

// Direct run
if (import.meta.url === `file://${process.argv[1]}`) {
  startInstallWizard();
}
