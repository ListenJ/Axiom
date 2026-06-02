/** OpenClaw SPA — Vanilla JS */
const API = "";
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
let ws = null;
let currentPage = "dashboard";
let sidebarOpen = window.innerWidth > 768;
let darkMode = localStorage.getItem("theme") !== "light";

// ===== Theme =====
function applyTheme() {
  document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  document.getElementById("themeBtn").textContent = darkMode ? "☀️" : "🌙";
}
document.getElementById("themeBtn").onclick = () => { darkMode = !darkMode; localStorage.setItem("theme", darkMode ? "dark" : "light"); applyTheme(); };
applyTheme();

// ===== Navigation =====
const pages = {
  dashboard: { label: "Dashboard", icon: "📊" },
  chat: { label: "Chat", icon: "💬" },
  search: { label: "Search", icon: "🔍" },
  vault: { label: "Vault", icon: "📚" },
  agents: { label: "Agents", icon: "🤖" },
  code: { label: "Code", icon: "💻" },
  settings: { label: "Settings", icon: "⚙️" },
};

function renderNav() {
  const nav = document.getElementById("navItems");
  nav.innerHTML = Object.entries(pages).map(([id, p]) =>
    `\u003cdiv class="nav-item ${id === currentPage ? "active" : ""}" data-page="${id}"\u003e\u003cspan class="icon"\u003e${p.icon}\u003c/span\u003e${p.label}\u003c/div\u003e`
  ).join("");
  nav.querySelectorAll(".nav-item").forEach(el => el.onclick = () => navigate(el.dataset.page));

  const bottom = document.getElementById("bottomNav");
  bottom.innerHTML = Object.entries(pages).map(([id, p]) =>
    `\u003cbutton class="bottom-nav-item ${id === currentPage ? "active" : ""}" data-page="${id}"\u003e\u003cspan class="icon"\u003e${p.icon}\u003c/span\u003e${p.label}\u003c/button\u003e`
  ).join("");
  bottom.querySelectorAll(".bottom-nav-item").forEach(el => el.onclick = () => navigate(el.dataset.page));
}

function navigate(page) {
  currentPage = page;
  document.getElementById("pageTitle").textContent = pages[page].label;
  renderNav();
  closeSidebar();
  if (page === "dashboard") renderDashboard();
  else if (page === "chat") renderChat();
  else if (page === "search") renderSearch();
  else if (page === "vault") renderVault();
  else if (page === "agents") renderAgents();
  else if (page === "code") renderCodeAgent();
  else if (page === "settings") renderSettings();
}

// ===== Sidebar =====
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById("sidebar").classList.toggle("closed", !sidebarOpen);
  document.getElementById("header").classList.toggle("full", !sidebarOpen);
  document.getElementById("main").classList.toggle("full", !sidebarOpen);
  document.getElementById("overlay").classList.toggle("show", sidebarOpen && window.innerWidth <= 768);
}
function closeSidebar() {
  if (window.innerWidth <= 768) { sidebarOpen = false; document.getElementById("sidebar").classList.add("closed"); document.getElementById("header").classList.add("full"); document.getElementById("main").classList.add("full"); document.getElementById("overlay").classList.remove("show"); }
}
document.getElementById("hamburger").onclick = toggleSidebar;
document.getElementById("overlay").onclick = closeSidebar;

// ===== API Helpers =====
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const key = localStorage.getItem("apiKey");
  if (key) headers["x-api-key"] = key;
  try {
    const res = await fetch(API + path, { ...opts, headers });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : await res.json();
  } catch (e) {
    showError(e.message);
    throw e;
  }
}
function showError(msg) {
  const el = document.getElementById("pageContent");
  el.innerHTML = `\u003cdiv class="loading" style="color:var(--danger)"\u003e❌ ${msg}\u003c/div\u003e`;
}

// ===== WebSocket =====
function connectWs() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    document.getElementById("connStatus").innerHTML = `\u003cspan class="status-dot"\u003e\u003c/span\u003e 在线`;
    document.getElementById("connStatus").className = "badge ok";
    ws.send(JSON.stringify({ action: "subscribe", types: ["system.status", "search.completed", "crawl.completed", "vault_change", "model.usage", "heartbeat"] }));
  };
  ws.onclose = () => {
    document.getElementById("connStatus").innerHTML = `⚠️ 重连中`;
    document.getElementById("connStatus").className = "badge warn";
    setTimeout(connectWs, 5000);
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "heartbeat" && currentPage === "dashboard") updateDashboardStats(msg.payload);
    } catch {}
  };
}

// ===== Dashboard =====
let dashboardData = {};
async function renderDashboard() {
  const el = document.getElementById("pageContent");
  el.innerHTML = `\u003cdiv class="loading"\u003e\u003cdiv class="spinner"\u003e\u003c/div\u003e\u003c/div\u003e`;
  try {
    const [health, stats, vstats, trends] = await Promise.all([
      api("/health").catch(() => null),
      api("/stats").catch(() => null),
      api("/vault/stats").catch(() => null),
      api("/stats/trends?days=7").catch(() => null),
    ]);
    dashboardData = { health, stats, vstats, trends };
    // Guard: if the user navigated away while we were awaiting, don't overwrite their page
    if (currentPage !== "dashboard") return;
    el.innerHTML = `
      \u003cdiv class="grid">
        ${renderCard("🧠 Vault 记忆", vstats?.totalNotes ?? "—", "笔记总数", `
          \u003cul class="list">\u003cli\u003e\u003cspan\u003e总词数\u003c/span\u003e\u003cspan\u003e${(vstats?.totalWords ?? 0).toLocaleString()}\u003c/span\u003e\u003c/li\u003e
          \u003cli\u003e\u003cspan\u003e标签数\u003c/span\u003e\u003cspan\u003e${vstats?.totalTags ?? 0}\u003c/span\u003e\u003c/li\u003e
          \u003cli\u003e\u003cspan\u003ewiki-link\u003c/span\u003e\u003cspan\u003e${vstats?.totalLinks ?? 0}\u003c/span\u003e\u003c/li\u003e\u003c/ul>`)}
        ${renderCard("🔍 搜索", stats?.searchCount ?? "—", "累计搜索", `缓存命中率: ${(health?.cache?.search?.hitRate * 100 ?? 0).toFixed(1)}%`)}
        ${renderCard("🕸️ 爬取", stats?.crawlCount ?? "—", "已爬取页面", `缓存命中率: ${(health?.cache?.crawl?.hitRate * 100 ?? 0).toFixed(1)}%`)}
        ${renderCard("🌐 引擎", `${health?.searchEngines?.filter(e=>e.available).length ?? 0}/${health?.searchEngines?.length ?? 0}`, "可用平台", `
          \u003cul class="list">${(health?.searchEngines ?? []).map(e=>`\u003cli\u003e\u003cspan\u003e${e.name}\u003c/span\u003e\u003cspan class="badge ${e.available?'ok':'off'}"\u003e${e.available?'可用':'未配置'}\u003c/span\u003e\u003c/li\u003e`).join("")}\u003c/ul>`)}
        ${renderCard("📡 系统", health?.status === "ok" ? "运行中" : "异常", "状态", `Uptime: ${Math.floor((Date.now() - (health?.startupTime ?? Date.now())) / 1000 / 60)} 分钟`)}
        ${renderCard("🤖 Agents", "5", "类别", `code / research / write / plan / chat`)}
      \u003c/div>
      ${trends ? renderTrends(trends) : ""}`;
  } catch (e) { showError(e.message); }
}
function renderCard(title, value, label, extra) {
  return `\u003cdiv class="card">\u003ch2\u003e${title}\u003c/h2\u003e\u003cdiv class="metric">${value}\u003c/div\u003e\u003cdiv class="metric-label">${label}\u003c/div\u003e${extra ? `\u003cdiv style="margin-top:8px">${extra}\u003c/div\u003e` : ""}\u003c/div>`;
}
function renderTrends(trends) {
  if (!trends?.searches?.length) return "";
  return `\u003cdiv class="section-title" style="margin-top:24px">📈 7日趋势\u003c/div\u003e\u003cdiv class="grid">${["searches","conversations","modelUsage"].map(k=>{
    const data = trends[k] || [];
    const max = Math.max(...data.map(d=>d.count), 1);
    return `\u003cdiv class="card">\u003ch2\u003e${k === "searches" ? "🔍 搜索" : k === "conversations" ? "💬 对话" : "🤖 模型调用"}\u003c/h2\u003e\u003cdiv style="height:120px;display:flex;align-items:flex-end;gap:4px;padding-top:16px">${data.map(d=>`\u003cdiv style="flex:1;background:var(--accent);border-radius:4px 4px 0 0;height:${(d.count/max*100)}%;min-height:4px;position:relative" title="${d.date}: ${d.count}"\u003e\u003c/div\u003e`).join("")}\u003c/div\u003e\u003c/div>`;
  }).join("")}\u003c/div>`;
}
function updateDashboardStats(payload) {
  if (payload.vaultNotes) {
    const el = document.querySelector(".metric");
    if (el) el.textContent = payload.vaultNotes;
  }
}

// ===== Chat =====
let chatHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");
function renderChat() {
  const el = document.getElementById("pageContent");
  el.innerHTML = `
    \u003cdiv class="chat-container">
      \u003cdiv class="chat-messages" id="chatMsgs"\u003e${chatHistory.map(m=>renderMsg(m)).join("")}\u003c/div\u003e
      \u003cdiv class="chat-input">
        \u003cinput type="text" class="input" id="chatInput" placeholder="输入消息..." onkeydown="if(event.key==='Enter')sendChat()">
        \u003cbutton class="btn" onclick="sendChat()">发送\u003c/button\u003e
      \u003c/div\u003e
    \u003c/div>`;
  setTimeout(() => document.getElementById("chatMsgs").scrollTop = 999999, 10);
}
function renderMsg(m) {
  return `\u003cdiv class="msg ${m.role}"\u003e\u003cdiv style="font-size:0.75rem;color:var(--muted);margin-bottom:4px"\u003e${m.role === "user" ? "你" : m.role === "assistant" ? "Agent" : "系统"}\u003c/div\u003e${escapeHtml(m.content)}\u003c/div>`;
}
async function sendChat() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  chatHistory.push({ role: "user", content: text });
  renderChat();
  try {
    const res = await api("/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: text }] }) });
    chatHistory.push({ role: "assistant", content: res.response || "(无响应)" });
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory.slice(-50)));
    renderChat();
  } catch (e) {
    chatHistory.push({ role: "system", content: `错误: ${e.message}` });
    renderChat();
  }
}

// ===== Search =====
function renderSearch() {
  document.getElementById("pageContent").innerHTML = `
    \u003cdiv class="search-box">
      \u003cinput type="text" class="input" id="searchInput" placeholder="输入搜索关键词..." onkeydown="if(event.key==='Enter')doSearch()">
      \u003cselect class="select" id="searchMode">\u003coption value="quick">快速\u003c/option\u003e\u003coption value="deep">深度\u003c/option\u003e\u003coption value="academic">学术\u003c/option\u003e\u003c/select\u003e
      \u003cbutton class="btn" onclick="doSearch()">搜索\u003c/button\u003e
    \u003c/div>
    \u003cdiv id="searchResults">\u003c/div>`;
}
async function doSearch() {
  const query = document.getElementById("searchInput").value.trim();
  if (!query) return;
  const mode = document.getElementById("searchMode").value;
  const el = document.getElementById("searchResults");
  el.innerHTML = `\u003cdiv class="loading">\u003cdiv class="spinner"\u003e\u003c/div\u003e\u003c/div\u003e`;
  try {
    const res = await api(`/enhanced-search?q=${encodeURIComponent(query)}&mode=${mode}`);
    if (!res.results?.length) { el.innerHTML = `\u003cdiv class="loading">无结果\u003c/div\u003e`; return; }
    el.innerHTML = res.results.map(r => `
      \u003cdiv class="result-item">
        \u003cdiv class="title">\u003ca href="${r.link}" target="_blank" style="color:var(--accent);text-decoration:none">${escapeHtml(r.title)}\u003c/a\u003e\u003c/div\u003e
        \u003cdiv class="path">${r.engine} · ${r.displayedUrl}\u003c/div\u003e
        \u003cdiv class="snippet">${escapeHtml(r.snippet)}\u003c/div\u003e
      \u003c/div>`).join("");
  } catch (e) { el.innerHTML = `\u003cdiv class="loading" style="color:var(--danger)">搜索失败\u003c/div\u003e`; }
}

// ===== Vault =====
let vaultNotes = [];
async function renderVault() {
  document.getElementById("pageContent").innerHTML = `
    \u003cdiv class="search-box">
      \u003cinput type="text" class="input" id="vaultSearch" placeholder="搜索 Vault..." onkeydown="if(event.key==='Enter')searchVault()">
      \u003cbutton class="btn" onclick="searchVault()">搜索\u003c/button\u003e
    \u003c/div>
    \u003cdiv class="vault-browser">
      \u003cdiv class="vault-sidebar">
        \u003ch3\u003ePARA 分类\u003c/h3\u003e\u003cdiv id="vaultPara">\u003c/div\u003e
        \u003ch3 style="margin-top:12px">标签\u003c/h3\u003e\u003cdiv id="vaultTags">\u003c/div\u003e
      \u003c/div>
      \u003cdiv class="vault-content" id="vaultContent">\u003cdiv class="loading">选择分类或搜索\u003c/div\u003e\u003c/div\u003e
    \u003c/div>`;
  try {
    const stats = await api("/vault/stats");
    document.getElementById("vaultPara").innerHTML = Object.entries(stats.paraDistribution || {}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>
      `\u003cdiv class="vault-item" onclick="browseVault('${k}')">${k} \u003cspan style="color:var(--muted)">(${v})\u003c/span\u003e\u003c/div\u003e`).join("");
  } catch {}
}
async function searchVault() {
  const q = document.getElementById("vaultSearch").value.trim();
  if (!q) return;
  document.getElementById("vaultContent").innerHTML = `\u003cdiv class="loading">\u003cdiv class="spinner"\u003e\u003c/div\u003e\u003c/div\u003e`;
  try {
    const res = await api(`/search?q=${encodeURIComponent(q)}&limit=20`);
    vaultNotes = res.results || [];
    document.getElementById("vaultContent").innerHTML = vaultNotes.map(r=>`
      \u003cdiv class="result-item" onclick="showNote('${encodeURIComponent(r.note.path)}')">
        \u003cdiv class="score">得分: ${r.score.toFixed(1)}\u003c/div\u003e
        \u003cdiv class="title">${escapeHtml(r.note.title)}\u003c/div\u003e
        \u003cdiv class="path">${r.note.path}\u003c/div\u003e
        \u003cdiv class="snippet">${escapeHtml(r.excerpt)}\u003c/div\u003e
      \u003c/div>`).join("");
  } catch {}
}
async function browseVault(category) {
  document.getElementById("vaultContent").innerHTML = `\u003cdiv class="loading">\u003cdiv class="spinner"\u003e\u003c/div\u003e\u003c/div\u003e`;
  try {
    const res = await api(`/vault/para/${category}`);
    document.getElementById("vaultContent").innerHTML = (res.notes || []).map(n=>`
      \u003cdiv class="result-item" onclick="showNote('${encodeURIComponent(n.path)}')">
        \u003cdiv class="title">${escapeHtml(n.title)}\u003c/div\u003e
        \u003cdiv class="path">${n.path}\u003c/div\u003e
        \u003cdiv class="snippet">${escapeHtml(n.content?.slice(0, 200) || "")}...\u003c/div\u003e
      \u003c/div>`).join("");
  } catch {}
}
async function showNote(path) {
  try {
    const res = await api(`/vault/note?path=${path}`);
    document.getElementById("vaultContent").innerHTML = `
      \u003cdiv style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        \u003ch3\u003e${escapeHtml(res.frontmatter?.title || "笔记")}\u003c/h3\u003e
        \u003cbutton class="btn small secondary" onclick="renderVault()">返回\u003c/button\u003e
      \u003c/div>
      \u003cpre style="background:var(--bg);padding:12px;border-radius:8px;overflow-x:auto;font-size:0.85rem;line-height:1.6">${escapeHtml(res.content)}\u003c/pre>`;
  } catch {}
}

// ===== Agents =====
async function renderAgents() {
  document.getElementById("pageContent").innerHTML = `\u003cdiv class="loading">\u003cdiv class="spinner"\u003e\u003c/div\u003e\u003c/div\u003e`;
  try {
    const [agents, engines, proxies] = await Promise.all([
      api("/agents/status").catch(() => null),
      api("/engines").catch(() => null),
      api("/proxies").catch(() => null),
    ]);
    document.getElementById("pageContent").innerHTML = `
      \u003cdiv class="grid">
        \u003cdiv class="card">\u003ch2\u003e🤖 Agent 状态\u003c/h2\u003e\u003cul class="list">${(agents?.agents || []).map(a=>
          `\u003cli\u003e\u003cspan\u003e${a.name}\u003c/span\u003e\u003cspan class="badge ${a.available?'ok':'off'}"\u003e${a.available?'可用':'离线'}\u003c/span\u003e\u003c/li\u003e`).join("")}\u003c/ul\u003e\u003c/div\u003e
        \u003cdiv class="card">\u003ch2\u003e🔍 搜索引擎\u003c/h2\u003e\u003cul class="list">${(engines || []).map(e=>
          `\u003cli\u003e\u003cspan\u003e${e.name}\u003c/span\u003e\u003cspan class="badge ${e.available?'ok':'off'}"\u003e${e.available?'可用':'未配置'}\u003c/span\u003e\u003c/li\u003e`).join("")}\u003c/ul\u003e\u003c/div\u003e
        \u003cdiv class="card">\u003ch2\u003e🌐 代理\u003c/h2\u003e\u003cul class="list">${(proxies || []).map(p=>
          `\u003cli\u003e\u003cspan\u003e${p.country || p.host}\u003c/span\u003e\u003cspan class="badge ${p.active?'ok':'off'}"\u003e${p.active?'可用':'离线'}\u003c/span\u003e\u003c/li\u003e`).join("")}\u003c/ul\u003e\u003c/div\u003e
      \u003c/div>`;
  } catch {}
}

// ===== Code Agent =====
function renderCodeAgent() {
  document.getElementById("pageContent").innerHTML = `
    \u003cdiv class="tab-nav">
      \u003cbutton class="active" onclick="switchCodeTab('generate',this)">生成\u003c/button\u003e
      \u003cbutton onclick="switchCodeTab('refactor',this)">重构\u003c/button\u003e
      \u003cbutton onclick="switchCodeTab('review',this)">审查\u003c/button\u003e
      \u003cbutton onclick="switchCodeTab('test',this)">测试\u003c/button\u003e
    \u003c/div>
    \u003cdiv id="codeTabContent">${renderCodeGenerate()}\u003c/div>`;
}
function renderCodeGenerate() {
  return `
    \u003cdiv class="card">\u003ch2\u003e📝 代码生成\u003c/h2\u003e
      \u003cdiv style="margin-bottom:12px">\u003cinput type="text" class="input" id="codePrompt" placeholder="描述你想要的功能..."\u003e\u003c/div\u003e
      \u003cdiv style="margin-bottom:12px">\u003cselect class="select" id="codeLang">\u003coption value="typescript">TypeScript\u003c/option\u003e\u003coption value="python">Python\u003c/option\u003e\u003coption value="rust">Rust\u003c/option\u003e\u003c/select\u003e\u003c/div\u003e
      \u003cbutton class="btn" onclick="runCodeAction('generate')">生成代码\u003c/button\u003e
      \u003cdiv id="codeOutput" style="margin-top:16px">\u003c/div\u003e
    \u003c/div>`;
}
function renderCodeRefactor() {
  return `
    \u003cdiv class="card">\u003ch2\u003e🔧 代码重构\u003c/h2\u003e
      \u003cdiv style="margin-bottom:12px">\u003ctextarea class="input" id="refactorCode" placeholder="粘贴需要重构的代码..."\u003e\u003c/textarea\u003e\u003c/div\u003e
      \u003cdiv style="margin-bottom:12px">\u003cinput type="text" class="input" id="refactorGoal" placeholder="重构目标（如：优化性能、简化逻辑）..."\u003e\u003c/div\u003e
      \u003cbutton class="btn" onclick="runCodeAction('refactor')">重构\u003c/button\u003e
      \u003cdiv id="codeOutput" style="margin-top:16px">\u003c/div\u003e
    \u003c/div>`;
}
function renderCodeReview() {
  return `
    \u003cdiv class="card">\u003ch2\u003e🔍 代码审查\u003c/h2\u003e
      \u003cdiv style="margin-bottom:12px">\u003ctextarea class="input" id="reviewCode" placeholder="粘贴需要审查的代码..."\u003e\u003c/textarea\u003e\u003c/div\u003e
      \u003cdiv style="margin-bottom:12px">\u003cinput type="text" class="input" id="reviewLang" placeholder="编程语言（如：TypeScript）..."\u003e\u003c/div\u003e
      \u003cbutton class="btn" onclick="runCodeAction('review')">审查\u003c/button\u003e
      \u003cdiv id="codeOutput" style="margin-top:16px">\u003c/div\u003e
    \u003c/div>`;
}
function renderCodeTest() {
  return `
    \u003cdiv class="card">\u003ch2\u003e🧪 生成测试\u003c/h2\u003e
      \u003cdiv style="margin-bottom:12px">\u003ctextarea class="input" id="testCode" placeholder="粘贴需要测试的代码..."\u003e\u003c/textarea\u003e\u003c/div\u003e
      \u003cdiv style="margin-bottom:12px">\u003cselect class="select" id="testFramework">\u003coption value="vitest">Vitest\u003c/option\u003e\u003coption value="pytest">Pytest\u003c/option\u003e\u003c/select\u003e\u003c/div\u003e
      \u003cbutton class="btn" onclick="runCodeAction('test')">生成测试\u003c/button\u003e
      \u003cdiv id="codeOutput" style="margin-top:16px">\u003c/div\u003e
    \u003c/div>`;
}
function switchCodeTab(tab, btn) {
  document.querySelectorAll(".tab-nav button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const content = document.getElementById("codeTabContent");
  if (tab === "generate") content.innerHTML = renderCodeGenerate();
  else if (tab === "refactor") content.innerHTML = renderCodeRefactor();
  else if (tab === "review") content.innerHTML = renderCodeReview();
  else if (tab === "test") content.innerHTML = renderCodeTest();
}
async function runCodeAction(type) {
  const out = document.getElementById("codeOutput");
  out.innerHTML = `\u003cdiv class="loading">\u003cdiv class="spinner"\u003e\u003c/div\u003e\u003c/div\u003e`;
  try {
    let body = {};
    if (type === "generate") body = { prompt: document.getElementById("codePrompt").value, language: document.getElementById("codeLang").value };
    else if (type === "refactor") body = { code: document.getElementById("refactorCode").value, goal: document.getElementById("refactorGoal").value };
    else if (type === "review") body = { code: document.getElementById("reviewCode").value, language: document.getElementById("reviewLang").value };
    else if (type === "test") body = { code: document.getElementById("testCode").value, framework: document.getElementById("testFramework").value };
    const res = await api(`/agents/opencode/${type}`, { method: "POST", body: JSON.stringify(body) });
    out.innerHTML = `\u003cdiv class="code-output">${escapeHtml(res.result || res.review || res.code || JSON.stringify(res, null, 2))}\u003c/div\u003e`;
  } catch (e) {
    out.innerHTML = `\u003cdiv style="color:var(--danger);padding:12px">错误: ${e.message}\u003c/div\u003e`;
  }
}

// ===== Settings =====
function renderSettings() {
  document.getElementById("pageContent").innerHTML = `
    <div class="card"><h2>⚙️ 设置</h2>
      <div style="max-width:600px">
        <div style="margin-bottom:16px">
          <label style="display:block;color:var(--muted);font-size:0.85rem;margin-bottom:6px">API Key (远程访问)</label>
          <input type="password" class="input" id="apiKeyInput" placeholder="输入 API Key..." value="${localStorage.getItem("apiKey") || ""}">
          <div style="font-size:0.75rem;color:var(--muted);margin-top:4px">设置后所有请求将携带 x-api-key 头</div>
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;color:var(--muted);font-size:0.85rem;margin-bottom:6px">主题</label>
          <select class="select" id="themeSelect" onchange="setTheme(this.value)">
            <option value="system" ${!localStorage.getItem("theme") ? "selected" : ""}>跟随系统</option>
            <option value="dark" ${localStorage.getItem("theme") === "dark" ? "selected" : ""}>深色</option>
            <option value="light" ${localStorage.getItem("theme") === "light" ? "selected" : ""}>浅色</option>
          </select>
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;color:var(--muted);font-size:0.85rem;margin-bottom:6px">WebSocket 连接</label>
          <div id="wsStatus">${ws?.readyState === 1 ? "已连接" : "未连接"}</div>
        </div>
        <button class="btn" onclick="saveSettings()">保存设置</button>
        <button class="btn secondary" style="margin-left:8px" onclick="clearCache()">清除缓存</button>
      </div>
    </div>
    ${renderApiKeyManager()}`;
  loadApiKeyStatus();
}
function setTheme(t) {
  if (t === "system") { localStorage.removeItem("theme"); darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches; }
  else { localStorage.setItem("theme", t); darkMode = t === "dark"; }
  applyTheme();
}
function saveSettings() {
  const key = document.getElementById("apiKeyInput").value.trim();
  if (key) localStorage.setItem("apiKey", key); else localStorage.removeItem("apiKey");
  alert("设置已保存");
}
function clearCache() {
  localStorage.removeItem("chatHistory");
  if ("caches" in window) caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  alert("缓存已清除");
}

// ===== Provider API Key Manager (MiniMax 等) =====
// 允许在前端运行时为各 provider 设置 API Key（不写入磁盘，不修改 .env）。
// 优先级: runtime override > .env 中的值
const PROVIDER_META = {
  minimax:      { label: "MiniMax (MiniMax AI)",  cn: "国内直连，1M context 旗舰长文本", recommended: true },
  deepseek:     { label: "DeepSeek",              cn: "主力决策/编码模型" },
  siliconflow:  { label: "硅基流动 SiliconFlow",  cn: "7 个永久免费模型" },
  ofoxai:       { label: "OfoxAI",                cn: "国内直连，OpenRouter 替代" },
  ofoxai_anthropic: { label: "OfoxAI Anthropic",  cn: "Claude 协议兼容" },
  ofoxai_gemini:    { label: "OfoxAI Gemini",     cn: "Gemini 协议兼容" },
  openrouter:   { label: "OpenRouter",            cn: "353+ 模型聚合" },
  opencode:     { label: "OpenCode",              cn: "编码 Agent 免费模型网关" },
  kimi:         { label: "Kimi / Moonshot",       cn: "Kimi API" },
};

function renderApiKeyManager() {
  return `
    <div class="card" style="margin-top:16px">
      <h2>🔑 Provider API Keys <span class="badge" style="background:var(--accent);color:#fff">运行时配置</span></h2>
      <div style="font-size:0.8rem;color:var(--muted);margin-bottom:12px">
        在此处填入的 API Key 仅保存在<strong>服务器内存</strong>中，不会写入 <code>.env</code>，重启服务后失效。
        优先级：运行时设置 &gt; <code>.env</code> 中的值。
        也可继续在 <code>.env</code> 中直接配置 <code>MINIMAX_API_KEY</code> 等环境变量。
      </div>
      <div id="apiKeyList" class="loading"><div class="spinner"></div></div>
    </div>`;
}

async function loadApiKeyStatus() {
  const el = document.getElementById("apiKeyList");
  if (!el) return;
  try {
    const res = await api("/api-keys");
    const providers = res.providers || [];
    el.innerHTML = providers.map((p) => {
      const meta = PROVIDER_META[p.provider] || { label: p.provider, cn: "" };
      const isRec = meta.recommended ? `<span class="badge ok" style="margin-left:6px">推荐</span>` : "";
      const statusBadge = p.configured
        ? `<span class="badge ok">已配置 · ${p.source}</span>`
        : `<span class="badge warn">未配置</span>`;
      const masked = p.masked || "<未设置>";
      return `
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
            <div>
              <div style="font-weight:600">${meta.label} ${isRec}</div>
              <div style="font-size:0.75rem;color:var(--muted);margin-top:2px">${meta.cn} · <code>${p.apiKeyEnv}</code></div>
            </div>
            <div>${statusBadge} <span style="font-family:monospace;font-size:0.75rem;color:var(--muted)">${masked}</span></div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <input type="password" class="input" id="apikey_${p.provider}" placeholder="${p.configured ? "留空保持当前值" : "输入新的 API Key"}" style="flex:1;min-width:200px">
            <input type="text" class="input" id="baseurl_${p.provider}" placeholder="${p.baseURL || "Base URL (可选)"}" style="flex:1;min-width:200px;font-family:monospace;font-size:0.8rem">
            <button class="btn small" onclick="setApiKey('${p.provider}')">保存</button>
            ${p.source === "runtime" ? `<button class="btn small secondary" onclick="clearApiKey('${p.provider}')">清除</button>` : ""}
          </div>
        </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div style="color:var(--danger)">加载失败: ${e.message}</div>`;
  }
}

async function setApiKey(provider) {
  const apiKeyEl = document.getElementById(`apikey_${provider}`);
  const baseURLEl = document.getElementById(`baseurl_${provider}`);
  const apiKey = apiKeyEl.value.trim();
  const baseURL = baseURLEl.value.trim();
  if (!apiKey) { alert("请输入 API Key"); return; }
  try {
    const body = { provider, apiKey };
    if (baseURL) body.baseURL = baseURL;
    const res = await api("/api-keys", { method: "POST", body: JSON.stringify(body) });
    if (res.success) {
      apiKeyEl.value = "";
      baseURLEl.value = "";
      await loadApiKeyStatus();
    } else {
      alert("保存失败: " + (res.error || "未知错误"));
    }
  } catch (e) {
    alert("保存失败: " + e.message);
  }
}

async function clearApiKey(provider) {
  if (!confirm(`确定要清除 ${provider} 的运行时 API Key override 吗？\n清除后将回退到 .env 中的值。`)) return;
  try {
    await api(`/api-keys/${provider}`, { method: "DELETE" });
    await loadApiKeyStatus();
  } catch (e) {
    alert("清除失败: " + e.message);
  }
}
// ===== Utils =====
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "\u003cbr\u003e");
}

// ===== Init =====
renderNav();
connectWs();
navigate("dashboard");

// PWA
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
