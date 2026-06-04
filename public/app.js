/** OpenClaw SPA — Vanilla JS */
const API = "";
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
let ws = null;
let currentPage = "chat";
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
  chat: { label: "Chat", icon: "💬", desc: "与 Agent 沟通" },
  search: { label: "Search", icon: "🔍", desc: "Vault / Web 搜索" },
  kg: { label: "KG", icon: "🕸️", desc: "知识图谱可视化" },
  ocr: { label: "OCR", icon: "📄", desc: "文档扫描识别" },
  settings: { label: "Settings", icon: "⚙️", desc: "配置中心" },
};

function renderNav() {
  const nav = document.getElementById("navItems");
  nav.innerHTML = Object.entries(pages).map(([id, p]) =>
    `<div class="nav-item ${id === currentPage ? "active" : ""}" data-page="${id}"><span class="icon">${p.icon}</span>${p.label}</div>`
  ).join("");
  nav.querySelectorAll(".nav-item").forEach(el => el.onclick = () => navigate(el.dataset.page));

  const bottom = document.getElementById("bottomNav");
  bottom.innerHTML = Object.entries(pages).map(([id, p]) =>
    `<button class="bottom-nav-item ${id === currentPage ? "active" : ""}" data-page="${id}"><span class="icon">${p.icon}</span>${p.label}</button>`
  ).join("");
  bottom.querySelectorAll(".bottom-nav-item").forEach(el => el.onclick = () => navigate(el.dataset.page));
}

function navigate(page) {
  currentPage = page;
  document.getElementById("pageTitle").textContent = pages[page].label;
  renderNav();
  closeSidebar();
  if (page === "chat") renderChat();
  else if (page === "search") renderSearch();
  else if (page === "kg") renderKG();
  else if (page === "ocr") renderOcr();
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
  el.innerHTML = `<div class="loading" style="color:var(--danger)">❌ ${msg}</div>`;
}

// ===== WebSocket =====
let wsRetryCount = 0;
function connectWs() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    wsRetryCount = 0;
    document.getElementById("connStatus").innerHTML = `<span class="status-dot"></span> 在线`;
    document.getElementById("connStatus").className = "badge ok";
    ws.send(JSON.stringify({ action: "subscribe", types: ["system.status", "search.completed", "crawl.completed", "vault_change", "model.usage", "heartbeat"] }));
  };
  ws.onclose = () => {
    document.getElementById("connStatus").innerHTML = `⚠️ 重连中`;
    document.getElementById("connStatus").className = "badge warn";
    const delay = Math.min(5000 * Math.pow(1.5, wsRetryCount), 60000);
    wsRetryCount++;
    setTimeout(connectWs, delay);
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "heartbeat") updateAgentStatus(msg.payload);
    } catch {}
  };
}

// ===== Chat (Agent Hub) =====
let chatHistory = JSON.parse(localStorage.getItem("chatHistory") || "[]");

function renderChat() {
  const el = document.getElementById("pageContent");
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 280px;gap:16px;height:calc(100vh - 120px)">
      <div class="chat-container" style="height:100%">
        <div class="chat-messages" id="chatMsgs">${chatHistory.map(m => renderMsg(m)).join("")}</div>
        <div class="chat-input">
          <input type="text" class="input" id="chatInput" placeholder="输入消息，OpenClaw 会自动分发给最合适的 Agent..." onkeydown="if(event.key==='Enter')sendChat()">
          <button class="btn" onclick="sendChat()">发送</button>
        </div>
        <div style="display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--border);flex-wrap:wrap">
          <button class="btn small secondary" onclick="quickCode('generate')">📝 生成代码</button>
          <button class="btn small secondary" onclick="quickCode('refactor')">🔧 重构</button>
          <button class="btn small secondary" onclick="quickCode('review')">🔍 审查</button>
          <button class="btn small secondary" onclick="quickCode('test')">🧪 生成测试</button>
          <button class="btn small secondary" onclick="quickAction('search')">🔍 搜索知识库</button>
          <button class="btn small secondary" onclick="quickAction('ocr')">📄 OCR识别</button>
        </div>
      </div>
      <div class="card" style="height:100%;overflow-y:auto">
        <h2>🤖 Agent 状态</h2>
        <div id="agentStatusList"><div class="loading"><div class="spinner"></div></div></div>
        <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
          <h2 style="font-size:0.8rem">⚡ 快捷工具</h2>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
            <button class="btn small secondary" style="justify-content:flex-start" onclick="clearChat()">🗑️ 清空对话</button>
            <button class="btn small secondary" style="justify-content:flex-start" onclick="exportChat()">💾 导出对话</button>
          </div>
        </div>
      </div>
    </div>`;
  setTimeout(() => {
    const msgs = document.getElementById("chatMsgs");
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    loadAgentStatus();
  }, 10);
}

function renderMsg(m) {
  const agentBadge = m.agent ? `<span class="badge" style="background:var(--purple);color:#fff;margin-left:8px">${m.agent}</span>` : "";
  const toolCalls = m.toolCalls ? `<div style="margin-top:8px;padding:8px;background:var(--bg);border-radius:6px;font-size:0.8rem">
    <div style="color:var(--muted);margin-bottom:4px">🔧 工具调用:</div>
    ${m.toolCalls.map(t => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">
      <span>${t.name}</span><span class="badge ${t.status === 'ok' ? 'ok' : 'warn'}">${t.status}</span>
    </div>`).join("")}
  </div>` : "";
  return `<div class="msg ${m.role}">
    <div style="font-size:0.75rem;color:var(--muted);margin-bottom:4px;display:flex;align-items:center">
      ${m.role === "user" ? "👤 你" : m.role === "assistant" ? "🦅 Agent" : "⚙️ 系统"}${agentBadge}
    </div>
    ${escapeHtml(m.content)}
    ${toolCalls}
  </div>`;
}

async function sendChat() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  const pendingAction = input.dataset.pendingAction;
  delete input.dataset.pendingAction;
  input.placeholder = "输入消息，OpenClaw 会自动分发给最合适的 Agent...";

  chatHistory.push({ role: "user", content: text });
  renderChat();

  try {
    const intentRes = await api("/agents/detect-intent", {
      method: "POST",
      body: JSON.stringify({ prompt: text })
    }).catch(() => ({ intent: "general", confidence: 0.5 }));

    const typingId = "typing-" + Date.now();
    chatHistory.push({ role: "system", content: `正在分发给 ${intentRes.intent || "general"} agent...`, id: typingId });
    renderChat();

    let res;
    if (pendingAction) {
      res = await api(`/agents/opencode/${pendingAction}`, {
        method: "POST",
        body: JSON.stringify({ [pendingAction === "generate" ? "prompt" : "code"]: text, language: "typescript" })
      });
    } else {
      res = await api("/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: text }], intent: intentRes.intent })
      });
    }

    chatHistory = chatHistory.filter(m => m.id !== typingId);
    const aiContent = res.response || res.result || res.code || res.review || JSON.stringify(res, null, 2);
    chatHistory.push({
      role: "assistant",
      content: aiContent,
      agent: res.agent || intentRes.intent,
      toolCalls: res.toolCalls
    });
    // Cap in-memory history to prevent memory leak (1000 messages max)
    if (chatHistory.length > 1000) chatHistory.splice(0, chatHistory.length - 1000);
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory.slice(-100)));
    // Persist to server for cross-session memory
    const sessionId = localStorage.getItem("sessionId") || crypto.randomUUID();
    localStorage.setItem("sessionId", sessionId);
    api("/memory/conversations", {
      method: "POST",
      body: JSON.stringify({ sessionId, role: "user", content: text })
    }).catch(() => {});
    api("/memory/conversations", {
      method: "POST",
      body: JSON.stringify({ sessionId, role: "assistant", content: aiContent })
    }).catch(() => {});
    renderChat();
  } catch (e) {
    chatHistory = chatHistory.filter(m => !m.id?.startsWith("typing-"));
    chatHistory.push({ role: "system", content: `错误: ${e.message}` });
    renderChat();
  }
}

async function loadAgentStatus() {
  try {
    const res = await api("/agents/status");
    const list = document.getElementById("agentStatusList");
    if (!list) return;
    list.innerHTML = (res.agents || []).map(a => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:1.2rem">${a.icon || "🤖"}</span>
          <div>
            <div style="font-size:0.85rem;font-weight:600">${a.name}</div>
            <div style="font-size:0.75rem;color:var(--muted)">${a.role || "general"}</div>
          </div>
        </div>
        <span class="badge ${a.available ? 'ok' : 'danger'}">${a.available ? "在线" : "离线"}</span>
      </div>
    `).join("");
  } catch {}
}

function quickCode(action) {
  const input = document.getElementById("chatInput");
  const placeholders = {
    generate: "描述你想要的功能，例如：写一个快速排序算法",
    refactor: "粘贴代码并描述重构目标",
    review: "粘贴代码进行审查",
    test: "粘贴代码生成测试用例"
  };
  input.placeholder = placeholders[action] || "输入消息...";
  input.focus();
  input.dataset.pendingAction = action;
}

function quickAction(type) {
  if (type === "search") navigate("search");
  else if (type === "ocr") navigate("ocr");
}

function clearChat() {
  if (!confirm("确定要清空所有对话历史吗？")) return;
  chatHistory = [];
  localStorage.removeItem("chatHistory");
  renderChat();
}

function exportChat() {
  const blob = new Blob([JSON.stringify(chatHistory, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `openclaw-chat-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Search (Vault + Web) =====
function renderSearch() {
  document.getElementById("pageContent").innerHTML = `
    <div class="tab-nav">
      <button class="active" onclick="switchSearchTab('vault',this)">📚 Vault 搜索</button>
      <button onclick="switchSearchTab('web',this)">🌐 Web 搜索</button>
    </div>
    <div id="searchTabContent">${renderVaultSearch()}</div>`;
}

function renderVaultSearch() {
  return `
    <div class="search-box">
      <input type="text" class="input" id="vaultSearchInput" placeholder="搜索 Vault 知识库..." onkeydown="if(event.key==='Enter')doVaultSearch()">
      <button class="btn" onclick="doVaultSearch()">搜索</button>
    </div>
    <div style="display:grid;grid-template-columns:200px 1fr;gap:16px">
      <div class="vault-sidebar" style="background:var(--card);border-radius:12px;padding:12px;border:1px solid var(--border)">
        <h3>PARA 分类</h3><div id="vaultPara"></div>
        <h3 style="margin-top:12px">标签</h3><div id="vaultTags"></div>
      </div>
      <div id="vaultResults" style="background:var(--card);border-radius:12px;padding:16px;border:1px solid var(--border);min-height:300px">
        <div class="loading">选择分类或搜索</div>
      </div>
    </div>`;
}

function renderWebSearch() {
  return `
    <div class="search-box">
      <input type="text" class="input" id="webSearchInput" placeholder="输入搜索关键词..." onkeydown="if(event.key==='Enter')doWebSearch()">
      <select class="select" id="searchMode"><option value="quick">快速</option><option value="deep">深度</option><option value="academic">学术</option></select>
      <button class="btn" onclick="doWebSearch()">搜索</button>
    </div>
    <div id="webResults"></div>`;
}

function switchSearchTab(tab, btn) {
  document.querySelectorAll(".tab-nav button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const content = document.getElementById("searchTabContent");
  if (tab === "vault") {
    content.innerHTML = renderVaultSearch();
    loadVaultCategories();
  } else {
    content.innerHTML = renderWebSearch();
  }
}

async function loadVaultCategories() {
  try {
    const stats = await api("/vault/stats");
    document.getElementById("vaultPara").innerHTML = Object.entries(stats.paraDistribution || {}).sort((a,b)=>b[1]-a[1]).map(([k,v]) =>
      `<div class="vault-item" onclick="browseVault('${k}')">${k} <span style="color:var(--muted)">(${v})</span></div>`).join("");
  } catch {}
}

async function doVaultSearch() {
  const q = document.getElementById("vaultSearchInput").value.trim();
  if (!q) return;
  document.getElementById("vaultResults").innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const res = await api(`/search?q=${encodeURIComponent(q)}&limit=20`);
    const notes = res.results || [];
    document.getElementById("vaultResults").innerHTML = notes.map(r => `
      <div class="result-item" onclick="showNote('${encodeURIComponent(r.note.path)}')">
        <div class="score">得分: ${r.score.toFixed(1)}</div>
        <div class="title">${escapeHtml(r.note.title)}</div>
        <div class="path">${r.note.path}</div>
        <div class="snippet">${escapeHtml(r.excerpt)}</div>
      </div>`).join("");
  } catch (e) { document.getElementById("vaultResults").innerHTML = `<div style="color:var(--danger)">搜索失败: ${e.message}</div>`; }
}

async function browseVault(category) {
  document.getElementById("vaultResults").innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const res = await api(`/vault/para/${category}`);
    document.getElementById("vaultResults").innerHTML = (res.notes || []).map(n => `
      <div class="result-item" onclick="showNote('${encodeURIComponent(n.path)}')">
        <div class="title">${escapeHtml(n.title)}</div>
        <div class="path">${n.path}</div>
        <div class="snippet">${escapeHtml(n.content?.slice(0, 200) || "")}...</div>
      </div>`).join("");
  } catch {}
}

async function showNote(path) {
  try {
    const res = await api(`/vault/note?path=${path}`);
    document.getElementById("vaultResults").innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3>${escapeHtml(res.frontmatter?.title || "笔记")}</h3>
        <button class="btn small secondary" onclick="renderSearch();switchSearchTab('vault',document.querySelector('.tab-nav button'))">返回</button>
      </div>
      <pre style="background:var(--bg);padding:12px;border-radius:8px;overflow-x:auto;font-size:0.85rem;line-height:1.6">${escapeHtml(res.content)}</pre>`;
  } catch {}
}

async function doWebSearch() {
  const query = document.getElementById("webSearchInput").value.trim();
  if (!query) return;
  const mode = document.getElementById("searchMode").value;
  const el = document.getElementById("webResults");
  el.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const res = await api(`/enhanced-search?q=${encodeURIComponent(query)}&mode=${mode}`);
    if (!res.results?.length) { el.innerHTML = `<div class="loading">无结果</div>`; return; }
    el.innerHTML = res.results.map(r => `
      <div class="result-item">
        <div class="title"><a href="${r.link}" target="_blank" style="color:var(--accent);text-decoration:none">${escapeHtml(r.title)}</a></div>
        <div class="path">${r.engine} · ${r.displayedUrl}</div>
        <div class="snippet">${escapeHtml(r.snippet)}</div>
      </div>`).join("");
  } catch (e) { el.innerHTML = `<div style="color:var(--danger)">搜索失败: ${e.message}</div>`; }
}

// ===== KG (Knowledge Graph Visualization) =====
let kgCy = null;           // Cytoscape instance
let kgSelectedNode = null; // currently selected node id

function renderKG() {
  if (typeof cytoscape === "undefined") {
    document.getElementById("pageContent").innerHTML = `
      <div class="card" style="text-align:center;padding:40px">
        <h2 style="color:var(--warn)">Cytoscape.js 未加载</h2>
        <p style="color:var(--muted);margin-top:8px">请检查网络连接，CDN 加载失败后无法显示图谱。</p>
        <button class="btn secondary" style="margin-top:16px" onclick="location.reload()">刷新页面</button>
      </div>`;
    return;
  }

  document.getElementById("pageContent").innerHTML = `
    <!-- Build bar -->
    <div class="kg-build-bar">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn" onclick="kgBuild()">🔨 构建图谱</button>
        <button class="btn secondary" onclick="kgRefresh()">⟳ 刷新</button>
        <span id="kgBuildStatus" style="font-size:0.8rem;color:var(--muted)"></span>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn small secondary" onclick="kgFitView()">🎯 适应</button>
        <button class="btn small secondary" onclick="kgLayout()">🔄 重排布局</button>
      </div>
    </div>

    <!-- Stats row -->
    <div class="kg-stats-row" id="kgStats">
      <div class="kg-stat-card"><div class="kg-stat-value">-</div><div class="kg-stat-label">节点</div></div>
      <div class="kg-stat-card"><div class="kg-stat-value">-</div><div class="kg-stat-label">边</div></div>
      <div class="kg-stat-card"><div class="kg-stat-value">-</div><div class="kg-stat-label">项目</div></div>
      <div class="kg-stat-card"><div class="kg-stat-value">-</div><div class="kg-stat-label">文件</div></div>
    </div>

    <!-- Main layout: entity list + graph canvas -->
    <div class="kg-layout">
      <div class="kg-entity-panel">
        <div class="search-box">
          <input type="text" class="input" id="kgEntitySearch" placeholder="搜索实体..." onkeydown="if(event.key==='Enter')kgFilterEntities()">
          <select class="select" id="kgTypeFilter" onchange="kgFilterEntities()">
            <option value="">全部类型</option>
            <option value="project">project</option>
            <option value="file">file</option>
            <option value="code_function">function</option>
            <option value="code_method">method</option>
            <option value="code_class">class</option>
            <option value="code_interface">interface</option>
            <option value="tool">tool</option>
            <option value="concept">concept</option>
          </select>
        </div>
        <div class="kg-entity-list" id="kgEntityList">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
      <div class="kg-canvas-wrap">
        <div class="kg-canvas-toolbar">
          <button title="放大" onclick="kgZoomIn()">+</button>
          <button title="缩小" onclick="kgZoomOut()">-</button>
          <button title="适应" onclick="kgFitView()">⊡</button>
        </div>
        <div id="kgCy"></div>
      </div>
    </div>

    <!-- Detail panel -->
    <div class="kg-detail-panel" id="kgDetail">
      <div class="kg-detail-header">
        <h3 id="kgDetailTitle">实体详情</h3>
        <div style="display:flex;gap:6px">
          <button class="btn small secondary" id="kgExpandBtn" onclick="kgExpandSelected()">🔍 展开关系</button>
          <button class="btn small secondary" onclick="kgHideDetail()">✕</button>
        </div>
      </div>
      <div id="kgDetailBody"></div>
    </div>`;

  kgLoadStats();
  kgLoadGraph();
}

// --- Stats ---
async function kgLoadStats() {
  try {
    const res = await api("/kg/stats");
    const d = res.data || res;
    const cards = document.querySelectorAll("#kgStats .kg-stat-card");
    if (cards.length >= 4) {
      cards[0].querySelector(".kg-stat-value").textContent = d.totalNodes ?? 0;
      cards[1].querySelector(".kg-stat-value").textContent = d.totalEdges ?? 0;
      cards[2].querySelector(".kg-stat-value").textContent = d.totalProjects ?? 0;
      cards[3].querySelector(".kg-stat-value").textContent = d.totalFiles ?? 0;
    }
  } catch {}
}

// --- Graph load ---
async function kgLoadGraph() {
  try {
    const res = await api("/kg/graph");
    const data = res.data || res;
    const nodes = (data.nodes || []).map(n => ({
      data: { id: String(n.id), name: n.name, label: n.label || n.name, type: n.type }
    }));
    const edges = (data.edges || []).map((e, i) => ({
      data: { id: `e${i}`, source: String(e.source), target: String(e.target), type: e.type }
    }));
    kgInitCy(nodes, edges);
  } catch {
    // Fallback: load from entities + traverse
    kgLoadFromEntities();
  }
}

async function kgLoadFromEntities() {
  try {
    const res = await api("/kg/entities?limit=200");
    const entities = res.data || [];
    const nodes = entities.map(e => ({
      data: { id: String(e.id), name: e.name, label: e.name.split("/").pop().split(".").pop(), type: e.type }
    }));
    kgInitCy(nodes, []);
  } catch {}
}

// --- Cytoscape init ---
function kgInitCy(nodes, edges) {
  const container = document.getElementById("kgCy");
  if (!container) return;

  // Destroy previous instance to prevent memory leak
  if (kgCy) { kgCy.destroy(); kgCy = null; }

  const typeColors = {
    project:        { bg: "var(--accent)",  shape: "hexagon",   size: 50 },
    file:           { bg: "#3b82f6",        shape: "rectangle",  size: 35 },
    code_function:  { bg: "#22c55e",        shape: "ellipse",    size: 30 },
    code_method:    { bg: "#22c55e",        shape: "ellipse",    size: 28 },
    code_class:     { bg: "#a855f7",        shape: "diamond",    size: 38 },
    code_interface: { bg: "#a855f7",        shape: "diamond",    size: 36 },
    tool:           { bg: "#f97316",        shape: "triangle",   size: 32 },
    concept:        { bg: "#eab308",        shape: "star",       size: 32 },
  };

  const edgeStyles = {
    calls:      { style: "solid",  color: "#64748b" },
    part_of:    { style: "dashed", color: "#475569" },
    depends_on: { style: "dotted", color: "#94a3b8" },
    imports:    { style: "dashed", color: "#6366f1" },
    contains:   { style: "solid",  color: "#64748b" },
  };

  const nodeStyles = Object.entries(typeColors).map(([type, cfg]) => ({
    selector: `node[type="${type}"]`,
    style: {
      "background-color": cfg.bg,
      shape: cfg.shape,
      width: cfg.size,
      height: cfg.size,
      label: "data(label)",
      "font-size": "10px",
      color: "#e2e8f0",
      "text-valign": "bottom",
      "text-margin-y": 6,
      "text-max-width": "80px",
      "text-wrap": "ellipsis",
      "border-width": 0,
    }
  }));

  // Default node style for unknown types
  nodeStyles.push({
    selector: "node",
    style: {
      "background-color": "#6b7280",
      shape: "ellipse",
      width: 28,
      height: 28,
      label: "data(label)",
      "font-size": "10px",
      color: "#e2e8f0",
      "text-valign": "bottom",
      "text-margin-y": 6,
      "text-max-width": "80px",
      "text-wrap": "ellipsis",
    }
  });

  const edgeStyleRules = Object.entries(edgeStyles).map(([type, cfg]) => ({
    selector: `edge[type="${type}"]`,
    style: {
      "line-style": cfg.style,
      "line-color": cfg.color,
      "target-arrow-color": cfg.color,
      "target-arrow-shape": "triangle",
      width: 1.5,
      opacity: 0.6,
      "curve-style": "bezier",
    }
  }));

  // Default edge style
  edgeStyleRules.push({
    selector: "edge",
    style: {
      "line-style": "solid",
      "line-color": "#475569",
      "target-arrow-color": "#475569",
      "target-arrow-shape": "triangle",
      width: 1,
      opacity: 0.5,
      "curve-style": "bezier",
    }
  });

  // Highlighted styles
  edgeStyleRules.push({
    selector: "edge.highlighted",
    style: {
      "line-color": "#38bdf8",
      "target-arrow-color": "#38bdf8",
      width: 2.5,
      opacity: 1,
      "z-index": 999,
    }
  });

  nodeStyles.push({
    selector: "node.highlighted",
    style: {
      "border-width": 3,
      "border-color": "#38bdf8",
      "border-opacity": 1,
      "z-index": 999,
    }
  });

  nodeStyles.push({
    selector: "node.faded",
    style: { opacity: 0.25 }
  });

  edgeStyleRules.push({
    selector: "edge.faded",
    style: { opacity: 0.1 }
  });

  kgCy = cytoscape({
    container,
    elements: [...nodes, ...edges],
    style: [...nodeStyles, ...edgeStyleRules],
    layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 80, padding: 30 },
    minZoom: 0.1,
    maxZoom: 4,
    wheelSensitivity: 0.3,
  });

  // Node click handler
  kgCy.on("tap", "node", (evt) => {
    const node = evt.target;
    kgSelectNode(node.id());
    // Highlight neighborhood
    kgCy.elements().removeClass("highlighted faded");
    const neighborhood = node.closedNeighborhood();
    kgCy.elements().addClass("faded");
    neighborhood.removeClass("faded").addClass("highlighted");
  });

  // Background click resets
  kgCy.on("tap", (evt) => {
    if (evt.target === kgCy) {
      kgCy.elements().removeClass("highlighted faded");
      kgHideDetail();
    }
  });

  // Populate entity list sidebar
  kgPopulateEntityList(nodes);
}

function kgPopulateEntityList(nodes) {
  const list = document.getElementById("kgEntityList");
  if (!list) return;

  if (!nodes || nodes.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);text-align:center;padding:20px;font-size:0.85rem">暂无实体数据</div>`;
    return;
  }

  const typeColors = {
    project: "var(--accent)", file: "#3b82f6",
    code_function: "#22c55e", code_method: "#22c55e",
    code_class: "#a855f7", code_interface: "#a855f7",
    tool: "#f97316", concept: "#eab308",
  };

  list.innerHTML = nodes.map(n => {
    const d = n.data;
    const color = typeColors[d.type] || "#6b7280";
    return `<div class="kg-entity-item" data-id="${d.id}" onclick="kgSelectEntityFromList('${d.id}')">
      <span class="name" style="border-left:3px solid ${color};padding-left:8px">${escapeHtml(d.label)}</span>
      <span class="type-badge">${d.type || "unknown"}</span>
    </div>`;
  }).join("");
}

function kgSelectEntityFromList(id) {
  if (!kgCy) return;
  const node = kgCy.getElementById(id);
  if (node.length) {
    kgCy.elements().removeClass("highlighted faded");
    const neighborhood = node.closedNeighborhood();
    kgCy.elements().addClass("faded");
    neighborhood.removeClass("faded").addClass("highlighted");
    kgCy.center(node);
    kgSelectNode(id);
  }
  // Mark active in list
  document.querySelectorAll(".kg-entity-item").forEach(el => el.classList.remove("active"));
  const activeEl = document.querySelector(`.kg-entity-item[data-id="${id}"]`);
  if (activeEl) activeEl.classList.add("active");
}

async function kgSelectNode(id) {
  kgSelectedNode = id;
  const panel = document.getElementById("kgDetail");
  const title = document.getElementById("kgDetailTitle");
  const body = document.getElementById("kgDetailBody");
  if (!panel || !title || !body) return;

  // Get node data from Cytoscape
  const node = kgCy ? kgCy.getElementById(id) : null;
  const name = node?.data("name") || id;
  title.textContent = name;
  panel.classList.add("show");
  body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

  try {
    const res = await api(`/kg/entity/${encodeURIComponent(name)}`);
    const entity = res.data?.entity || {};
    const rels = res.data?.relationships || [];

    const props = typeof entity.properties === "string" ? JSON.parse(entity.properties || "{}") : (entity.properties || {});
    const propHtml = Object.entries(props).slice(0, 8).map(([k, v]) =>
      `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:0.8rem;border-bottom:1px solid var(--border)">
        <span style="color:var(--muted)">${escapeHtml(k)}</span>
        <span style="font-family:monospace;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(String(v))}</span>
      </div>`
    ).join("");

    const relHtml = rels.length > 0 ? rels.map(r =>
      `<div class="kg-rel-item" onclick="kgSelectEntityFromList(null);kgNavigateEntity('${encodeURIComponent(r.other_entity)}')">
        <span class="rel-type">${r.relation_type}</span>
        <span style="color:${r.direction === 'outgoing' ? 'var(--success)' : 'var(--accent)'}">${r.direction === 'outgoing' ? '→' : '←'}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.other_entity)}</span>
        <span style="font-size:0.65rem;color:var(--muted)">${r.other_type || ""}</span>
      </div>`
    ).join("") : `<div style="color:var(--muted);font-size:0.8rem">暂无关系</div>`;

    body.innerHTML = `
      <div class="kg-detail-grid">
        <div class="kg-detail-section">
          <h4>基本信息</h4>
          <div style="font-size:0.8rem;margin-bottom:8px">
            <div style="margin-bottom:4px"><strong>类型:</strong> <span class="badge">${entity.type || "unknown"}</span></div>
            ${entity.description ? `<div style="margin-bottom:4px"><strong>描述:</strong> ${escapeHtml(entity.description)}</div>` : ""}
            ${entity.source ? `<div><strong>来源:</strong> <span style="font-family:monospace;font-size:0.75rem">${escapeHtml(entity.source)}</span></div>` : ""}
          </div>
          ${propHtml ? `<h4 style="margin-top:8px">属性</h4>${propHtml}` : ""}
        </div>
        <div class="kg-detail-section">
          <h4>关系 (${rels.length})</h4>
          <div class="kg-rel-list">${relHtml}</div>
        </div>
      </div>`;
  } catch {
    body.innerHTML = `<div style="color:var(--muted);font-size:0.8rem">加载详情失败</div>`;
  }
}

function kgHideDetail() {
  const panel = document.getElementById("kgDetail");
  if (panel) panel.classList.remove("show");
  kgSelectedNode = null;
}

async function kgExpandSelected() {
  if (!kgSelectedNode || !kgCy) return;
  const node = kgCy.getElementById(kgSelectedNode);
  const name = node?.data("name");
  if (!name) return;

  const status = document.getElementById("kgBuildStatus");
  if (status) status.textContent = "正在展开关系...";

  try {
    const res = await api(`/kg/traverse/${encodeURIComponent(name)}?depth=2`);
    const results = res.data || [];
    if (results.length === 0) {
      if (status) status.textContent = "无更多关系";
      return;
    }

    // Add new nodes and edges to existing graph
    const existingIds = new Set(kgCy.nodes().map(n => n.id()));
    const newElements = [];

    results.forEach(row => {
      // The traverse function returns rows with entity/related entity info
      const relId = String(row.related_id || row.id);
      const relName = row.related_name || row.name;
      const relType = row.related_type || row.type;

      if (relId && !existingIds.has(relId)) {
        existingIds.add(relId);
        newElements.push({
          data: {
            id: relId,
            name: relName,
            label: (relName || "").split("/").pop().split(".").pop(),
            type: relType,
          }
        });
      }

      // Add edge if both endpoints exist
      if (row.entity_id && row.related_id) {
        newElements.push({
          data: {
            id: `exp_${row.entity_id}_${row.related_id}`,
            source: String(row.entity_id),
            target: String(row.related_id),
            type: row.relation_type || "related",
          }
        });
      }
    });

    if (newElements.length > 0) {
      kgCy.add(newElements);
      kgCy.layout({ name: "cose", animate: true, nodeRepulsion: 8000, idealEdgeLength: 80 }).run();
    }

    if (status) status.textContent = `已展开 ${results.length} 条关系`;
  } catch {
    if (status) status.textContent = "展开失败";
  }
}

function kgNavigateEntity(encodedName) {
  if (!encodedName) return;
  // Try to find the entity in the current graph
  const name = decodeURIComponent(encodedName);
  const found = kgCy?.nodes().find(n => n.data("name") === name);
  if (found) {
    kgSelectEntityFromList(found.id());
  } else {
    // Load entity detail to see its relationships
    kgSelectedNode = null;
    kgSelectNodeByName(name);
  }
}

async function kgSelectNodeByName(name) {
  const panel = document.getElementById("kgDetail");
  const title = document.getElementById("kgDetailTitle");
  const body = document.getElementById("kgDetailBody");
  if (!panel || !title || !body) return;
  title.textContent = name;
  panel.classList.add("show");
  body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const res = await api(`/kg/entity/${encodeURIComponent(name)}`);
    const entity = res.data?.entity || {};
    const rels = res.data?.relationships || [];
    body.innerHTML = `
      <div class="kg-detail-grid">
        <div class="kg-detail-section">
          <h4>基本信息</h4>
          <div style="font-size:0.8rem">
            <div style="margin-bottom:4px"><strong>类型:</strong> <span class="badge">${entity.type || "unknown"}</span></div>
            ${entity.description ? `<div>${escapeHtml(entity.description)}</div>` : ""}
          </div>
        </div>
        <div class="kg-detail-section">
          <h4>关系 (${rels.length})</h4>
          <div class="kg-rel-list">${rels.map(r =>
            `<div class="kg-rel-item" onclick="kgNavigateEntity('${encodeURIComponent(r.other_entity)}')">
              <span class="rel-type">${r.relation_type}</span>
              <span>${r.direction === 'outgoing' ? '→' : '←'}</span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.other_entity)}</span>
            </div>`
          ).join("")}</div>
        </div>
      </div>`;
  } catch {
    body.innerHTML = `<div style="color:var(--muted);font-size:0.8rem">加载失败</div>`;
  }
}

// --- Entity list filter ---
async function kgFilterEntities() {
  const q = document.getElementById("kgEntitySearch")?.value.trim() || "";
  const type = document.getElementById("kgTypeFilter")?.value || "";
  const list = document.getElementById("kgEntityList");
  if (!list) return;
  list.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    params.set("limit", "100");
    const res = await api(`/kg/entities?${params.toString()}`);
    const entities = (res.data || []);

    const typeColors = {
      project: "var(--accent)", file: "#3b82f6",
      code_function: "#22c55e", code_method: "#22c55e",
      code_class: "#a855f7", code_interface: "#a855f7",
      tool: "#f97316", concept: "#eab308",
    };

    if (entities.length === 0) {
      list.innerHTML = `<div style="color:var(--muted);text-align:center;padding:20px;font-size:0.85rem">无匹配实体</div>`;
      return;
    }

    list.innerHTML = entities.map(e => {
      const color = typeColors[e.type] || "#6b7280";
      const label = (e.name || "").split("/").pop().split(".").pop();
      return `<div class="kg-entity-item" data-id="${e.id}" onclick="kgSelectEntityFromList('${String(e.id)}')">
        <span class="name" style="border-left:3px solid ${color};padding-left:8px">${escapeHtml(label)}</span>
        <span class="type-badge">${e.type || "unknown"}</span>
      </div>`;
    }).join("");
  } catch {
    list.innerHTML = `<div style="color:var(--danger);padding:12px;font-size:0.85rem">加载失败</div>`;
  }
}

// --- Graph actions ---
async function kgBuild() {
  const status = document.getElementById("kgBuildStatus");
  if (status) status.textContent = "正在构建图谱，请稍候...";
  try {
    await api("/kg/build", { method: "POST" });
    if (status) status.textContent = "构建完成！正在刷新...";
    setTimeout(() => kgRefresh(), 500);
  } catch (e) {
    if (status) status.textContent = "构建失败: " + e.message;
  }
}

function kgRefresh() {
  kgLoadStats();
  kgLoadGraph();
  const status = document.getElementById("kgBuildStatus");
  if (status) status.textContent = "";
}

function kgFitView() {
  if (kgCy) kgCy.fit(undefined, 30);
}

function kgLayout() {
  if (kgCy) {
    kgCy.layout({ name: "cose", animate: true, nodeRepulsion: 8000, idealEdgeLength: 80, padding: 30 }).run();
  }
}

function kgZoomIn() {
  if (kgCy) kgCy.zoom(kgCy.zoom() * 1.3);
}

function kgZoomOut() {
  if (kgCy) kgCy.zoom(kgCy.zoom() / 1.3);
}

// ===== OCR =====
let ocrObjectUrl = null;
function renderOcr() {
  document.getElementById("pageContent").innerHTML = `
    <div class="card">
      <h2>📄 OCR 文档识别</h2>
      <div style="margin-bottom:16px">
        <input type="file" id="ocrFile" accept="image/*,.pdf" style="display:none" onchange="handleOcrFile(this)">
        <button class="btn" onclick="document.getElementById('ocrFile').click()">选择文件</button>
        <span style="color:var(--muted);margin-left:12px;font-size:0.85rem">支持图片和 PDF</span>
      </div>
      <div id="ocrPreview" style="margin-bottom:16px"></div>
      <div id="ocrResult"></div>
    </div>`;
}

async function handleOcrFile(input) {
  const file = input.files[0];
  if (!file) return;
  const preview = document.getElementById("ocrPreview");
  const result = document.getElementById("ocrResult");
  result.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

  // Revoke previous Object URL to prevent memory leak
  if (ocrObjectUrl) { URL.revokeObjectURL(ocrObjectUrl); ocrObjectUrl = null; }

  if (file.type.startsWith("image/")) {
    const url = URL.createObjectURL(file);
    ocrObjectUrl = url;
    preview.innerHTML = `<img src="${url}" style="max-width:100%;max-height:300px;border-radius:8px">`;
    // Auto-revoke after image loads
    const img = preview.querySelector("img");
    if (img) img.onload = () => { URL.revokeObjectURL(url); ocrObjectUrl = null; };
  } else {
    preview.innerHTML = `<div style="padding:20px;background:var(--bg);border-radius:8px;text-align:center">📄 ${file.name}</div>`;
  }

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(API + "/ocr/scan", {
      method: "POST",
      body: formData,
      headers: { "x-api-key": localStorage.getItem("apiKey") || "" }
    });
    const data = await res.json();
    if (data.text) {
      result.innerHTML = `
        <div style="background:var(--bg);padding:12px;border-radius:8px;margin-bottom:12px">
          <div style="font-size:0.8rem;color:var(--muted);margin-bottom:8px">识别结果:</div>
          <pre style="white-space:pre-wrap;font-size:0.85rem;line-height:1.6">${escapeHtml(data.text)}</pre>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn small secondary" onclick="copyOcrText()">📋 复制文本</button>
          <button class="btn small secondary" onclick="saveOcrToVault()">💾 保存到 Vault</button>
        </div>`;
    } else {
      result.innerHTML = `<div style="color:var(--warn)">未能识别文本</div>`;
    }
  } catch (e) {
    result.innerHTML = `<div style="color:var(--danger)">OCR 失败: ${e.message}</div>`;
  }
}

function copyOcrText() {
  const text = document.querySelector("#ocrResult pre")?.textContent;
  if (text) navigator.clipboard.writeText(text).then(() => alert("已复制到剪贴板"));
}

async function saveOcrToVault() {
  const text = document.querySelector("#ocrResult pre")?.textContent;
  if (!text) return;
  const title = prompt("输入笔记标题:", `OCR-${new Date().toLocaleDateString()}`);
  if (!title) return;
  try {
    await api("/vault/write", {
      method: "POST",
      body: JSON.stringify({ path: `ocr/${title}.md`, content: text, frontmatter: { title, source: "ocr", date: new Date().toISOString() } })
    });
    alert("已保存到 Vault");
  } catch (e) { alert("保存失败: " + e.message); }
}

// ===== Settings =====
function renderSettings() {
  document.getElementById("pageContent").innerHTML = `
    <div class="tab-nav">
      <button class="active" onclick="switchSettingsTab('apikeys',this)">🔑 API Keys</button>
      <button onclick="switchSettingsTab('models',this)">🧠 模型配置</button>
      <button onclick="switchSettingsTab('mcp',this)">🔧 MCP 工具</button>
      <button onclick="switchSettingsTab('skills',this)">🎯 Skill 市场</button>
      <button onclick="switchSettingsTab('features',this)">⚡ 功能开关</button>
    </div>
    <div id="settingsTabContent">${renderApiKeysTab()}</div>`;
  loadApiKeyStatus();
}

function switchSettingsTab(tab, btn) {
  document.querySelectorAll(".tab-nav button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const content = document.getElementById("settingsTabContent");
  if (tab === "apikeys") { content.innerHTML = renderApiKeysTab(); loadApiKeyStatus(); }
  else if (tab === "models") content.innerHTML = renderModelsTab();
  else if (tab === "mcp") { content.innerHTML = renderMcpTab(); loadMcpTools(); }
  else if (tab === "skills") { content.innerHTML = renderSkillsTab(); loadSkills(); }
  else if (tab === "features") { content.innerHTML = renderFeaturesTab(); loadFeatures(); }
}

// --- API Keys Tab ---
function renderApiKeysTab() {
  return `
    <div class="card">
      <h2>🔑 Provider API Keys</h2>
      <div style="font-size:0.8rem;color:var(--muted);margin-bottom:12px">
        在此处填入的 API Key 仅保存在<strong>服务器内存</strong>中，不会写入 <code>.env</code>，重启服务后失效。
      </div>
      <div id="apiKeyList" class="loading"><div class="spinner"></div></div>
    </div>`;
}

// --- Models Tab ---
function renderModelsTab() {
  return `
    <div class="card">
      <h2>🧠 模型配置</h2>
      <div id="modelsList" class="loading"><div class="spinner"></div></div>
    </div>`;
}

async function loadModels() {
  try {
    const res = await api("/engines");
    const list = document.getElementById("modelsList");
    if (!list) return;
    list.innerHTML = (res || []).map(e => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
        <div>
          <div style="font-weight:600">${e.name}</div>
          <div style="font-size:0.75rem;color:var(--muted)">${e.description || ""}</div>
        </div>
        <span class="badge ${e.available ? 'ok' : 'warn'}">${e.available ? "可用" : "未配置"}</span>
      </div>
    `).join("");
  } catch {}
}

// --- MCP Tab ---
function renderMcpTab() {
  return `
    <div class="card">
      <h2>🔧 MCP 工具配置</h2>
      <div id="mcpToolsList" class="loading"><div class="spinner"></div></div>
    </div>`;
}

async function loadMcpTools() {
  try {
    const res = await api("/mcp/tools");
    const list = document.getElementById("mcpToolsList");
    if (!list) return;
    list.innerHTML = (res.tools || []).map(t => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
        <div>
          <div style="font-weight:600">${t.name}</div>
          <div style="font-size:0.75rem;color:var(--muted)">${t.description || ""}</div>
        </div>
        <span class="badge ok">已启用</span>
      </div>
    `).join("");
  } catch {}
}

// --- Skills Tab ---
function renderSkillsTab() {
  return `
    <div class="card">
      <h2>🎯 Skill 市场</h2>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <input type="text" class="input" id="skillSearch" placeholder="搜索 Skills..." onkeydown="if(event.key==='Enter')searchSkills()">
        <button class="btn" onclick="searchSkills()">搜索</button>
      </div>
      <div id="skillsList" class="loading"><div class="spinner"></div></div>
    </div>`;
}

async function loadSkills() {
  try {
    const res = await api("/plugins/active-tools");
    const list = document.getElementById("skillsList");
    if (!list) return;
    list.innerHTML = (res.tools || []).map(t => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
        <div>
          <div style="font-weight:600">${t.name}</div>
          <div style="font-size:0.75rem;color:var(--muted)">${t.description || ""}</div>
        </div>
        <span class="badge ok">运行中</span>
      </div>
    `).join("");
  } catch {}
}

async function searchSkills() {
  const q = document.getElementById("skillSearch")?.value.trim();
  if (!q) { loadSkills(); return; }
  try {
    const res = await api(`/plugins?search=${encodeURIComponent(q)}`);
    const list = document.getElementById("skillsList");
    if (!list) return;
    list.innerHTML = (res.plugins || []).map(p => `
      <div style="padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:600">${p.name}</div>
          <span class="badge ${p.enabled ? 'ok' : 'warn'}">${p.enabled ? "已启用" : "已禁用"}</span>
        </div>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:4px">${p.description || ""}</div>
      </div>
    `).join("");
  } catch {}
}

// --- Features Tab ---
function renderFeaturesTab() {
  return `
    <div class="card">
      <h2>⚡ 功能开关</h2>
      <div id="featuresList">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-weight:600">深色模式</div>
            <div style="font-size:0.75rem;color:var(--muted)">切换深色/浅色主题</div>
          </div>
          <select class="select" id="themeSelect" onchange="setTheme(this.value)">
            <option value="system" ${!localStorage.getItem("theme") ? "selected" : ""}>跟随系统</option>
            <option value="dark" ${localStorage.getItem("theme") === "dark" ? "selected" : ""}>深色</option>
            <option value="light" ${localStorage.getItem("theme") === "light" ? "selected" : ""}>浅色</option>
          </select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-weight:600">WebSocket 实时推送</div>
            <div style="font-size:0.75rem;color:var(--muted)">接收系统状态更新</div>
          </div>
          <span class="badge ${ws?.readyState === 1 ? 'ok' : 'warn'}" id="wsFeatureStatus">${ws?.readyState === 1 ? "已连接" : "未连接"}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-weight:600">自动保存对话</div>
            <div style="font-size:0.75rem;color:var(--muted)">本地存储最近 100 条消息</div>
          </div>
          <button class="btn small secondary" onclick="clearChat()">清除历史</button>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px">
          <div>
            <div style="font-weight:600">清除所有缓存</div>
            <div style="font-size:0.75rem;color:var(--muted)">清除本地存储和 Service Worker 缓存</div>
          </div>
          <button class="btn small secondary" onclick="clearCache()">清除缓存</button>
        </div>
      </div>
    </div>`;
}

function loadFeatures() {
  const wsStatus = document.getElementById("wsFeatureStatus");
  if (wsStatus) wsStatus.innerHTML = ws?.readyState === 1 ? "已连接" : "未连接";
  if (wsStatus) wsStatus.className = `badge ${ws?.readyState === 1 ? 'ok' : 'warn'}`;
}

function setTheme(t) {
  if (t === "system") { localStorage.removeItem("theme"); darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches; }
  else { localStorage.setItem("theme", t); darkMode = t === "dark"; }
  applyTheme();
}

function clearCache() {
  localStorage.removeItem("chatHistory");
  if ("caches" in window) caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  alert("缓存已清除");
}

// ===== Provider API Key Manager =====
const PROVIDER_META = {
  minimax:      { label: "MiniMax (MiniMax AI)",  cn: "国内直连，256K context", recommended: true },
  deepseek:     { label: "DeepSeek",              cn: "主力决策/编码模型" },
  siliconflow:  { label: "硅基流动 SiliconFlow",  cn: "7 个永久免费模型" },
  ofoxai:       { label: "OfoxAI",                cn: "国内直连，OpenRouter 替代" },
  ofoxai_anthropic: { label: "OfoxAI Anthropic",  cn: "Claude 协议兼容" },
  ofoxai_gemini:    { label: "OfoxAI Gemini",     cn: "Gemini 协议兼容" },
  openrouter:   { label: "OpenRouter",            cn: "353+ 模型聚合" },
  opencode:     { label: "OpenCode",              cn: "编码 Agent 免费模型网关" },
  kimi:         { label: "Kimi / Moonshot",       cn: "Kimi API" },
};

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

function updateAgentStatus(payload) {
  if (currentPage === "chat") loadAgentStatus();
}

// ===== Knowledge Pending Review Notification =====
let pendingReviewCount = 0;

async function checkPendingReview() {
  try {
    const res = await api("/knowledge/pending-review");
    pendingReviewCount = res.count || 0;
    updateNotificationBadge();
  } catch {}
}

function updateNotificationBadge() {
  let badge = document.getElementById("reviewBadge");
  if (pendingReviewCount > 0) {
    if (!badge) {
      const rightDiv = document.querySelector("#header .right");
      const div = document.createElement("div");
      div.id = "reviewBadge";
      div.className = "review-notification";
      div.onclick = showPendingReviewPanel;
      rightDiv.insertBefore(div, rightDiv.firstChild);
    }
    badge = document.getElementById("reviewBadge");
    badge.innerHTML = `<span class="review-dot"></span> ${pendingReviewCount} 篇笔记待审核`;
    badge.style.display = "flex";
  } else if (badge) {
    badge.style.display = "none";
  }
}

async function showPendingReviewPanel() {
  navigate("search");
  // Wait for search page to render, then show pending review
  setTimeout(async () => {
    const el = document.getElementById("pageContent");
    try {
      const res = await api("/knowledge/pending-review");
      if (!res.notes?.length) { el.innerHTML += `<div class="card" style="margin-top:12px"><div class="loading">暂无待审核笔记</div></div>`; return; }

      const panel = document.createElement("div");
      panel.className = "card";
      panel.style.marginTop = "12px";
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3>📋 待审核知识库笔记 (${res.count})</h3>
          <button class="btn small secondary" onclick="checkPendingReview();this.closest('.card').remove()">关闭</button>
        </div>
        ${res.notes.map(n => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--bg)">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(n.title)}</div>
              <div style="font-size:0.75rem;color:var(--muted);margin-top:2px">
                ${n.reason === "source-no-longer-tracked" ? "来源已不再追踪" : n.reason || "需要人工确认"}
                ${n.updated ? ` · ${n.updated}` : ""}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;margin-left:12px">
              <button class="btn small ok" onclick="reviewAction('${escapeHtml(n.file)}','approve',this)">✓ 通过</button>
              <button class="btn small danger" onclick="reviewAction('${escapeHtml(n.file)}','reject',this)">✕ 归档</button>
            </div>
          </div>`).join("")}`;
      el.insertBefore(panel, el.firstChild);
    } catch {}
  }, 100);
}

async function reviewAction(file, action, btn) {
  try {
    await api("/knowledge/pending-review/action", {
      method: "POST",
      body: JSON.stringify({ file, action })
    });
    const row = btn.closest("[style]");
    if (row) { row.style.opacity = "0.5"; row.style.pointerEvents = "none"; }
    pendingReviewCount = Math.max(0, pendingReviewCount - 1);
    updateNotificationBadge();
    if (pendingReviewCount === 0) {
      const panel = btn.closest(".card");
      if (panel) setTimeout(() => panel.remove(), 300);
    }
  } catch (e) {
    alert("操作失败: " + e.message);
  }
}

// ===== Utils =====
function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\n/g, "<br>");
}

// ===== Init =====
renderNav();
connectWs();
checkPendingReview();

// Load last session's conversation from server
(async function loadLastSession() {
  try {
    const res = await api("/memory/conversations?limit=100");
    if (res.messages && res.messages.length > 0) {
      const serverHistory = res.messages.map(m => ({
        role: m.role,
        content: m.content,
        agent: m.agent_id,
      }));
      // Merge with local history (server takes precedence for older messages)
      if (serverHistory.length > chatHistory.length) {
        chatHistory.length = 0;
        chatHistory.push(...serverHistory);
        localStorage.setItem("chatHistory", JSON.stringify(chatHistory.slice(-100)));
      }
    }
  } catch {}
})();

navigate("chat");

// PWA
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
