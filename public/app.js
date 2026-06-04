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
function connectWs() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    document.getElementById("connStatus").innerHTML = `<span class="status-dot"></span> 在线`;
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
    chatHistory.push({
      role: "assistant",
      content: res.response || res.result || res.code || res.review || JSON.stringify(res, null, 2),
      agent: res.agent || intentRes.intent,
      toolCalls: res.toolCalls
    });
    localStorage.setItem("chatHistory", JSON.stringify(chatHistory.slice(-100)));
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

// ===== OCR =====
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

  if (file.type.startsWith("image/")) {
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" style="max-width:100%;max-height:300px;border-radius:8px">`;
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

// ===== Utils =====
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}

// ===== Init =====
renderNav();
connectWs();
navigate("chat");

// PWA
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
