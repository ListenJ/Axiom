/**
 * OpenClaw Frontend v3.0 - Integrated Application
 * Uses modular component library while preserving all interactive features
 */

// ===== Module System =====
const OC = {
  version: '3.0.0',
  modules: new Map(),
  
  register(name, module) {
    this.modules.set(name, module);
    if (module.init) module.init();
    console.log(`[OC] Module registered: ${name}`);
  },
  
  get(name) {
    return this.modules.get(name);
  },
  
  async init() {
    console.log('[OC] Initializing v3.0...');
    for (const [name, mod] of this.modules) {
      if (mod.init) await mod.init();
    }
  }
};

// ===== Core: State Management =====
OC.register('state', {
  store: {},
  listeners: new Map(),
  
  get(key) {
    return this.store[key];
  },
  
  set(key, value) {
    const old = this.store[key];
    this.store[key] = value;
    this.notify(key, value, old);
  },
  
  subscribe(key, callback) {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(callback);
    return () => this.listeners.get(key).delete(callback);
  },
  
  notify(key, value, old) {
    if (this.listeners.has(key)) {
      this.listeners.get(key).forEach(cb => cb(value, old));
    }
  }
});

// ===== Core: Router =====
OC.register('router', {
  routes: {},
  current: null,
  transitionLock: false,
  pendingTimers: [],

  register(path, handler) {
    this.routes[path] = handler;
  },

  navigate(path) {
    if (this.current === path || this.transitionLock) return;
    this.transitionLock = true;
    this.pendingTimers.forEach(id => clearTimeout(id));
    this.pendingTimers = [];

    // Hide current page with fade-out
    if (this.current) {
      const el = document.getElementById(`page-${this.current}`);
      if (el) {
        el.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-8px)';
        const timer = setTimeout(() => {
          el.classList.add('hidden');
          el.style.opacity = '';
          el.style.transform = '';
          el.style.transition = '';
        }, 150);
        this.pendingTimers.push(timer);
      }
    }

    // Show new page with fade-in (after brief delay for fade-out)
    const delay = this.current ? 160 : 0;
    const showTimer = setTimeout(() => {
      const newEl = document.getElementById(`page-${path}`);
      if (newEl) {
        newEl.classList.remove('hidden');
        newEl.style.opacity = '0';
        newEl.style.transform = 'translateY(8px)';
        requestAnimationFrame(() => {
          newEl.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
          newEl.style.opacity = '1';
          newEl.style.transform = 'translateY(0)';
          const cleanup = setTimeout(() => {
            newEl.style.transition = '';
            this.transitionLock = false;
          }, 260);
          this.pendingTimers.push(cleanup);
        });
      } else {
        this.transitionLock = false;
      }
    }, delay);
    this.pendingTimers.push(showTimer);

    this.current = path;

    // Update UI — sidebar nav
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navEl = document.querySelector(`[data-page="${path}"]`);
    if (navEl) navEl.classList.add('active');

    // Update UI — bottom nav (mobile)
    document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active'));
    const bottomNavEl = document.querySelector(`.bottom-nav-item[data-page="${path}"]`);
    if (bottomNavEl) bottomNavEl.classList.add('active');

    // Update title
    const titles = {
      home: 'Dashboard',
      chat: 'Chat',
      search: 'Search',
      kg: 'Knowledge Graph',
      perf: 'Performance',
      code: 'Code Analysis',
      agents: 'Agent Workspace',
      router: 'Model Router',
      vault: 'Vault Explorer',
      settings: 'Settings'
    };
    document.getElementById('pageTitle').textContent = titles[path] || path;

    // Update URL hash
    window.location.hash = path;

    // Trigger route handler
    if (this.routes[path]) this.routes[path]();

    // Emit event
    OC.get('events').emit('route:changed', path);
  }
});

// ===== Core: API Client =====
OC.register('api', {
  baseURL: '',
  pending: new Map(),
  timeoutMs: 15000,

  abortKey(method, path) { return `${method}:${path}`; },

  abortPending(method, path) {
    const key = this.abortKey(method, path);
    const existing = this.pending.get(key);
    if (existing) {
      try { existing.abort(); } catch (e) { /* ignore */ }
      this.pending.delete(key);
    }
  },

  async request(method, path, data = null) {
    const url = this.baseURL + path;
    this.abortPending(method, path);
    const controller = new AbortController();
    const key = this.abortKey(method, path);
    this.pending.set(key, controller);

    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    };

    const apiKey = localStorage.getItem('apiKey');
    if (apiKey) options.headers['x-api-key'] = apiKey;
    if (data) options.body = JSON.stringify(data);

    const timeoutId = setTimeout(() => controller.abort('timeout'), this.timeoutMs);

    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`API Error: ${res.status}`);
      return res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(controller.signal.reason === 'timeout' ? '请求超时' : '请求已取消');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      this.pending.delete(key);
    }
  },

  get(path) { return this.request('GET', path); },
  post(path, data) { return this.request('POST', path, data); }
});

// ===== Core: Event Bus =====
OC.register('events', {
  bus: new Map(),
  
  on(event, handler) {
    if (!this.bus.has(event)) this.bus.set(event, new Set());
    this.bus.get(event).add(handler);
    return () => this.off(event, handler);
  },
  
  off(event, handler) {
    if (this.bus.has(event)) this.bus.get(event).delete(handler);
  },
  
  emit(event, data) {
    if (this.bus.has(event)) {
      this.bus.get(event).forEach(handler => handler(data));
    }
  }
});

// ===== Module: Chat =====
OC.register('chat', {
  history: [],
  isTyping: false,
  ws: null,
  
  init() {
    this.setupWebSocket();
    this.setupUI();
    this.loadHistory();
  },
  
  setupUI() {
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    
    sendBtn.onclick = () => this.send();
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    };
  },
  
  setupWebSocket() {
    const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    try {
      this.ws = new WebSocket(WS_URL);
      
      this.ws.onopen = () => {
        OC.get('events').emit('ws:connected');
        this.updateWsStatus(true);
      };
      
      this.ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'ping') {
          this.ws.send(JSON.stringify({ type: 'pong' }));
        } else {
          this.handleMessage(data);
        }
      };
      
      this.ws.onclose = () => {
        OC.get('events').emit('ws:disconnected');
        this.updateWsStatus(false);
        setTimeout(() => this.setupWebSocket(), 5000);
      };
      
      this.ws.onerror = () => {
        this.updateWsStatus(false);
      };
    } catch (err) {
      console.warn('[Chat] WebSocket connection failed:', err);
      this.updateWsStatus(false);
    }
  },
  
  updateWsStatus(connected) {
    const el = document.getElementById('wsStatus');
    if (el) {
      el.className = `badge ${connected ? 'ok' : ''}`;
      el.innerHTML = `<span class="status-dot" style="background:${connected ? 'var(--success)' : 'var(--muted)'}"></span>`;
      el.title = connected ? 'Connected' : 'Disconnected';
    }
  },
  
  send() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || this.isTyping) return;
    
    this.addMessage('user', text);
    input.value = '';
    this.showTypingIndicator();
    
    // Send to API
    OC.get('api').post('/chat', { message: text })
      .then(res => {
        this.hideTypingIndicator();
        this.addMessage('assistant', res.reply || res.message || 'No response');
      })
      .catch(err => {
        this.hideTypingIndicator();
        this.addMessage('system', 'Error: ' + err.message);
      });
  },
  
  showTypingIndicator() {
    this.isTyping = true;
    const log = document.getElementById('chatLog');
    const indicator = document.createElement('div');
    indicator.className = 'msg assistant typing';
    indicator.id = 'typingIndicator';
    indicator.innerHTML = `
      <div class="msg-bubble">
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    log.appendChild(indicator);
    log.scrollTop = log.scrollHeight;
  },
  
  hideTypingIndicator() {
    this.isTyping = false;
    const indicator = document.getElementById('typingIndicator');
    if (indicator) indicator.remove();
  },
  
  addMessage(role, content) {
    const log = document.getElementById('chatLog');
    // Hide empty state on first message
    const empty = document.getElementById('chatEmpty');
    if (empty) empty.remove();
    const msg = document.createElement('div');
    msg.className = `msg ${role}`;
    
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const metaHtml = role !== 'system' ? `<div class="msg-meta">${role === 'user' ? 'You' : 'Assistant'} · ${time}</div>` : '';
    
    msg.innerHTML = `${metaHtml}<div class="msg-bubble">${this.formatMessage(content)}</div>`;
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    
    this.history.push({ role, content, time: Date.now() });
    
    // Limit history
    if (this.history.length > 100) {
      this.history.shift();
    }
  },
  
  formatMessage(text) {
    // Escape HTML
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    // Code blocks with copy button
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const langLabel = lang || 'text';
      const escapedCode = code.trim();
      return `
        <div class="code-block-header">
          <span>${langLabel}</span>
          <button class="code-copy-btn" onclick="OC.get('chat').copyCode(this)">复制</button>
        </div>
        <pre><code class="language-${lang}">${escapedCode}</code></pre>
      `;
    });
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold/italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    
    return html;
  },
  
  copyCode(btn) {
    const code = btn.closest('.msg-bubble').querySelector('code');
    if (code) {
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = '已复制!';
        setTimeout(() => btn.textContent = '复制', 2000);
      });
    }
  },
  
  handleMessage(data) {
    if (data.type === 'chat' || data.role === 'assistant') {
      this.hideTypingIndicator();
      this.addMessage('assistant', data.content || data.message);
    }
  },
  
  loadHistory() {
    const saved = localStorage.getItem('chatHistory');
    if (saved) {
      try {
        this.history = JSON.parse(saved);
        this.history.forEach(h => this.addMessage(h.role, h.content));
      } catch (e) {
        console.warn('[Chat] Failed to load history:', e);
      }
    }
  },
  
  saveHistory() {
    localStorage.setItem('chatHistory', JSON.stringify(this.history.slice(-50)));
  }
});

// ===== Module: Search =====
OC.register('search', {
  init() {
    document.getElementById('searchBtn').onclick = () => this.search();
    document.getElementById('searchInput').onkeydown = (e) => {
      if (e.key === 'Enter') this.search();
    };
  },
  
  async search() {
    const query = document.getElementById('searchInput').value.trim();
    const filter = document.getElementById('searchParaFilter').value;
    
    if (!query) return;
    
    const container = document.getElementById('searchResults');
    container.innerHTML = '<p class="text-muted">搜索中...</p>';
    
    try {
      const results = await OC.get('api').post('/vault/search', { query, filter });
      this.renderResults(results);
    } catch (err) {
      container.innerHTML = `<p class="text-muted">搜索失败: ${err.message}</p>`;
      OC.get('ui').showToast('搜索失败: ' + err.message, 'error');
    }
  },
  
  renderResults(results) {
    const container = document.getElementById('searchResults');
    if (!results || results.length === 0) {
      container.innerHTML = '<p class="text-muted">未找到结果</p>';
      return;
    }

    this._searchVl = VirtualList.create({
      container,
      items: results,
      pageSize: 20,
      renderItem: (r) => `
        <div class="result-card" onclick="OC.get('search').openResult('${(r.path || '').replace(/'/g, "\\'")}')">
          <div class="result-title">
            ${r.title}
            ${r.score ? `<span class="score">${(r.score * 100).toFixed(0)}%</span>` : ''}
          </div>
          <div class="result-path">${r.path || ''}</div>
          <div class="result-excerpt">${r.excerpt || r.content || ''}</div>
          <div class="result-reasons">
            ${(r.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}
          </div>
        </div>
      `
    });
  },
  
  openResult(path) {
    if (path) {
      OC.get('ui').showToast(`打开: ${path}`, 'info');
    }
  }
});

// ===== Module: Code Analysis =====
OC.register('code', {
  init() {
    // Route handler
    OC.get('router').register('code', () => this.loadCodeData());
  },
  
  async loadCodeData() {
    await Promise.all([
      this.loadCodegraphStatus(),
      this.loadFileIndexStatus()
    ]);
  },
  
  async loadCodegraphStatus() {
    const panel = document.getElementById('codegraphStatusPanel');
    try {
      const status = await OC.get('api').get('/codegraph/status');
      panel.innerHTML = `
        <div class="data-table-wrapper">
          <table class="data-table">
            <tr><td>状态</td><td>${status.initialized ? '✅ 已初始化' : '❌ 未初始化'}</td></tr>
            <tr><td>文件数</td><td>${status.files || 0}</td></tr>
            <tr><td>节点数</td><td>${status.nodes || 0}</td></tr>
            <tr><td>边数</td><td>${status.edges || 0}</td></tr>
            <tr><td>最后更新</td><td>${status.lastUpdate ? new Date(status.lastUpdate).toLocaleString('zh-CN') : '从未'}</td></tr>
          </table>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取 CodeGraph 状态: ${err.message}</p>`;
    }
  },
  
  async loadFileIndexStatus() {
    const panel = document.getElementById('fileIndexStatus');
    try {
      const stats = await OC.get('api').get('/vault/stats');
      panel.innerHTML = `
        <div class="data-table-wrapper">
          <table class="data-table">
            <tr><td>总笔记</td><td>${stats.totalNotes || 0}</td></tr>
            <tr><td>总标签</td><td>${stats.totalTags || 0}</td></tr>
            <tr><td>总链接</td><td>${stats.totalLinks || 0}</td></tr>
          </table>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取文件索引状态</p>`;
    }
  }
});

// ===== Module: Agents =====
OC.register('agents', {
  currentTab: 'generate',
  
  init() {
    // Route handler
    OC.get('router').register('agents', () => {});
  },
  
  async runAgent(type) {
    const descEl = document.getElementById(`agent${this.capitalize(type)}Desc`) || 
                   document.getElementById(`agent${this.capitalize(type)}Code`);
    const pathEl = document.getElementById(`agent${this.capitalize(type)}Path`);
    
    const description = descEl ? descEl.value.trim() : '';
    const filePath = pathEl ? pathEl.value.trim() : '';
    
    if (!description) {
      OC.get('ui').showToast('请输入描述', 'warning');
      return;
    }
    
    const resultEl = document.getElementById('agentResult');
    resultEl.innerHTML = `
      <div class="card" style="background:var(--accent-glow);border-color:var(--accent)">
        <h3>⏳ 正在运行 ${this.getAgentLabel(type)}...</h3>
        <p class="text-muted">请稍候，Agent 正在处理您的请求</p>
      </div>
    `;
    
    try {
      const endpoint = `/agents/opencode/${type}`;
      const res = await OC.get('api').post(endpoint, { description, filePath });
      
      resultEl.innerHTML = `
        <div class="card">
          <h3>✅ ${this.getAgentLabel(type)} 完成</h3>
          <pre style="background:var(--bg-elevated);padding:16px;border-radius:8px;overflow:auto;max-height:400px"><code>${this.escapeHtml(res.code || res.result || res.output || '无输出')}</code></pre>
          ${res.filePath ? `<p class="text-muted mt-2">📁 文件: ${res.filePath}</p>` : ''}
        </div>
      `;
      
      OC.get('ui').showToast(`${this.getAgentLabel(type)} 完成`, 'success');
    } catch (err) {
      resultEl.innerHTML = `
        <div class="card" style="border-color:var(--danger)">
          <h3>❌ ${this.getAgentLabel(type)} 失败</h3>
          <p class="text-muted">${err.message}</p>
        </div>
      `;
      OC.get('ui').showToast('Agent 执行失败: ' + err.message, 'error');
    }
  },
  
  getAgentLabel(type) {
    const labels = {
      generate: '代码生成',
      refactor: '代码重构',
      review: '代码审查',
      test: '测试生成'
    };
    return labels[type] || type;
  },
  
  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  },
  
  escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
});

// ===== Module: Router Monitor =====
OC.register('router-monitor', {
  init() {
    OC.get('router').register('router', () => this.loadRouterData());
  },
  
  async loadRouterData() {
    await Promise.all([
      this.loadModelHealth(),
      this.loadTokenStats()
    ]);
  },
  
  async loadModelHealth() {
    const panel = document.getElementById('modelHealthPanel');
    try {
      const status = await OC.get('api').get('/agents/status');
      const models = status.models || [];
      
      panel.innerHTML = `
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr><th>模型</th><th>状态</th><th>延迟</th><th>成功率</th></tr>
            </thead>
            <tbody>
              ${models.map(m => `
                <tr>
                  <td>${m.name || m.id}</td>
                  <td><span class="badge ${m.healthy ? 'ok' : 'warn'}">${m.healthy ? '✅ 正常' : '⚠️ 异常'}</span></td>
                  <td>${m.latency ? m.latency + 'ms' : 'N/A'}</td>
                  <td>${m.successRate ? (m.successRate * 100).toFixed(0) + '%' : 'N/A'}</td>
                </tr>
              `).join('') || '<tr><td colspan="4" class="text-muted">暂无数据</td></tr>'}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取模型健康状态</p>`;
    }
  },
  
  async loadTokenStats() {
    const panel = document.getElementById('tokenStatsPanel');
    try {
      const usage = await OC.get('api').get('/memory/usage');
      panel.innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(2,1fr);gap:16px">
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--accent)">${usage.totalTokens || 0}</div>
            <div class="text-muted">总 Token</div>
          </div>
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--success)">${usage.conversations || 0}</div>
            <div class="text-muted">对话数</div>
          </div>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取 Token 统计</p>`;
    }
  }
});

// ===== Module: Vault =====
OC.register('vault', {
  init() {
    OC.get('router').register('vault', () => this.loadVaultData());
  },
  
  async loadVaultData() {
    await Promise.all([
      this.loadVaultStats(),
      this.loadVaultTags()
    ]);
  },
  
  async loadVaultStats() {
    const panel = document.getElementById('vaultStatsPanel');
    try {
      const stats = await OC.get('api').get('/vault/stats');
      panel.innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(2,1fr);gap:16px">
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--accent)">${stats.totalNotes || 0}</div>
            <div class="text-muted">笔记</div>
          </div>
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--purple)">${stats.totalTags || 0}</div>
            <div class="text-muted">标签</div>
          </div>
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--success)">${stats.totalLinks || 0}</div>
            <div class="text-muted">链接</div>
          </div>
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--warn)">${stats.paraCategories || 0}</div>
            <div class="text-muted">PARA 分类</div>
          </div>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取 Vault 统计</p>`;
    }
  },
  
  async loadVaultTags() {
    const panel = document.getElementById('vaultTagsPanel');
    try {
      const stats = await OC.get('api').get('/vault/stats');
      const tags = stats.tags || [];

      panel.innerHTML = '';
      panel.className = 'vault-tags-grid';
      if (tags.length === 0) {
        panel.innerHTML = '<span class="text-muted">暂无标签</span>';
        return;
      }

      this._vaultVl = VirtualList.create({
        container: panel,
        items: tags,
        pageSize: 40,
        renderItem: (t) => `<span class="badge" style="font-size:0.85rem;padding:4px 10px">${t}</span>`
      });
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取标签</p>`;
    }
  }
});

// ===== Module: Knowledge Graph =====
OC.register('kg', {
  init() {
    OC.get('router').register('kg', () => this.loadKgData());
  },
  
  async loadKgData() {
    await Promise.all([
      this.loadKgOverview(),
      this.loadKgEntities()
    ]);
  },
  
  async loadKgOverview() {
    const panel = document.getElementById('kgOverviewPanel');
    try {
      const stats = await OC.get('api').get('/kg/stats');
      panel.innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(2,1fr);gap:16px">
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--accent)">${stats.entities || 0}</div>
            <div class="text-muted">实体</div>
          </div>
          <div class="card" style="padding:16px">
            <div style="font-size:24px;font-weight:700;color:var(--purple)">${stats.relations || 0}</div>
            <div class="text-muted">关系</div>
          </div>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取 KG 概览</p>`;
    }
  },
  
  async loadKgEntities() {
    const panel = document.getElementById('kgEntitiesPanel');
    try {
      const data = await OC.get('api').get('/kg/entities');
      const entities = data.entities || [];

      panel.innerHTML = `
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr><th>实体</th><th>类型</th><th>出现次数</th></tr>
            </thead>
            <tbody id="kgEntitiesTbody"></tbody>
          </table>
        </div>
      `;

      const tbody = document.getElementById('kgEntitiesTbody');
      if (entities.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-muted">暂无实体</td></tr>';
        return;
      }

      this._kgVl = VirtualList.create({
        container: tbody,
        items: entities,
        pageSize: 25,
        renderItem: (e) => `
          <tr>
            <td>${e.name}</td>
            <td><span class="badge">${e.type}</span></td>
            <td>${e.count || 0}</td>
          </tr>
        `
      });
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取实体列表</p>`;
    }
  }
});

// ===== Module: Performance =====
OC.register('perf', {
  init() {
    OC.get('router').register('perf', () => this.loadPerfData());
  },
  
  async loadPerfData() {
    await Promise.all([
      this.loadRoutingPerf(),
      this.loadNativeStatus()
    ]);
  },
  
  async loadRoutingPerf() {
    const panel = document.getElementById('perfPanel');
    try {
      const status = await OC.get('api').get('/advisor/status');
      panel.innerHTML = `
        <div class="data-table-wrapper">
          <table class="data-table">
            <tr><td>Advisor 状态</td><td>${status.initialized ? '✅ 就绪' : '⚠️ 未就绪'}</td></tr>
            <tr><td>模型数</td><td>${status.modelCount || 0}</td></tr>
            <tr><td>上次评估</td><td>${status.lastEval ? new Date(status.lastEval).toLocaleString('zh-CN') : '从未'}</td></tr>
          </table>
        </div>
      `;
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">无法获取性能数据</p>`;
    }
  },
  
  async loadNativeStatus() {
    const panel = document.getElementById('nativeStatusPanel');
    try {
      const status = await OC.get('api').get('/health');
      const native = status.native || {};
      
      panel.innerHTML = `
        <div class="data-table-wrapper">
          <table class="data-table">
            <tr><td>Rust Core</td><td>${native.available ? '✅ 可用' : '❌ 不可用'}</td></tr>
            <tr><td>版本</td><td>${native.version || 'N/A'}</td></tr>
            <tr><td>平台</td><td>${native.platform || 'N/A'}</td></tr>
          </table>
        </div>
      `;
      
      // Update header indicator
      const indicator = document.getElementById('nativeIndicator');
      if (indicator) {
        if (native.available) {
          indicator.textContent = '🦀 Rust Core';
          indicator.style.color = 'var(--success)';
        } else {
          indicator.textContent = '📜 TS Core';
          indicator.style.color = 'var(--muted)';
        }
      }
    } catch (err) {
      panel.innerHTML = `<p class="text-muted">Native Core 未运行</p>`;
    }
  }
});

// ===== Module: Settings =====
OC.register('settings', {
  init() {
    document.getElementById('saveSettingsBtn').onclick = () => this.save();
    
    // Load saved settings
    const apiKey = localStorage.getItem('apiKey');
    if (apiKey) document.getElementById('settingApiKey').value = apiKey;
    
    // Theme buttons
    window.setTheme = (theme) => {
      if (theme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
      localStorage.setItem('theme', theme);
      // Highlight active theme button
      document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.themeVal === theme);
      });
      OC.get('ui').showToast('主题已切换', 'success');
    };
    // Set initial active state
    const currentTheme = localStorage.getItem('theme') || 'dark';
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeVal === currentTheme);
    });
  },
  
  async save() {
    const btn = document.getElementById('saveSettingsBtn');
    const originalText = btn.textContent;
    const apiKey = document.getElementById('settingApiKey').value.trim();

    // Loading state
    btn.textContent = '保存中…';
    btn.disabled = true;
    btn.classList.add('is-loading');

    try {
      if (apiKey) {
        localStorage.setItem('apiKey', apiKey);
      }
      // Simulate brief save delay for UX feedback
      await new Promise(r => setTimeout(r, 400));

      // Success state
      btn.textContent = '✓ 已保存';
      btn.classList.remove('is-loading');
      btn.classList.add('is-success');
      OC.get('ui').showToast('设置已保存', 'success');

      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('is-success');
        btn.disabled = false;
      }, 1500);
    } catch (err) {
      // Error state
      btn.textContent = '✗ 保存失败';
      btn.classList.remove('is-loading');
      btn.classList.add('is-error');
      OC.get('ui').showToast('保存失败: ' + err.message, 'error');

      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('is-error');
        btn.disabled = false;
      }, 2000);
    }
  }
});

// ===== Module: Navigation =====
OC.register('nav', {
  pages: [
    { id: 'home', icon: '🏠', label: 'Home', shortcut: '0' },
    { id: 'chat', icon: '💬', label: 'Chat', shortcut: '1' },
    { id: 'search', icon: '🔍', label: 'Search', shortcut: '2' },
    { id: 'code', icon: '💻', label: 'Code', shortcut: '3' },
    { id: 'agents', icon: '🤖', label: 'Agents', shortcut: '4' },
    { id: 'router', icon: '🧭', label: 'Router', shortcut: '5' },
    { id: 'vault', icon: '📁', label: 'Vault', shortcut: '6' },
    { id: 'kg', icon: '🕸️', label: 'KG', shortcut: '7' },
    { id: 'perf', icon: '📊', label: 'Perf', shortcut: '8' },
    { id: 'settings', icon: '⚙️', label: 'Settings', shortcut: '9' }
  ],
  
  init() {
    this.renderSidebar();
    this.renderBottomNav();
    this.setupKeyboardShortcuts();
  },
  
  renderSidebar() {
    const container = document.getElementById('navItems');
    container.innerHTML = this.pages.map(p => `
      <button class="nav-item" type="button" data-page="${p.id}" onclick="OC.get('router').navigate('${p.id}')">
        <span class="icon">${p.icon}</span>
        <span>${p.label}</span>
        <span class="shortcut">${p.shortcut}</span>
      </button>
    `).join('');
  },
  
  renderBottomNav() {
    const container = document.getElementById('bottomNav');
    const mobilePages = this.pages.slice(0, 5);
    container.innerHTML = mobilePages.map(p => `
      <button class="bottom-nav-item" data-page="${p.id}" onclick="OC.get('router').navigate('${p.id}')">
        <span class="icon">${p.icon}</span>
        <span>${p.label}</span>
      </button>
    `).join('');
  },
  
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Number keys 0-9 for page switching (0 = home)
      if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = parseInt(e.key);
        if (idx < this.pages.length) {
          OC.get('router').navigate(this.pages[idx].id);
        }
      }
      
      // Shift+T for theme
      if (e.key === 'T' && e.shiftKey) {
        const current = localStorage.getItem('theme') || 'dark';
        const newTheme = current === 'dark' ? 'light' : 'dark';
        if (typeof window.setTheme === 'function') window.setTheme(newTheme);
      }
      
      // Ctrl+K or / for search
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        OC.get('router').navigate('search');
        const input = document.getElementById('searchInput');
        input.focus();
        input.select();
      }
      
      // ? for help
      if (e.key === '?' && !e.ctrlKey) {
        OC.get('ui').openModal('kbdModal');
      }

      // Escape: close modal or blur focused element
      if (e.key === 'Escape') {
        const kbdModal = document.getElementById('kbdModal');
        if (kbdModal.classList.contains('show')) {
          OC.get('ui').closeModal('kbdModal');
        } else if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur();
        } else {
          OC.get('router').navigate('chat');
        }
      }
    });

    document.getElementById('kbdModalClose').onclick = () => {
      OC.get('ui').closeModal('kbdModal');
    };

    // Close modal on overlay click
    document.getElementById('kbdModal').onclick = (e) => {
      if (e.target === document.getElementById('kbdModal')) {
        OC.get('ui').closeModal('kbdModal');
      }
    };
  }
});

// ===== Module: Theme =====
OC.register('theme', {
  init() {
    const saved = localStorage.getItem('theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    } else {
      // Default to light theme
      document.documentElement.setAttribute('data-theme', 'light');
    }
    
    document.getElementById('themeBtn').onclick = () => {
      const current = localStorage.getItem('theme') || 'dark';
      const newTheme = current === 'dark' ? 'light' : 'dark';
      if (typeof window.setTheme === 'function') {
        window.setTheme(newTheme);
      } else {
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
      }
    };
  }
});

// ===== Module: UI Utilities =====
OC.register('ui', {
  showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
    toast.innerHTML = `
      <span class="toast-body">${icons[type] || 'ℹ️'} ${message}</span>
      <button class="toast-close" aria-label="关闭" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.style.animation = 'toastIn 0.3s ease forwards';
    });

    // Auto-dismiss with hover pause
    let timer = setTimeout(() => dismiss(), duration);
    toast.addEventListener('mouseenter', () => {
      clearTimeout(timer);
    });
    toast.addEventListener('mouseleave', () => {
      timer = setTimeout(() => dismiss(), 1500);
    });

    function dismiss() {
      if (!toast.parentElement) return;
      toast.style.animation = 'toastOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }
  },
  
  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    const header = document.getElementById('header');
    const main = document.getElementById('main');
    
    const isCollapsed = sidebar.classList.contains('collapsed');
    
    if (isCollapsed) {
      sidebar.classList.remove('collapsed');
      overlay.classList.remove('show');
      header.classList.remove('full');
      main.classList.remove('full');
    } else {
      sidebar.classList.add('collapsed');
      overlay.classList.add('show');
      header.classList.add('full');
      main.classList.add('full');
    }
  },

  openModal(modalId, options = {}) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const content = modal.querySelector('.modal');
    if (content) {
      content.setAttribute('role', 'dialog');
      content.setAttribute('aria-modal', 'true');
      if (options.title) content.setAttribute('aria-label', options.title);
    }
    modal.setAttribute('aria-hidden', 'false');
    this._activeModal = modalId;
    this._previouslyFocused = document.activeElement;
    modal.classList.add('show');

    // Focus trap
    const focusable = () => Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null);
    const first = focusable()[0];
    if (first) {
      setTimeout(() => first.focus(), 10);
    }

    this._focusTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const nodes = focusable();
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault();
        lastNode.focus();
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault();
        firstNode.focus();
      }
    };
    document.addEventListener('keydown', this._focusTrapHandler);
  },

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    if (this._focusTrapHandler) {
      document.removeEventListener('keydown', this._focusTrapHandler);
      this._focusTrapHandler = null;
    }
    if (this._previouslyFocused && this._activeModal === modalId) {
      this._previouslyFocused.focus();
      this._previouslyFocused = null;
    }
    this._activeModal = null;
  }
});

// ===== Utility: Virtual List (renders only visible items) =====
// Usage: VirtualList.create({ container, items, renderItem, pageSize: 50 })
const VirtualList = {
  create({ container, items = [], renderItem, pageSize = 50 }) {
    let rendered = 0;
    container.innerHTML = '';
    container.style.position = 'relative';

    function renderChunk() {
      const end = Math.min(rendered + pageSize, items.length);
      const fragment = document.createDocumentFragment();
      for (let i = rendered; i < end; i++) {
        const el = document.createElement('div');
        el.innerHTML = renderItem(items[i], i);
        fragment.appendChild(el.firstElementChild || el);
      }
      container.appendChild(fragment);
      rendered = end;

      // Add "load more" button if there are more items
      if (rendered < items.length) {
        let loadMoreBtn = container.querySelector('.vl-load-more');
        if (!loadMoreBtn) {
          loadMoreBtn = document.createElement('button');
          loadMoreBtn.className = 'vl-load-more';
          loadMoreBtn.textContent = `加载更多 (${items.length - rendered} 条)`;
          loadMoreBtn.style.cssText = '';
          loadMoreBtn.onclick = () => {
            renderChunk();
            loadMoreBtn.textContent = rendered < items.length
              ? `加载更多 (${items.length - rendered} 条)`
              : '已加载全部';
          };
          container.appendChild(loadMoreBtn);
        } else {
          loadMoreBtn.textContent = `加载更多 (${items.length - rendered} 条)`;
        }
      } else {
        const existing = container.querySelector('.vl-load-more');
        if (existing) existing.remove();
      }
    }

    renderChunk();
    return { refresh(newItems) { items = newItems; rendered = 0; renderChunk(); } };
  }
};

// ===== Global Functions for HTML onclick =====
window.initCodegraph = async () => {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ 初始化中...';
  
  try {
    await OC.get('api').post('/codegraph/init');
    OC.get('ui').showToast('CodeGraph 初始化成功', 'success');
    await OC.get('code').loadCodegraphStatus();
  } catch (err) {
    OC.get('ui').showToast('初始化失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 初始化索引';
  }
};

window.searchSymbols = async () => {
  const input = document.getElementById('symbolSearchInput');
  const query = input.value.trim();
  if (!query) return;
  
  const resultsEl = document.getElementById('symbolSearchResults');
  resultsEl.innerHTML = '<p class="text-muted">搜索中...</p>';
  
  try {
    const res = await OC.get('api').post('/codegraph/search', { query });
    const symbols = res.symbols || [];
    
    resultsEl.innerHTML = symbols.map(s => `
      <div class="result-card">
        <div class="result-title">${s.name} <span class="badge">${s.kind}</span></div>
        <div class="result-path">${s.file || ''}:${s.line || 0}</div>
      </div>
    `).join('') || '<p class="text-muted">未找到符号</p>';
  } catch (err) {
    resultsEl.innerHTML = `<p class="text-muted">搜索失败: ${err.message}</p>`;
  }
};

window.searchKgEntities = async () => {
  const input = document.getElementById('kgSearchInput');
  const query = input.value.trim();
  if (!query) return;
  
  const resultsEl = document.getElementById('kgSearchResults');
  resultsEl.innerHTML = '<p class="text-muted">搜索中...</p>';
  
  try {
    const res = await OC.get('api').get(`/kg/search?q=${encodeURIComponent(query)}`);
    const entities = res.entities || [];
    
    resultsEl.innerHTML = entities.map(e => `
      <div class="result-card">
        <div class="result-title">${e.name}</div>
        <div class="result-path">类型: ${e.type}</div>
      </div>
    `).join('') || '<p class="text-muted">未找到实体</p>';
  } catch (err) {
    resultsEl.innerHTML = `<p class="text-muted">搜索失败</p>`;
  }
};

window.switchAgentTab = (tab) => {
  // Update buttons
  document.querySelectorAll('[data-agent-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.agentTab === tab);
  });
  
  // Update panels
  document.querySelectorAll('.agent-tab-panel').forEach(panel => {
    panel.classList.add('hidden');
  });
  document.getElementById(`agent-${tab}`).classList.remove('hidden');
  
  OC.get('agents').currentTab = tab;
};

window.runAgent = (type) => {
  OC.get('agents').runAgent(type);
};

// ===== Module: Home / Dashboard =====
OC.register('home', {
  init() {
    OC.get('router').register('home', () => this.load());
  },

  async fetchWithFallback(path, fallback) {
    try {
      return await OC.get('api').get(path);
    } catch (err) {
      console.warn(`[Home] ${path} failed:`, err);
      return fallback;
    }
  },

  async load() {
    // Update boot time
    const bootEl = document.getElementById('homeBootTime');
    if (bootEl) bootEl.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // Update greeting
    const greetEl = document.getElementById('homeGreeting');
    if (greetEl) {
      const h = new Date().getHours();
      const greeting = h < 6 ? '夜猫子' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
      greetEl.textContent = greeting;
    }

    // Parallel API calls with safe fallbacks (API client already enforces 15s timeout)
    const [vault, agents, kg, plugins, memory] = await Promise.all([
      this.fetchWithFallback('/vault/stats', { totalNotes: 0 }),
      this.fetchWithFallback('/agents/status', { models: [] }),
      this.fetchWithFallback('/kg/stats', { entities: 0 }),
      this.fetchWithFallback('/plugins', { plugins: [], items: [] }),
      this.fetchWithFallback('/memory/usage', { conversations: 0 })
    ]);

    const totalNotes = vault && typeof vault.totalNotes === 'number' ? vault.totalNotes : 0;
    document.getElementById('homeStatNotes').textContent = totalNotes;

    const models = (agents && agents.models) || [];
    document.getElementById('homeStatModels').textContent = models.length || '3+';

    const entities = kg && typeof kg.entities === 'number' ? kg.entities : 0;
    document.getElementById('homeStatEntities').textContent = entities;

    const pluginList = (plugins && (plugins.plugins || plugins.items)) || [];
    document.getElementById('homeStatPlugins').textContent = pluginList.length || '0';

    const conversations = memory && typeof memory.conversations === 'number' ? memory.conversations : 0;
    document.getElementById('homeTodayCount').textContent = conversations;
  }
});

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
  OC.init();

  // Setup sidebar toggle
  document.getElementById('menuBtn').onclick = () => OC.get('ui').toggleSidebar();
  document.getElementById('overlay').onclick = () => OC.get('ui').toggleSidebar();

  // Handle URL hash
  const hash = window.location.hash.slice(1);
  if (hash && document.getElementById(`page-${hash}`)) {
    OC.get('router').navigate(hash);
  } else {
    OC.get('router').navigate('home');
  }
  
  // Auto-refresh data on certain pages
  setInterval(() => {
    const current = OC.get('router').current;
    if (current === 'router') {
      OC.get('router-monitor').loadRouterData();
    } else if (current === 'perf') {
      OC.get('perf').loadPerfData();
    }
  }, 30000); // Every 30 seconds
  
  console.log('[OC] v3.0 initialized with component library');
});

// Expose OC globally for debugging
window.OC = OC;
