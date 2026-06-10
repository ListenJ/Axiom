/**
 * OpenClaw Frontend Architecture v3.0
 * 
 * Based on existing index.html + app.js, reorganized into modular structure.
 * Key principle: Keep existing UI/UX, reorganize code into maintainable modules.
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
  
  register(path, handler) {
    this.routes[path] = handler;
  },
  
  navigate(path) {
    if (this.current === path) return;
    
    // Hide current page
    if (this.current) {
      const el = document.getElementById(`page-${this.current}`);
      if (el) el.classList.add('hidden');
    }
    
    // Show new page
    const newEl = document.getElementById(`page-${path}`);
    if (newEl) {
      newEl.classList.remove('hidden');
      newEl.style.animation = 'none';
      newEl.offsetHeight; // Trigger reflow
      newEl.style.animation = '';
    }
    
    this.current = path;
    
    // Update UI
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navEl = document.querySelector(`[data-page="${path}"]`);
    if (navEl) navEl.classList.add('active');
    
    // Update title
    const titles = {
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
  }
});

// ===== Core: API Client =====
OC.register('api', {
  baseURL: '',
  
  async request(method, path, data = null) {
    const url = this.baseURL + path;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    
    const apiKey = localStorage.getItem('apiKey');
    if (apiKey) options.headers['x-api-key'] = apiKey;
    
    if (data) options.body = JSON.stringify(data);
    
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
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
    this.ws = new WebSocket(WS_URL);
    
    this.ws.onopen = () => {
      OC.get('events').emit('ws:connected');
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
      setTimeout(() => this.setupWebSocket(), 5000);
    };
  },
  
  send() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || this.isTyping) return;
    
    this.addMessage('user', text);
    input.value = '';
    
    // Send to API
    OC.get('api').post('/chat', { message: text })
      .then(res => this.addMessage('assistant', res.reply))
      .catch(err => this.addMessage('system', 'Error: ' + err.message));
  },
  
  addMessage(role, content) {
    const log = document.getElementById('chatLog');
    const msg = document.createElement('div');
    msg.className = `msg ${role}`;
    msg.innerHTML = `<div class="msg-bubble">${this.formatMessage(content)}</div>`;
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    
    this.history.push({ role, content, time: Date.now() });
  },
  
  formatMessage(text) {
    // Basic markdown
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
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
  
  handleMessage(data) {
    if (data.type === 'chat') {
      this.addMessage('assistant', data.content);
    }
  }
});

// ===== Module: Navigation =====
OC.register('nav', {
  pages: [
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
      <div class="nav-item" data-page="${p.id}" onclick="OC.get('router').navigate('${p.id}')">
        <span class="icon">${p.icon}</span>
        <span>${p.label}</span>
        <span class="shortcut">${p.shortcut}</span>
      </div>
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
      // Number keys 1-9 for page switching
      if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = parseInt(e.key) - 1;
        if (idx < this.pages.length) {
          OC.get('router').navigate(this.pages[idx].id);
        }
      }
      
      // Shift+T for theme
      if (e.key === 'T' && e.shiftKey) {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
      }
      
      // Escape to chat
      if (e.key === 'Escape') {
        OC.get('router').navigate('chat');
      }
      
      // ? for help
      if (e.key === '?' && !e.ctrlKey) {
        document.getElementById('kbdModal').classList.add('show');
      }
    });
    
    document.getElementById('kbdModalClose').onclick = () => {
      document.getElementById('kbdModal').classList.remove('show');
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
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
    
    document.getElementById('themeBtn').onclick = () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const newTheme = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
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
    toast.innerHTML = `${icons[type] || 'ℹ️'} ${message}`;
    container.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
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
    
    try {
      const results = await OC.get('api').post('/vault/search', { query, filter });
      this.renderResults(results);
    } catch (err) {
      OC.get('ui').showToast('Search failed: ' + err.message, 'error');
    }
  },
  
  renderResults(results) {
    const container = document.getElementById('searchResults');
    if (!results || results.length === 0) {
      container.innerHTML = '<p class="text-muted">No results found</p>';
      return;
    }
    
    container.innerHTML = results.map(r => `
      <div class="card" style="margin-bottom:12px">
        <h3>${r.title}</h3>
        <p class="text-secondary">${r.excerpt}</p>
        <div class="flex gap-2 mt-2">
          ${r.tags.map(t => `<span class="badge">${t}</span>`).join('')}
        </div>
      </div>
    `).join('');
  }
});

// ===== Module: Settings =====
OC.register('settings', {
  init() {
    document.getElementById('saveSettingsBtn').onclick = () => this.save();
    
    // Load saved settings
    const apiKey = localStorage.getItem('apiKey');
    if (apiKey) document.getElementById('settingApiKey').value = apiKey;
  },
  
  save() {
    const apiKey = document.getElementById('settingApiKey').value.trim();
    if (apiKey) {
      localStorage.setItem('apiKey', apiKey);
      OC.get('ui').showToast('Settings saved', 'success');
    }
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
    OC.get('router').navigate('chat');
  }
  
  console.log('[OC] v3.0 initialized');
});

// Expose OC globally for debugging
window.OC = OC;
