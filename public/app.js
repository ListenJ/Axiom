/** OpenClaw SPA v2.3 — Production Ready Frontend */
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
let ws = null;
let currentPage = "chat";
let sidebarOpen = window.innerWidth > 768;
let darkMode = localStorage.getItem("theme") !== "light";
let systemEdition = "unknown";
let nativeConnected = false;
let perfData = {};
let isTyping = false;
const chatHistory = [];
const toastQueue = [];

// ===== Theme =====
function applyTheme() {
  document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  const btn = document.getElementById("themeBtn");
  if (btn) btn.innerHTML = darkMode
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}

function setTheme(mode) {
  if (mode === "auto") {
    darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
    localStorage.removeItem("theme");
  } else {
    darkMode = mode === "dark";
    localStorage.setItem("theme", darkMode ? "dark" : "light");
  }
  applyTheme();
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!localStorage.getItem("theme")) { darkMode = e.matches; applyTheme(); }
});

applyTheme();

document.getElementById("themeBtn").onclick = () => setTheme(darkMode ? "light" : "dark");

// ===== Toast =====
function showToast(message, type = "info", duration = 3000) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icons = { info: "ℹ️", success: "✅", warn: "⚠️", error: "❌" };
  toast.innerHTML = `${icons[type] || "ℹ️"} ${escapeHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ===== Markdown Parser =====
function parseMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks with language
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang || "text";
    const id = "code-" + Math.random().toString(36).slice(2, 8);
    return `<div class="code-block-header"><span>${langLabel}</span><button class="code-copy-btn" data-code="${encodeURIComponent(code.trim())}" onclick="copyCode(this)">复制</button></div><pre><code>${escapeHtml(code.trim())}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold / Italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Blockquote
  html = html.replace(/^\> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/(<\/blockquote>\s*<blockquote>)/g, '<br>');

  // Lists
  html = html.replace(/^(\s*)- (.+)$/gm, (_, indent, text) => {
    const depth = indent.length / 2;
    return `<li style="margin-left:${depth * 20}px">${text}</li>`;
  });
  html = html.replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/<ul>(\s*<li)/g, '$1');
  html = html.replace(/(<\/li>)\s*<\/ul>\s*<ul>/g, '$1');

  // Ordered lists
  html = html.replace(/^(\s*)\d+\. (.+)$/gm, (_, indent, text) => {
    const depth = indent.length / 2;
    return `<li style="margin-left:${depth * 20}px">${text}</li>`;
  });

  // Tables
  const tableRegex = /\|(.+)\|\n\|[-\s|]+\|\n((?:\|.+\|\n?)+)/;
  html = html.replace(tableRegex, (match, header, rows) => {
    const headers = header.split("|").map(h => h.trim()).filter(Boolean);
    const rowData = rows.trim().split("\n").map(r => r.split("|").map(c => c.trim()).filter(Boolean));
    let table = "<table>\n<thead>\n<tr>" + headers.map(h => `<th>${h}</th>`).join("") + "</tr>\n</thead>\n<tbody>\n";
    rowData.forEach(row => {
      table += "<tr>" + row.map(c => `<td>${c}</td>`).join("") + "</tr>\n";
    });
    table += "</tbody>\n</table>";
    return table;
  });

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent)">$1</a>');

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<\/?(?:h[1-6]|ul|ol|li|blockquote|pre|table|div)[^>]*>)<\/p>/g, '$1');

  return html;
}

function copyCode(btn) {
  const code = decodeURIComponent(btn.dataset.code);
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "✓ 已复制";
    btn.style.color = "var(--success)";
    setTimeout(() => { btn.textContent = "复制"; btn.style.color = ""; }, 2000);
  });
}

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
  const labels = { local: "🏠 Local", cloud: "☁️ Cloud", typescript: "📜 TS-Only", tauri: "🖥️ Native" };
  const colors = { local: "var(--success)", cloud: "var(--accent)", typescript: "var(--warn)", tauri: "var(--purple)" };
  const edition = isTauri ? "tauri" : systemEdition;
  badge.textContent = labels[edition] || edition;
  badge.style.background = colors[edition] || "var(--muted)";
}

// ===== Tauri =====
const isTauri = typeof window !== 'undefined' && !!window.__TAURI__;

async function tauriNativeSearch(query, limit = 10) {
  if (!isTauri) return null;
  try { return await window.__TAURI__.core.invoke('native_search', { query, limit }); }
  catch (e) { console.warn('Tauri search failed:', e); return null; }
}
async function tauriNativeStats() {
  if (!isTauri) return null;
  try { return await window.__TAURI__.core.invoke('native_stats'); }
  catch (e) { console.warn('Tauri stats failed:', e); return null; }
}
async function tauriSystemInfo() {
  if (!isTauri) return null;
  try { return await window.__TAURI__.core.invoke('get_system_info'); }
  catch (e) { console.warn('Tauri info failed:', e); return null; }
}

// ===== Native Status =====
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
  el.textContent = nativeConnected || isTauri ? "🦀 Rust Core" : "📜 TS Core";
  el.style.color = nativeConnected || isTauri ? "var(--success)" : "var(--muted)";
}

// ===== Performance =====
async function fetchPerfMetrics() {
  try {
    const res = await fetch("/native/router/perf", { signal: AbortSignal.timeout(2000) });
    if (res.ok) { perfData = await res.json(); renderPerfPanel(); }
  } catch { /* ignore */ }
}

function renderPerfPanel() {
  const panel = document.getElementById("perfPanel");
  if (!panel) return;
  if (!perfData.hotspots || perfData.hotspots.length === 0) {
    panel.innerHTML = `<div class="skeleton skeleton-text" style="width:80%"></div><div class="skeleton skeleton-text" style="width:60%"></div><div class="skeleton skeleton-text" style="width:90%"></div>`;
    return;
  }
  const rows = perfData.hotspots.map(([ep, count, avg, suggestion]) => `
    <tr><td><code>${ep}</code></td><td>${count.toLocaleString()}</td><td>${avg}μs</td>
    <td><span class="badge ${avg > 5000 ? 'warn' : 'ok'}">${suggestion}</span></td></tr>
  `).join("");
  panel.innerHTML = `<table class="data-table"><thead><tr><th>Endpoint</th><th>Reqs</th><th>Avg</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ===== Navigation =====
const pages = {
  chat: { label: "Chat", icon: "💬", shortcut: "1" },
  search: { label: "Search", icon: "🔍", shortcut: "2" },
  kg: { label: "KG", icon: "🕸️", shortcut: "3" },
  perf: { label: "Perf", icon: "📊", shortcut: "4" },
  settings: { label: "Settings", icon: "⚙️", shortcut: "5" },
};

function renderNav() {
  const nav = document.getElementById("navItems");
  if (!nav) return;
  nav.innerHTML = Object.entries(pages).map(([id, p]) =>
    `<div class="nav-item ${id === currentPage ? "active" : ""}" data-page="${id}">
      <span class="icon">${p.icon}</span>${p.label}
      <span class="shortcut">${p.shortcut}</span>
    </div>`
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
  if (!pages[page]) return;
  currentPage = page;
  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = pages[page]?.label || page;
  renderNav();

  document.querySelectorAll(".page").forEach(el => el.classList.add("hidden"));
  const target = document.getElementById(`page-${page}`);
  if (target) {
    target.classList.remove("hidden");
    target.classList.add("active");
  }

  if (page === "perf") { fetchPerfMetrics(); fetchNativeStatus(); }
  if (page === "chat") setTimeout(() => document.getElementById("chatInput")?.focus(), 100);
  if (page === "search") setTimeout(() => document.getElementById("searchInput")?.focus(), 100);
}

// ===== Native Status Panel =====
async function fetchNativeStatus() {
  const panel = document.getElementById("nativeStatusPanel");
  if (!panel) return;

  if (isTauri) {
    const [info, stats] = await Promise.all([tauriSystemInfo(), tauriNativeStats()]);
    panel.innerHTML = `<div class="grid" style="grid-template-columns:repeat(3,1fr);gap:12px;">
      <div class="card" style="text-align:center;padding:16px;"><div class="metric-label">Edition</div><div class="metric" style="font-size:1.3rem;color:var(--purple);">🖥️ Native</div></div>
      <div class="card" style="text-align:center;padding:16px;"><div class="metric-label">Version</div><div class="metric" style="font-size:1.3rem;">${info?.version||"2.3.0"}</div></div>
      <div class="card" style="text-align:center;padding:16px;"><div class="metric-label">Notes</div><div class="metric" style="font-size:1.3rem;">${stats?.total_notes||"-"}</div></div>
    </div>`;
    return;
  }

  try {
    const res = await fetch("http://127.0.0.1:18790/health", { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    panel.innerHTML = `<div class="grid" style="grid-template-columns:repeat(3,1fr);gap:12px;">
      <div class="card" style="text-align:center;padding:16px;"><div class="metric-label">Edition</div><div class="metric" style="font-size:1.3rem;">${data.edition==="cloud"?"☁️ Cloud":"🏠 Local"}</div></div>
      <div class="card" style="text-align:center;padding:16px;"><div class="metric-label">Version</div><div class="metric" style="font-size:1.3rem;">${data.version}</div></div>
      <div class="card" style="text-align:center;padding:16px;"><div class="metric-label">Status</div><div class="metric" style="font-size:1.3rem;color:var(--success);">● Online</div></div>
    </div>`;
  } catch {
    panel.innerHTML = `<div class="kg-placeholder" style="padding:40px;"><div class="icon">📜</div><p>TS-Only Mode</p><p class="text-muted">Rust core not running. Run <code>bun run native:build</code> to enable.</p></div>`;
  }
}

// ===== WebSocket =====
function connectWS() {
  if (ws) ws.close();
  ws = new WebSocket(WS_URL);
  const statusEl = document.getElementById("wsStatus");
  ws.onopen = () => { if (statusEl) { statusEl.innerHTML = '<span class="status-dot"></span>'; statusEl.title = "Connected"; statusEl.className = "badge ok"; } };
  ws.onclose = () => { if (statusEl) { statusEl.innerHTML = "🔴"; statusEl.title = "Disconnected"; statusEl.className = "badge danger"; } setTimeout(connectWS, 3000); };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "heartbeat") {
        const uptimeEl = document.getElementById("uptime");
        if (uptimeEl) uptimeEl.textContent = formatUptime(msg.payload.uptime);
      } else if (msg.type === "vault_change") {
        showToast(`Vault: ${msg.payload.event} ${msg.payload.file}`, "info", 2000);
      }
    } catch {}
  };
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

// ===== Chat =====
function appendMessage(role, text, meta = "") {
  const chatLog = document.getElementById("chatLog");
  const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const parsed = role === "assistant" ? parseMarkdown(text) : escapeHtml(text);
  div.innerHTML = `
    <div class="msg-meta">${role === "user" ? "" : `<span>${meta}</span>`}<span>${time}</span>${role === "user" ? `<span>${meta}</span>` : ""}</div>
    <div class="msg-bubble">${parsed}</div>
  `;
  chatLog.appendChild(div);
  chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: "smooth" });
  return div;
}

function showTyping() {
  const chatLog = document.getElementById("chatLog");
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.id = "typingIndicator";
  div.innerHTML = `<div class="msg-bubble typing-indicator"><span></span><span></span><span></span></div>`;
  chatLog.appendChild(div);
  chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: "smooth" });
}

function hideTyping() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function sendChat() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text || isTyping) return;
  input.value = "";
  appendMessage("user", text, "You");
  isTyping = true;
  showTyping();

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": localStorage.getItem("apiKey") || "",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
      signal: AbortSignal.timeout(60000),
    });
    hideTyping();
    const data = await res.json();
    if (data.error) {
      appendMessage("assistant", `**Error:** ${data.error}`, "⚠️");
    } else {
      const meta = `${data.provider || ""}${data.model ? "/" + data.model : ""}`;
      appendMessage("assistant", data.content || "(empty)", meta);
    }
  } catch (e) {
    hideTyping();
    appendMessage("assistant", `**Network Error:** ${e.message}\n\n请检查服务是否运行中。`, "🔴");
  } finally {
    isTyping = false;
  }
}

const chatInput = document.getElementById("chatInput");
chatInput.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
};
chatInput.oninput = () => {
  requestAnimationFrame(() => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
  });
};
document.getElementById("sendBtn").onclick = sendChat;

// ===== Search =====
function showSearchSkeleton() {
  const div = document.getElementById("searchResults");
  div.innerHTML = Array.from({ length: 4 }, () => `
    <div class="result-card" style="pointer-events:none;">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-text" style="width:40%"></div>
      <div class="skeleton skeleton-text" style="width:80%"></div>
    </div>
  `).join("");
}

async function doSearch() {
  const q = document.getElementById("searchInput").value.trim();
  if (!q) return;
  const para = document.getElementById("searchParaFilter").value;
  const resultsDiv = document.getElementById("searchResults");
  showSearchSkeleton();

  try {
    let url = `/search?q=${encodeURIComponent(q)}&limit=10`;
    if (para) url += `&para=${para}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      resultsDiv.innerHTML = `<div class="kg-placeholder" style="padding:60px 20px;"><div class="icon">🔍</div><p>未找到结果</p><p class="text-muted">尝试其他关键词或放宽筛选条件</p></div>`;
      return;
    }
    resultsDiv.innerHTML = data.results.map((r, i) => `
      <div class="result-card" style="animation-delay:${i * 50}ms">
        <div class="result-title">${escapeHtml(r.note.title)} <span class="score">${r.score.toFixed(1)}</span></div>
        <div class="result-path">${escapeHtml(r.note.path)}</div>
        <div class="result-excerpt">${escapeHtml(r.excerpt)}</div>
        <div class="result-reasons">${r.reasons.map(x => `<span class="tag">${escapeHtml(x)}</span>`).join("")}</div>
      </div>
    `).join("");
  } catch (e) {
    resultsDiv.innerHTML = `<div class="kg-placeholder" style="padding:60px 20px;"><div class="icon">❌</div><p>搜索失败</p><p class="text-muted">${escapeHtml(e.message)}</p></div>`;
  }
}

document.getElementById("searchBtn").onclick = doSearch;
document.getElementById("searchInput").onkeydown = (e) => { if (e.key === "Enter") doSearch(); };
document.getElementById("searchParaFilter").onchange = doSearch;

// ===== Tauri Search Override =====
async function doNativeSearch() {
  if (!isTauri) { doSearch(); return; }
  const q = document.getElementById("searchInput").value.trim();
  if (!q) return;
  const resultsDiv = document.getElementById("searchResults");
  showSearchSkeleton();
  const data = await tauriNativeSearch(q, 10);
  if (!data || !data.results || data.results.length === 0) {
    resultsDiv.innerHTML = `<div class="kg-placeholder" style="padding:60px 20px;"><div class="icon">🔍</div><p>未找到结果</p></div>`;
    return;
  }
  resultsDiv.innerHTML = data.results.map((r, i) => `
    <div class="result-card" style="animation-delay:${i*50}ms">
      <div class="result-title">${escapeHtml(r.note?.title || "Untitled")} <span class="score">${r.score?.toFixed(1) || "0"}</span></div>
      <div class="result-path">${escapeHtml(r.note?.path || "")}</div>
      <div class="result-excerpt">${escapeHtml(r.excerpt || "")}</div>
      <div class="result-reasons">${(r.reasons || []).map(x => `<span class="tag">${escapeHtml(x)}</span>`).join("")}</div>
    </div>
  `).join("");
}

// ===== Settings =====
function saveSettings() {
  const apiKey = document.getElementById("settingApiKey").value;
  localStorage.setItem("apiKey", apiKey);
  showToast("设置已保存", "success");
}
document.getElementById("saveSettingsBtn").onclick = saveSettings;

// ===== Sidebar Toggle =====
document.getElementById("menuBtn").onclick = () => {
  sidebarOpen = !sidebarOpen;
  document.getElementById("sidebar").classList.toggle("collapsed", !sidebarOpen);
};

document.getElementById("overlay").onclick = () => {
  sidebarOpen = false;
  document.getElementById("sidebar").classList.add("collapsed");
};

// ===== Keyboard Shortcuts =====
const kbdModal = document.getElementById("kbdModal");
document.getElementById("kbdHelpBtn").onclick = () => kbdModal.classList.add("show");
document.getElementById("kbdModalClose").onclick = () => kbdModal.classList.remove("show");
kbdModal.onclick = (e) => { if (e.target === kbdModal) kbdModal.classList.remove("show"); };

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    if (e.key === "Escape") { e.target.blur(); navigate("chat"); }
    return;
  }

  if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
    kbdModal.classList.add("show");
  }
  if (e.key === "Escape") {
    kbdModal.classList.remove("show");
    navigate("chat");
  }
  if (e.key === "/") {
    e.preventDefault();
    navigate("search");
  }
  if (e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    setTheme(darkMode ? "light" : "dark");
  }
  if (["1","2","3","4","5"].includes(e.key)) {
    const map = { "1":"chat","2":"search","3":"kg","4":"perf","5":"settings" };
    navigate(map[e.key]);
  }
});

// ===== Init =====
if (window.innerWidth <= 768) {
  document.getElementById("sidebar").classList.add("collapsed");
  sidebarOpen = false;
}
detectEdition();
checkNativeStatus();
connectWS();
renderNav();
navigate("chat");

if (isTauri) {
  document.getElementById("searchBtn").onclick = doNativeSearch;
  document.getElementById("searchInput").onkeydown = (e) => { if (e.key === "Enter") doNativeSearch(); };
}

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

setInterval(() => { checkNativeStatus(); }, 10000);
setInterval(() => { if (currentPage === "perf") fetchPerfMetrics(); }, 5000);

// Welcome message
setTimeout(() => {
  if (document.getElementById("chatLog").children.length === 0) {
    appendMessage("assistant", "欢迎使用 **OpenClaw AI Agent v2.3**！\n\n按 `?` 查看快捷键，或直接在下方输入消息开始对话。", "OpenClaw");
  }
}, 500);
