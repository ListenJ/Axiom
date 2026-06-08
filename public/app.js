/** OpenClaw SPA v2.3 — Enhanced with Native Bridge & Edition Detection */
const API = "";
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
let ws = null;
let currentPage = "chat";
let sidebarOpen = window.innerWidth > 768;
let darkMode = localStorage.getItem("theme") !== "light";
let systemEdition = "unknown";
let nativeConnected = false;
let perfData = {};

// ===== Theme =====
function applyTheme() {
  document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  const btn = document.getElementById("themeBtn");
  if (btn) btn.textContent = darkMode ? "☀️" : "🌙";
}
document.getElementById("themeBtn").onclick = () => {
  darkMode = !darkMode;
  localStorage.setItem("theme", darkMode ? "dark" : "light");
  applyTheme();
};
applyTheme();

// ===== Edition Detection =====
async function detectEdition() {
  try {
    const res = await fetch("/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      systemEdition = data.edition || "typescript";
      updateEditionBadge();
    }
  } catch { /* ignore */ }
}

function updateEditionBadge() {
  const badge = document.getElementById("editionBadge");
  if (!badge) return;
  const labels = {
    local: "🏠 Local",
    cloud: "☁️ Cloud",
    typescript: "📜 TS-Only",
  };
  const colors = {
    local: "var(--success)",
    cloud: "var(--accent)",
    typescript: "var(--warning)",
  };
  badge.textContent = labels[systemEdition] || systemEdition;
  badge.style.background = colors[systemEdition] || "var(--muted)";
}

// ===== Native Bridge Status =====
async function checkNativeStatus() {
  try {
    const res = await fetch("http://127.0.0.1:18790/health", { signal: AbortSignal.timeout(1000) });
    nativeConnected = res.ok;
    updateNativeIndicator();
  } catch {
    nativeConnected = false;
    updateNativeIndicator();
  }
}

function updateNativeIndicator() {
  const el = document.getElementById("nativeIndicator");
  if (!el) return;
  el.textContent = nativeConnected ? "🦀 Rust Core" : "📜 TS Core";
  el.style.color = nativeConnected ? "var(--success)" : "var(--muted)";
}

// ===== Performance Metrics =====
async function fetchPerfMetrics() {
  try {
    const res = await fetch("/native/router/perf", { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      perfData = await res.json();
      renderPerfPanel();
    }
  } catch { /* ignore */ }
}

function renderPerfPanel() {
  const panel = document.getElementById("perfPanel");
  if (!panel) return;
  if (!perfData.hotspots || perfData.hotspots.length === 0) {
    panel.innerHTML = "<p class='text-muted'>No performance data yet.</p>";
    return;
  }
  const rows = perfData.hotspots.map(([ep, count, avg, suggestion]) => `
    <tr>
      <td><code>${ep}</code></td>
      <td>${count.toLocaleString()}</td>
      <td>${avg}μs</td>
      <td><span class="badge ${avg > 5000 ? 'badge-warn' : 'badge-ok'}">${suggestion}</span></td>
    </tr>
  `).join("");
  panel.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Endpoint</th><th>Requests</th><th>Avg</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ===== Navigation =====
const pages = {
  chat: { label: "Chat", icon: "💬", desc: "与 Agent 沟通" },
  search: { label: "Search", icon: "🔍", desc: "Vault / Web 搜索" },
  kg: { label: "KG", icon: "🕸️", desc: "知识图谱可视化" },
  perf: { label: "Performance", icon: "📊", desc: "性能监控" },
  settings: { label: "Settings", icon: "⚙️", desc: "配置中心" },
};

function renderNav() {
  const nav = document.getElementById("navItems");
  if (!nav) return;
  nav.innerHTML = Object.entries(pages).map(([id, p]) =>
    `<div class="nav-item ${id === currentPage ? "active" : ""}" data-page="${id}"><span class="icon">${p.icon}</span>${p.label}</div>`
  ).join("");
  nav.querySelectorAll(".nav-item").forEach(el => el.onclick = () => navigate(el.dataset.page));

  const bottom = document.getElementById("bottomNav");
  if (!bottom) return;
  bottom.innerHTML = Object.entries(pages).map(([id, p]) =>
    `<button class="bottom-nav-item ${id === currentPage ? "active" : ""}" data-page="${id}"><span class="icon">${p.icon}</span>${p.label}</button>`
  ).join("");
  bottom.querySelectorAll(".bottom-nav-item").forEach(el => el.onclick = () => navigate(el.dataset.page));
}

function navigate(page) {
  currentPage = page;
  document.getElementById("pageTitle").textContent = pages[page]?.label || page;
  renderNav();
  document.querySelectorAll(".page").forEach(el => el.classList.add("hidden"));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.remove("hidden");
  if (page === "perf") { fetchPerfMetrics(); fetchNativeStatus(); }
}

async function fetchNativeStatus() {
  try {
    const res = await fetch("http://127.0.0.1:18790/health", { signal: AbortSignal.timeout(1500) });
    const panel = document.getElementById("nativeStatusPanel");
    if (!panel) return;
    if (res.ok) {
      const data = await res.json();
      panel.innerHTML = `
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <div class="card" style="flex:1;min-width:200px;">
            <div class="metric-label">Edition</div>
            <div class="metric" style="font-size:1.2rem;">${data.edition === "cloud" ? "☁️ Cloud" : "🏠 Local"}</div>
          </div>
          <div class="card" style="flex:1;min-width:200px;">
            <div class="metric-label">Version</div>
            <div class="metric" style="font-size:1.2rem;">${data.version}</div>
          </div>
          <div class="card" style="flex:1;min-width:200px;">
            <div class="metric-label">Status</div>
            <div class="metric" style="font-size:1.2rem;color:var(--success);">● Online</div>
          </div>
        </div>
      `;
    } else {
      panel.innerHTML = `<p class="text-muted">📜 Rust core not running. TypeScript-only mode active.</p>
        <p class="text-muted" style="font-size:0.8rem;">To enable: <code>bun run native:build</code> then restart.</p>`;
    }
  } catch {
    const panel = document.getElementById("nativeStatusPanel");
    if (panel) panel.innerHTML = `<p class="text-muted">📜 Rust core not running. TypeScript-only mode active.</p>`;
  }
}

// ===== WebSocket =====
function connectWS() {
  if (ws) ws.close();
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    document.getElementById("wsStatus").textContent = "🟢";
    document.getElementById("wsStatus").title = "Connected";
  };
  ws.onclose = () => {
    document.getElementById("wsStatus").textContent = "🔴";
    document.getElementById("wsStatus").title = "Disconnected";
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "heartbeat") {
        document.getElementById("uptime").textContent = formatUptime(msg.payload.uptime);
        document.getElementById("vaultNotes").textContent = msg.payload.vaultNotes?.toLocaleString() || "0";
      } else if (msg.type === "vault_change") {
        appendSystemLog(`Vault: ${msg.payload.event} ${msg.payload.file}`);
      } else if (msg.type === "native_status") {
        nativeConnected = msg.payload.connected;
        updateNativeIndicator();
      }
    } catch {}
  };
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

// ===== Chat =====
const chatHistory = [];
function appendMessage(role, text, meta = "") {
  const chatLog = document.getElementById("chatLog");
  const div = document.createElement("div");
  div.className = `message ${role}`;
  const metaHtml = meta ? `<span class="meta">${meta}</span>` : "";
  div.innerHTML = `${metaHtml}<div class="bubble">${escapeHtml(text)}</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendSystemLog(text) {
  const chatLog = document.getElementById("chatLog");
  const div = document.createElement("div");
  div.className = "message system";
  div.innerHTML = `<div class="bubble system-bubble">${escapeHtml(text)}</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function sendChat() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendMessage("user", text);

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": localStorage.getItem("apiKey") || "",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
    });
    const data = await res.json();
    if (data.error) {
      appendMessage("assistant", `Error: ${data.error}`, "⚠️");
    } else {
      const model = data.model || "";
      const provider = data.provider || "";
      appendMessage("assistant", data.content || "(no response)", `${provider}/${model}`);
    }
  } catch (e) {
    appendMessage("assistant", `Network error: ${e.message}`, "🔴");
  }
}

document.getElementById("chatInput").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
};

document.getElementById("sendBtn").onclick = sendChat;

// ===== Search =====
async function doSearch() {
  const q = document.getElementById("searchInput").value.trim();
  if (!q) return;
  const resultsDiv = document.getElementById("searchResults");
  resultsDiv.innerHTML = "<p class='text-muted'>Searching...</p>";

  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}&limit=10`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      resultsDiv.innerHTML = "<p class='text-muted'>No results found.</p>";
      return;
    }
    resultsDiv.innerHTML = data.results.map(r => `
      <div class="result-card">
        <div class="result-title">${escapeHtml(r.note.title)} <span class="score">${r.score.toFixed(1)}</span></div>
        <div class="result-path">${escapeHtml(r.note.path)}</div>
        <div class="result-excerpt">${escapeHtml(r.excerpt)}</div>
        <div class="result-reasons">${r.reasons.map(x => `<span class="tag">${escapeHtml(x)}</span>`).join("")}</div>
      </div>
    `).join("");
  } catch (e) {
    resultsDiv.innerHTML = `<p class='text-error'>Error: ${escapeHtml(e.message)}</p>`;
  }
}

document.getElementById("searchBtn").onclick = doSearch;
document.getElementById("searchInput").onkeydown = (e) => {
  if (e.key === "Enter") doSearch();
};

// ===== Settings =====
function saveSettings() {
  const apiKey = document.getElementById("settingApiKey").value;
  localStorage.setItem("apiKey", apiKey);
  appendSystemLog("Settings saved.");
}

document.getElementById("saveSettingsBtn").onclick = saveSettings;

// ===== Sidebar Toggle =====
document.getElementById("menuBtn").onclick = () => {
  sidebarOpen = !sidebarOpen;
  document.getElementById("sidebar").classList.toggle("collapsed", !sidebarOpen);
};

// ===== Init =====
detectEdition();
checkNativeStatus();
connectWS();
renderNav();
navigate("chat");

// Update sidebar edition badge
(async () => {
  try {
    const res = await fetch("/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const se = document.getElementById("sidebarEdition");
      if (se) se.textContent = data.edition === "cloud" ? "Cloud" : "Local";
    }
  } catch {}
})();

// Periodic refresh
setInterval(() => {
  checkNativeStatus();
}, 10000);

setInterval(() => {
  if (currentPage === "perf") fetchPerfMetrics();
}, 5000);
